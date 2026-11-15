import { prisma } from "@/lib/prisma";
import { reportRouteError } from "@/lib/error-handler";
import type { LocalFileStorage } from "@/lib/file-storage/local-file-storage";
import { isStorageError } from "@/lib/file-storage/types";
import {
  assemblyFileDisposition,
  chunkFileDisposition,
  finalFileDisposition,
  partFileDisposition,
  recordingDirectoryRemovable,
  type Disposition,
  type RecordingFacts,
} from "@/lib/recorded-lectures/cleanup-rules";
import type { RecordedLectureConfig } from "@/lib/recorded-lectures/config";
import {
  isRecordedLectureId,
  parseRecordedLectureKey,
  recordingDirectoryKey,
  recordingFileKey,
  TEACHERS_DIRECTORY,
  TEMPORARY_UPLOADS_DIRECTORY,
  type RecordedLectureKeyKind,
} from "@/lib/recorded-lectures/keys";
import { openRecordedLectureStorage } from "@/lib/recorded-lectures/storage";
import { COMPLETION_CLAIM_STALE_MS, RECORDED_LECTURE_TRANSACTION_OPTIONS, setUploadLockTimeout } from "@/lib/recorded-lectures/upload-locks";
import { serverNow } from "@/lib/server-clock";
import { completionJobsRunning, recoverStaleCompletion, type RecoveryOutcome } from "@/services/recorded-lecture-completion-service";
import { expireStaleUploads, loadConfig, noCurrentLease } from "@/services/recorded-lecture-upload-service";

/*
 * Recorded Lectures RL-3.5: maintenance (cleanup, expiry, recovery).
 *
 * Phases, each bounded and independently safe; a failing phase is logged and
 * the next run retries it:
 *   1. expiry    ACTIVE uploads past their expiry WITHOUT a current chunk lease
 *                become EXPIRED (one with a current lease waits for it to end:
 *                its writer may still be writing within its reservation);
 *   2. recovery  stale COMPLETING uploads (no heartbeat for 10 minutes) are taken
 *                over by a new claim here (recoverStaleCompletion), with an
 *                in-memory backoff per upload;
 *   3. temporary files below System/TemporaryUploads (chunk, assembly, legacy .part);
 *   4. final files below Teachers/.../RecordedLectures/{recordingId}/ (orphans);
 *   5. purge     (Stage 3.6) PERMANENT deletion of recordings a teacher
 *                deleted (status 2): the stored final file is removed, then
 *                the row becomes status 1 with purgedAt set (see
 *                purgeRemovedRecording).
 *
 * Deletion safety: a file is deleted only after (a) its name parses as one of
 * the recorded-lecture key kinds (unknown names, symlinks and other entries are
 * never touched; listDirectory never follows links), (b) the database was read
 * for it (session FIRST, then committed chunk rows, then recordings), (c)
 * cleanup-rules.ts decided DELETE, which needs the grace period AND a one-way
 * condition, so a concurrent state change cannot make the deletion unsafe. A
 * database error aborts the phase before anything of that batch is deleted.
 * Only paths below the storage root's feature folders are ever listed.
 *
 * Bounded: a time budget per run, entry / batch / deletion limits per phase,
 * one filesystem operation at a time, database queries by ids in batches.
 *
 * Nothing here starts on its own: the scheduler
 * (services/recorded-lecture-maintenance-scheduler.ts) runs it, started by
 * instrumentation.ts on a long-running production server (Stage 3.6).
 */

export type MaintenanceLimits = {
  /** Wall-clock budget of one run (all phases). */
  runBudgetMs: number;
  expiryBatch: number;
  /** New completion claims taken by one run. */
  recoveriesPerRun: number;
  /** Recovery only while fewer completion jobs than this run here (requests have the rest). */
  recoveryMaxRunningJobs: number;
  tempMaxEntries: number;
  /** Distinct uploads per database batch. */
  tempBatchUploads: number;
  tempMaxDeletes: number;
  finalMaxRecordingDirs: number;
  finalMaxDeletes: number;
  /** Deleted recordings purged by one run. */
  purgeBatch: number;
};

export const DEFAULT_MAINTENANCE_LIMITS: MaintenanceLimits = Object.freeze({
  runBudgetMs: 20_000,
  expiryBatch: 100,
  recoveriesPerRun: 1,
  recoveryMaxRunningJobs: 2,
  tempMaxEntries: 50_000,
  tempBatchUploads: 200,
  tempMaxDeletes: 200,
  finalMaxRecordingDirs: 500,
  finalMaxDeletes: 200,
  purgeBatch: 50,
});

export type SweepCounts = { examined: number; deleted: number; kept: number; unknown: number; skippedLinks: number; errors: number };
const emptyCounts = (): SweepCounts => ({ examined: 0, deleted: 0, kept: 0, unknown: 0, skippedLinks: 0, errors: 0 });

export type MaintenanceReport = {
  skipped: null | "not-configured";
  expired: number;
  recovery: { examined: number; outcomes: Partial<Record<RecoveryOutcome | "backoff", number>> };
  temporary: SweepCounts | null;
  finals: (SweepCounts & { directoriesRemoved: number; missingReadyFiles: number; complete: boolean }) | null;
  purge: PurgeCounts | null;
  failedPhases: string[];
  timedOut: boolean;
};

// ---- Process state (single process: globalThis) ------------------------------------------------------------

type Backoff = { attempts: number; nextAtMs: number };
const state = globalThis as unknown as {
  slRecordedLectureRecoveryBackoff?: Map<string, Backoff>;
  slRecordedLectureFinalSweepCursor?: string | null;
  slRecordedLecturePurge?: { cursor: string | null; backoff: Map<string, Backoff> };
};
function purgeState() {
  if (!state.slRecordedLecturePurge) state.slRecordedLecturePurge = { cursor: null, backoff: new Map() };
  return state.slRecordedLecturePurge;
}
function backoffs(): Map<string, Backoff> {
  if (!state.slRecordedLectureRecoveryBackoff) state.slRecordedLectureRecoveryBackoff = new Map();
  return state.slRecordedLectureRecoveryBackoff;
}

/** Recovery backoff after the n-th attempt: 1, 2, 4 ... minutes, at most 60. */
export function recoveryBackoffMs(attempts: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** Tests only. */
export function resetMaintenanceStateForTests() {
  state.slRecordedLectureRecoveryBackoff = new Map();
  state.slRecordedLectureFinalSweepCursor = null;
  state.slRecordedLecturePurge = { cursor: null, backoff: new Map() };
}

function reportMaintenanceError(error: unknown, phase: string) {
  try {
    reportRouteError(error, {
      request: new Request(`http://internal/recorded-lectures/maintenance/${phase}`, { method: "POST" }),
      label: `Recorded lecture maintenance (${phase})`,
    });
  } catch {
    // Logging must never break maintenance.
  }
}

// ---- 1. Expiry ---------------------------------------------------------------------------------------------

/** ACTIVE uploads past their expiry and without a current lease become EXPIRED (conditional, one by one). */
export async function expireAbandonedUploads(now: Date, limit: number): Promise<number> {
  const rows = await prisma.recordingUploadSession.findMany({
    where: { state: "ACTIVE", expiresAt: { lte: now }, ...noCurrentLease(now) },
    orderBy: { expiresAt: "asc" },
    take: limit,
    select: { id: true, teacherId: true },
  });
  let expired = 0;
  for (const row of rows) {
    expired += await prisma.$transaction(async (tx) => {
      await setUploadLockTimeout(tx);
      return expireStaleUploads(tx, { teacherId: row.teacherId, uploadId: row.id }, now);
    }, RECORDED_LECTURE_TRANSACTION_OPTIONS);
  }
  return expired;
}

// ---- 2. Recovery -------------------------------------------------------------------------------------------

export async function recoverStaleCompletions(now: Date, limits: MaintenanceLimits): Promise<MaintenanceReport["recovery"]> {
  const report: MaintenanceReport["recovery"] = { examined: 0, outcomes: {} };
  const count = (key: RecoveryOutcome | "backoff") => (report.outcomes[key] = (report.outcomes[key] ?? 0) + 1);
  const nowMs = now.getTime();

  // Forget backoffs that can no longer matter.
  for (const [id, entry] of backoffs()) if (entry.nextAtMs + 2 * 3_600_000 < nowMs) backoffs().delete(id);

  const rows = await prisma.recordingUploadSession.findMany({
    where: { state: "COMPLETING", lastActivityAt: { lte: new Date(nowMs - COMPLETION_CLAIM_STALE_MS) } },
    orderBy: { lastActivityAt: "asc" },
    take: 20,
    select: { id: true },
  });
  let started = 0;
  for (const row of rows) {
    if (started >= limits.recoveriesPerRun || completionJobsRunning() >= limits.recoveryMaxRunningJobs) break;
    report.examined++;
    const entry = backoffs().get(row.id);
    if (entry && entry.nextAtMs > nowMs) {
      count("backoff");
      continue;
    }
    const outcome = await recoverStaleCompletion(row.id);
    count(outcome);
    if (outcome === "recovered") {
      started++;
      const attempts = (entry?.attempts ?? 0) + 1;
      backoffs().set(row.id, { attempts, nextAtMs: nowMs + recoveryBackoffMs(attempts) });
    } else if (outcome === "failed-ineligible" || outcome === "not-stale") {
      backoffs().delete(row.id);
    }
  }
  return report;
}

// ---- 3. Temporary files ------------------------------------------------------------------------------------

type TempCandidate = { key: string; parsed: Extract<RecordedLectureKeyKind, { kind: "scratch" | "assembly" | "temp" }> };

async function deleteIfAllowed(storage: LocalFileStorage, key: string, decide: (modifiedAtMs: number) => Disposition, counts: SweepCounts): Promise<boolean> {
  let info;
  try {
    info = await storage.stat(key);
  } catch (error) {
    if (isStorageError(error, "UNSAFE_PATH")) counts.skippedLinks++;
    else counts.errors++;
    return false;
  }
  if (!info) return false;
  const decision = decide(info.modifiedAtMs);
  if (decision.action !== "DELETE") {
    counts.kept++;
    return false;
  }
  try {
    if (await storage.remove(key)) {
      counts.deleted++;
      return true;
    }
  } catch {
    counts.errors++; // retried by the next run
  }
  return false;
}

async function processTempBatch(
  storage: LocalFileStorage,
  batch: TempCandidate[],
  now: Date,
  graceMs: number,
  counts: SweepCounts,
  stop: () => boolean
) {
  const uploadIds = [...new Set(batch.map((c) => c.parsed.uploadId))];
  // 1. Sessions (lease state) FIRST ...
  const sessions = await prisma.recordingUploadSession.findMany({
    where: { id: { in: uploadIds } },
    select: { id: true, state: true, leaseToken: true, leaseExpiresAt: true, endedAt: true, recordedLectureId: true },
  });
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  // 2. ... then committed chunk rows (see cleanup-rules.ts: chunkFileDisposition) ...
  const tokens = batch.flatMap((c) => (c.parsed.kind === "scratch" ? [c.parsed.leaseToken] : []));
  const committedRows = tokens.length
    ? await prisma.recordingUploadChunk.findMany({ where: { leaseToken: { in: tokens } }, select: { leaseToken: true, uploadSessionId: true } })
    : [];
  const committed = new Set(committedRows.map((r) => `${r.uploadSessionId}.${r.leaseToken}`));
  // 3. ... then the recordings of assembly files (the current claim's name).
  const recordingIds = [
    ...new Set(batch.flatMap((c) => (c.parsed.kind === "assembly" ? [sessionById.get(c.parsed.uploadId)?.recordedLectureId ?? null] : [])).filter((id): id is string => id !== null)),
  ];
  const recordings = recordingIds.length
    ? await prisma.recordedLecture.findMany({ where: { id: { in: recordingIds } }, select: { id: true, storedFileName: true } })
    : [];
  const storedNameByRecording = new Map(recordings.map((r) => [r.id, r.storedFileName]));

  const nowMs = now.getTime();
  for (const candidate of batch) {
    if (stop()) return;
    const session = sessionById.get(candidate.parsed.uploadId) ?? null;
    const facts = session
      ? {
          state: session.state,
          leaseToken: session.leaseToken,
          leaseExpiresAtMs: session.leaseExpiresAt ? session.leaseExpiresAt.getTime() : null,
          endedAtMs: session.endedAt ? session.endedAt.getTime() : null,
        }
      : null;
    const { parsed } = candidate;
    await deleteIfAllowed(storage, candidate.key, (modifiedAtMs) => {
      if (parsed.kind === "scratch") {
        return chunkFileDisposition({
          token: parsed.leaseToken,
          fileModifiedAtMs: modifiedAtMs,
          session: facts,
          committed: committed.has(`${parsed.uploadId}.${parsed.leaseToken}`),
          nowMs,
          graceMs,
        });
      }
      if (parsed.kind === "assembly") {
        return assemblyFileDisposition({
          claimFileName: parsed.claimFileName,
          fileModifiedAtMs: modifiedAtMs,
          sessionState: session?.state ?? null,
          recordingStoredFileName: session ? storedNameByRecording.get(session.recordedLectureId) ?? null : null,
          nowMs,
          graceMs,
        });
      }
      return partFileDisposition({ fileModifiedAtMs: modifiedAtMs, sessionState: session?.state ?? null, nowMs, graceMs });
    }, counts);
  }
}

export async function sweepTemporaryFiles(
  storage: LocalFileStorage,
  now: Date,
  config: Pick<RecordedLectureConfig, "scratchGraceMinutes">,
  limits: MaintenanceLimits,
  deadlineMs: number
): Promise<SweepCounts> {
  const counts = emptyCounts();
  const graceMs = config.scratchGraceMinutes * 60_000;
  const stop = () => Date.now() >= deadlineMs || counts.deleted >= limits.tempMaxDeletes;
  let batch: TempCandidate[] = [];
  let batchUploads = new Set<string>();

  for await (const entry of storage.listDirectory(TEMPORARY_UPLOADS_DIRECTORY, { limit: limits.tempMaxEntries })) {
    if (stop()) break;
    counts.examined++;
    if (entry.kind === "other") {
      counts.skippedLinks++;
      continue;
    }
    const key = `${TEMPORARY_UPLOADS_DIRECTORY}/${entry.name}`;
    const parsed = entry.kind === "file" ? parseRecordedLectureKey(key) : null;
    if (!parsed || (parsed.kind !== "scratch" && parsed.kind !== "assembly" && parsed.kind !== "temp")) {
      counts.unknown++;
      continue;
    }
    batch.push({ key, parsed });
    batchUploads.add(parsed.uploadId);
    if (batchUploads.size >= limits.tempBatchUploads) {
      await processTempBatch(storage, batch, now, graceMs, counts, stop);
      batch = [];
      batchUploads = new Set();
    }
  }
  if (batch.length > 0 && !stop()) await processTempBatch(storage, batch, now, graceMs, counts, stop);
  return counts;
}

// ---- 4. Final files ------------------------------------------------------------------------------------------

async function sortedDirectories(storage: LocalFileStorage, key: string, counts: SweepCounts): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of storage.listDirectory(key, { limit: 100_000 })) {
    if (entry.kind === "directory" && isRecordedLectureId(entry.name)) names.push(entry.name);
    else if (entry.kind === "other") counts.skippedLinks++;
    else counts.unknown++;
  }
  return names.sort();
}

/**
 * Orphan final files, recording folder by recording folder in sorted order,
 * resuming after the previous run's position (kept in memory; a restart starts
 * over). Empty folders of removed or FAILED recordings are removed.
 */
export async function sweepRecordingFiles(
  storage: LocalFileStorage,
  now: Date,
  config: Pick<RecordedLectureConfig, "orphanGraceHours">,
  limits: MaintenanceLimits,
  deadlineMs: number
): Promise<NonNullable<MaintenanceReport["finals"]>> {
  const counts = { ...emptyCounts(), directoriesRemoved: 0, missingReadyFiles: 0, complete: false };
  const orphanGraceMs = config.orphanGraceHours * 3_600_000;
  const cursor = state.slRecordedLectureFinalSweepCursor ?? null;
  let processedDirs = 0;
  const stop = () => Date.now() >= deadlineMs || counts.deleted >= limits.finalMaxDeletes || processedDirs >= limits.finalMaxRecordingDirs;

  for (const teacherId of await sortedDirectories(storage, TEACHERS_DIRECTORY, counts)) {
    const lecturesKey = `${TEACHERS_DIRECTORY}/${teacherId}/Lectures`;
    for (const lectureId of await sortedDirectories(storage, lecturesKey, counts)) {
      const recordingsKey = `${lecturesKey}/${lectureId}/RecordedLectures`;
      for (const recordingId of await sortedDirectories(storage, recordingsKey, counts)) {
        const position = `${teacherId}/${lectureId}/${recordingId}`;
        if (cursor !== null && position <= cursor) continue;
        if (stop()) return counts;
        processedDirs++;
        state.slRecordedLectureFinalSweepCursor = position;
        await sweepRecordingDirectory(storage, { teacherId, lectureId, recordingId }, now.getTime(), orphanGraceMs, counts);
      }
    }
  }
  state.slRecordedLectureFinalSweepCursor = null;
  counts.complete = true;
  return counts;
}

async function sweepRecordingDirectory(
  storage: LocalFileStorage,
  ids: { teacherId: string; lectureId: string; recordingId: string },
  nowMs: number,
  orphanGraceMs: number,
  counts: NonNullable<MaintenanceReport["finals"]>
) {
  const dirKey = recordingDirectoryKey(ids);
  // The database first: a file is referenced only by its own recording at exactly this path.
  const row = await prisma.recordedLecture.findFirst({
    where: { id: ids.recordingId },
    select: { state: true, storedFileName: true, teacherId: true, lectureId: true, status: true },
  });
  // Stage 3.6: a PURGED recording (status 1) references no file any more: whatever is left in its
  // folder is an orphan (deleted after the grace) and the folder is removable. A recording pending
  // purge (status 2) still references its file (the purge phase deletes it, never this sweep).
  const owned = row !== null && row.teacherId === ids.teacherId && row.lectureId === ids.lectureId;
  const recording: RecordingFacts | null = owned && row.status !== 1 ? { state: row.state, storedFileName: row.storedFileName } : null;

  let sawReadyFile = false;
  for await (const entry of storage.listDirectory(dirKey, { limit: 1_000 })) {
    counts.examined++;
    if (entry.kind === "other") {
      counts.skippedLinks++;
      continue;
    }
    const key = `${dirKey}/${entry.name}`;
    const parsed = entry.kind === "file" ? parseRecordedLectureKey(key) : null;
    if (!parsed || parsed.kind !== "recording") {
      counts.unknown++;
      continue;
    }
    if (recording && recording.state === "READY" && recording.storedFileName === parsed.storedName) sawReadyFile = true;
    await deleteIfAllowed(
      storage,
      key,
      (modifiedAtMs) => finalFileDisposition({ storedName: parsed.storedName, fileModifiedAtMs: modifiedAtMs, recording, nowMs, orphanGraceMs }),
      counts
    );
  }
  if (recording && recording.state === "READY" && !sawReadyFile && row?.status === 0) {
    // Data loss: never "fixed" here, only reported. (A recording pending purge may already have
    // lost its file to the purge, which then finalizes it: not data loss.)
    counts.missingReadyFiles++;
    reportMaintenanceError(new Error("A READY recording's file is missing."), "finals");
  }
  if (recordingDirectoryRemovable(recording)) {
    try {
      if (await storage.removeEmptyDirectory(dirKey)) counts.directoriesRemoved++;
    } catch {
      counts.errors++;
    }
  }
}

// ---- 5. Purge of deleted recordings (Stage 3.6) ----------------------------------------------------------------

export type PurgeOutcome = "purged" | "pending" | "protected" | "unverifiable" | "not-pending";
export type PurgeCounts = { examined: number; backoff: number } & Record<PurgeOutcome, number>;

/**
 * PERMANENT deletion of ONE recording a teacher deleted (status 2, purgedAt
 * NULL). Recoverable and idempotent:
 *   - protected (nothing done, retried later): the recording is VERIFYING,
 *     or an upload session of it is ACTIVE / COMPLETING;
 *   - the stored final file, at the key built from the row's OWN teacher,
 *     lecture, id and storedFileName (a name that does not validate is never
 *     touched: "unverifiable", left pending and logged), is removed; already
 *     missing counts as removed; any other failure leaves it pending
 *     (status 2, still counted in the teacher's usage) for the next run;
 *   - only then: status 1, purgedAt set, purgeRequestedAt cleared (the
 *     table's CHECKs), conditional on the row being unchanged; the empty
 *     recording folder is removed best-effort (never a non-empty one).
 * Never throws.
 */
export async function purgeRemovedRecording(storage: LocalFileStorage, recordingId: string): Promise<PurgeOutcome> {
  try {
    const row = await prisma.recordedLecture.findFirst({
      where: { id: recordingId, status: 2, purgedAt: null },
      select: { id: true, teacherId: true, lectureId: true, storedFileName: true, state: true },
    });
    if (!row) return "not-pending";
    if (row.state === "VERIFYING") return "protected";
    const busy = await prisma.recordingUploadSession.findFirst({
      where: { recordedLectureId: row.id, state: { in: ["ACTIVE", "COMPLETING"] } },
      select: { id: true },
    });
    if (busy) return "protected";

    const ids = { teacherId: row.teacherId, lectureId: row.lectureId, recordingId: row.id };
    if (row.storedFileName !== null) {
      let key: string;
      try {
        key = recordingFileKey({ ...ids, storedName: row.storedFileName });
      } catch (error) {
        reportMaintenanceError(error, "purge");
        return "unverifiable";
      }
      try {
        await storage.remove(key); // false = already missing: counts as removed
      } catch (error) {
        reportMaintenanceError(error, "purge");
        return "pending";
      }
    }

    const now = await serverNow();
    const done = await prisma.recordedLecture.updateMany({
      where: { id: row.id, status: 2, purgedAt: null, storedFileName: row.storedFileName },
      data: { status: 1, purgedAt: now, purgeRequestedAt: null, updatedAt: now },
    });
    try {
      await storage.removeEmptyDirectory(recordingDirectoryKey(ids));
    } catch {
      // Best effort: a folder that is not empty (or not removable) stays; the orphan sweep handles files.
    }
    return done.count === 1 ? "purged" : "not-pending";
  } catch (error) {
    reportMaintenanceError(error, "purge");
    return "pending";
  }
}

/**
 * Phase 5: pending purges in id order, each pass continuing after the previous
 * one (wrapping at the end), so recordings that keep failing can never starve
 * the others; a "pending" (failed) or "unverifiable" one is skipped for
 * 1, 2, 4 ... 60 minutes (logged once per attempt, not every run). Process
 * memory only: a restart starts over, which is safe (every step idempotent).
 */
export async function purgeRemovedRecordings(storage: LocalFileStorage, limits: MaintenanceLimits, deadlineMs: number): Promise<PurgeCounts> {
  const counts: PurgeCounts = { examined: 0, backoff: 0, purged: 0, pending: 0, protected: 0, unverifiable: 0, "not-pending": 0 };
  const memory = purgeState();
  const nowMs = Date.now();
  for (const [id, entry] of memory.backoff) if (entry.nextAtMs + 2 * 3_600_000 < nowMs) memory.backoff.delete(id);
  const cursor = memory.cursor;
  const rows = await prisma.recordedLecture.findMany({
    where: { status: 2, purgedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: "asc" },
    take: limits.purgeBatch,
    select: { id: true },
  });
  memory.cursor = rows.length < limits.purgeBatch ? null : rows[rows.length - 1].id;
  let lastDone = cursor;
  for (const { id } of rows) {
    if (Date.now() >= deadlineMs) {
      memory.cursor = lastDone;
      break;
    }
    lastDone = id;
    const entry = memory.backoff.get(id);
    if (entry && entry.nextAtMs > Date.now()) {
      counts.backoff++;
      continue;
    }
    counts.examined++;
    const outcome = await purgeRemovedRecording(storage, id);
    counts[outcome]++;
    if (outcome === "pending" || outcome === "unverifiable") {
      const attempts = (entry?.attempts ?? 0) + 1;
      memory.backoff.set(id, { attempts, nextAtMs: Date.now() + recoveryBackoffMs(attempts) });
    } else {
      memory.backoff.delete(id);
    }
  }
  return counts;
}

// ---- One run ----------------------------------------------------------------------------------------------------

export type MaintenancePhases = { expire?: boolean; recover?: boolean; temporary?: boolean; finals?: boolean; purge?: boolean };

/** One maintenance run (the scheduler decides which phases). Never throws. */
export async function runRecordedLectureMaintenance(
  options: { phases?: MaintenancePhases; limits?: Partial<MaintenanceLimits> } = {}
): Promise<MaintenanceReport> {
  const phases = { expire: true, recover: true, temporary: true, finals: true, purge: true, ...options.phases };
  const limits: MaintenanceLimits = { ...DEFAULT_MAINTENANCE_LIMITS, ...options.limits };
  const report: MaintenanceReport = {
    skipped: null,
    expired: 0,
    recovery: { examined: 0, outcomes: {} },
    temporary: null,
    finals: null,
    purge: null,
    failedPhases: [],
    timedOut: false,
  };
  const deadlineMs = Date.now() + limits.runBudgetMs;

  let config: RecordedLectureConfig;
  let storage: LocalFileStorage;
  try {
    config = loadConfig();
    const opened = await openRecordedLectureStorage(process.env);
    if (!opened.ok) {
      report.skipped = "not-configured";
      return report;
    }
    storage = opened.storage;
  } catch {
    report.skipped = "not-configured";
    return report;
  }

  const run = async (name: string, fn: (now: Date) => Promise<void>) => {
    if (Date.now() >= deadlineMs) {
      report.timedOut = true;
      return;
    }
    try {
      await fn(await serverNow());
    } catch (error) {
      report.failedPhases.push(name);
      reportMaintenanceError(error, name);
    }
  };

  if (phases.expire) await run("expire", async (now) => void (report.expired = await expireAbandonedUploads(now, limits.expiryBatch)));
  if (phases.recover) await run("recover", async (now) => void (report.recovery = await recoverStaleCompletions(now, limits)));
  if (phases.temporary) await run("temporary", async (now) => void (report.temporary = await sweepTemporaryFiles(storage, now, config, limits, deadlineMs)));
  if (phases.finals) await run("finals", async (now) => void (report.finals = await sweepRecordingFiles(storage, now, config, limits, deadlineMs)));
  if (phases.purge) await run("purge", async () => void (report.purge = await purgeRemovedRecordings(storage, limits, deadlineMs)));
  if (Date.now() >= deadlineMs) report.timedOut = true;
  return report;
}
