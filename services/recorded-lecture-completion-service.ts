import { prisma } from "@/lib/prisma";
import { reportRouteError } from "@/lib/error-handler";
import { isStorageError } from "@/lib/file-storage/types";
import { byteCountToNumber } from "@/lib/recorded-lectures/bigint";
import {
  AssemblyFault,
  assembledChunkSource,
  planChunks,
  verifyAssembledFile,
  type FaultHolder,
  type PlannedChunk,
} from "@/lib/recorded-lectures/chunk-assembly";
import { computeReservations, decideCapacity, retryAfterSecondsForLease } from "@/lib/recorded-lectures/chunk-lease";
import type { RecordedLectureConfig } from "@/lib/recorded-lectures/config";
import {
  assemblyKey,
  chunkScratchKey,
  generateRecordingFileName,
  isRecordedLectureId,
  recordingDirectoryKey,
  recordingFileKey,
  TEMPORARY_UPLOADS_DIRECTORY,
} from "@/lib/recorded-lectures/keys";
import { inspectStoredMp4 } from "@/lib/recorded-lectures/mp4-inspect-node";
import { openRecordedLectureStorage } from "@/lib/recorded-lectures/storage";
import { buildUploadStatusDto, type UploadStatusDto } from "@/lib/recorded-lectures/upload-dto";
import { isDefiniteRollback, uploadBusyConflict, uploadError } from "@/lib/recorded-lectures/upload-errors";
import {
  COMPLETION_CLAIM_STALE_MS,
  COMPLETION_HEARTBEAT_MS,
  getUploadMutex,
  isCompletionClaimStale,
  isUploadMutexTimeoutError,
  lockUploadCapacity,
  MAX_CONCURRENT_COMPLETION_JOBS,
  RECORDED_LECTURE_TRANSACTION_OPTIONS,
  setUploadLockTimeout,
  uploadMutexKey,
} from "@/lib/recorded-lectures/upload-locks";
import { serverNow, serverNowSync } from "@/lib/server-clock";
import type { LocalFileStorage } from "@/lib/file-storage/local-file-storage";
import {
  assertLectureActiveForUpload,
  assertTeacherCanUpload,
  expireStaleUploads,
  loadConfig,
  reservationRows,
  type Tx,
} from "@/services/recorded-lecture-upload-service";

/*
 * Recorded Lectures RL-3.4: completing and cancelling an upload.
 *
 * COMPLETION (POST .../uploads/[uploadId]/complete): asynchronous.
 *   The request CLAIMS the upload in one transaction (C1) and answers 202;
 *   a background job in this process then verifies, assembles, inspects,
 *   promotes and marks READY. Clients poll GET .../uploads/[uploadId].
 *
 *   Claim identity (no schema change): the session's version after the claim
 *   (claimVersion) + a fresh random file name (claimName, stored in the
 *   recording's storedFileName) + the session's lastActivityAt as heartbeat.
 *   - C1: ACTIVE -> COMPLETING (version + 1, lease cleared, heartbeat now) and
 *     UPLOADING -> VERIFYING (storedFileName = claimName), under the capacity
 *     lock, then the capacity aggregate including the assembly reservation
 *     (expectedBytes) of this now-COMPLETING session; 507 rolls it back.
 *   - A COMPLETING claim whose heartbeat is older than 10 minutes is stale:
 *     the next complete request takes it over (version + 1, a new claimName).
 *   - Every file a claim writes is claim-specific: the assembly
 *     System/TemporaryUploads/{uploadId}.{claimHex}.assembly and the final
 *     .../RecordedLectures/{recordingId}/{claimName}.
 *   - EVERY transition of a claim (heartbeat, READY, FAILED, abandon) is
 *     conditional on session version = claimVersion (and, for the recording,
 *     storedFileName = claimName). A stale job therefore can never mark a
 *     newer claim READY or FAILED, and never overwrites or deletes a newer
 *     claim's files (it only ever removes its own claim-named files).
 *
 *   Job: chunk records planned and checked -> each chunk file's exact size ->
 *   assembly (chunk SHA-256 recomputed while copying, bounded memory, file and
 *   directory flushed) -> D5 second pass over the assembled file (exact
 *   ranges and size) -> MP4 inspection (duration 1..172,800 s) -> heartbeat
 *   confirmed -> promote (never overwrites) + directories flushed -> C2:
 *   COMPLETING -> COMPLETED and VERIFYING -> READY, conditional on the claim
 *   -> chunk files deleted best-effort (a cleanup failure never affects READY).
 *   The heartbeat is refreshed every 30 s throughout (between pieces of every
 *   long read, plus a timer); a failed conditional heartbeat stops the job.
 *
 *   Failures: permanent (the upload is bad: chunk records / files / hashes,
 *   MP4, duration, teacher or lecture no longer allowed) -> FAILED (claim
 *   conditional); temporary (disk full, I/O, database) -> the claim is kept
 *   but its heartbeat set stale, so the next complete request retries at
 *   once; claim lost -> the job stops. An unknown READY outcome keeps every
 *   file. Background errors are always caught and logged (never an unhandled
 *   rejection). A restarted process recovers a stale claim through another
 *   complete request; RL-3.5 will add automatic recovery (no sweeper yet).
 *
 * CANCELLATION (DELETE .../uploads/[uploadId]): database only; files are left
 *   for RL-3.5 cleanup.
 *   - ACTIVE: under the upload mutex (as chunk requests); if it cannot be
 *     acquired within 2 s -> 409 UPLOAD_BUSY and nothing changes. Then, from
 *     the DATABASE lease (a writer may run in another process): a current
 *     chunk lease -> 409 CHUNK_IN_PROGRESS with Retry-After until the lease
 *     expires, nothing changed (its capacity reservation stays). Otherwise
 *     ACTIVE -> CANCELLED, conditional on the version and on no current lease
 *     (an expired lease's writer is past its write deadline: leaseHeld), and
 *     UPLOADING -> FAILED (UPLOAD_CANCELLED). An expired upload is expired.
 *   - COMPLETING: only with a stale heartbeat (conditional on version and the
 *     claim's file name; no mutex: completion files are claim-specific);
 *     otherwise 409 UPLOAD_COMPLETING.
 *   - COMPLETED: 409 UPLOAD_ALREADY_COMPLETED. Already final: 200 (no change).
 */

type CompletionClaim = {
  uploadId: string;
  teacherId: string;
  recordingId: string;
  lectureId: string;
  claimVersion: number;
  claimName: string;
  expectedBytes: number;
  chunkCount: number;
};

const ENDED_STATES = new Set(["CANCELLED", "FAILED", "EXPIRED"]);

/** How long a request waits for the in-process upload mutex. */
export const COMPLETION_MUTEX_WAIT_MS = 2_000;

class ClaimLostError extends Error {
  constructor() {
    super("The completion claim is no longer current.");
    this.name = "ClaimLostError";
  }
}

/** The upload is bad: FAILED with this code. */
class PermanentFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Completion failed: ${code}.`);
    this.name = "PermanentFailure";
    this.code = code;
  }
}

/** The READY transition's outcome could not be established: keep every file. */
class OutcomeUnknownError extends Error {
  constructor() {
    super("The READY transition's outcome is unknown.");
    this.name = "OutcomeUnknownError";
  }
}

function claimWhere(claim: CompletionClaim) {
  return { id: claim.uploadId, teacherId: claim.teacherId, state: "COMPLETING" as const, version: claim.claimVersion };
}

function claimRecordingWhere(claim: CompletionClaim) {
  return { id: claim.recordingId, teacherId: claim.teacherId, state: "VERIFYING" as const, storedFileName: claim.claimName };
}

// ---- Shutdown (RL-3.5) --------------------------------------------------------------------------------

/** This process is shutting down: heartbeats stop and running jobs stop at their next check. */
class ShutdownError extends Error {
  constructor() {
    super("The process is shutting down.");
    this.name = "ShutdownError";
  }
}

const shutdownState = globalThis as unknown as {
  slRecordedLectureCompletionShutdown?: boolean;
  slRecordedLectureRunningClaims?: Map<string, CompletionClaim>;
};

function isShuttingDown(): boolean {
  return shutdownState.slRecordedLectureCompletionShutdown === true;
}

function runningClaims(): Map<string, CompletionClaim> {
  if (!shutdownState.slRecordedLectureRunningClaims) shutdownState.slRecordedLectureRunningClaims = new Map();
  return shutdownState.slRecordedLectureRunningClaims;
}

/**
 * Graceful shutdown (SIGTERM): no new completion starts here, running jobs
 * stop beating and stop at their next check (removing only their own files),
 * and every claim running in this process is made stale at once (conditional
 * on that claim, so it never affects a newer one). The next process (or
 * another one) can then recover them immediately instead of after 10 minutes;
 * if this process still runs a moment longer, everything it does stays fenced.
 * Returns the number of claims abandoned. Never throws.
 */
export async function abandonRunningCompletions(): Promise<number> {
  shutdownState.slRecordedLectureCompletionShutdown = true;
  const claims = [...runningClaims().values()];
  for (const claim of claims) await abandonClaim(claim);
  return claims.length;
}

/** Tests only: leave the shutdown state. */
export function resetCompletionShutdownForTests() {
  shutdownState.slRecordedLectureCompletionShutdown = false;
}

// ---- Heartbeat --------------------------------------------------------------------------------------

/** The claim's heartbeat: lastActivityAt refreshed every 30 s, only while the claim is still current. */
class Heartbeat {
  private lastBeatMs = 0;
  private lost = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly claim: CompletionClaim) {}

  start(nowMs: number) {
    this.lastBeatMs = nowMs;
    this.timer = setInterval(() => {
      // A timer beat that fails for a database reason changes nothing here: the
      // next check() beats again; a lost claim is detected by the conditional update.
      // During shutdown nothing beats (the claim is being abandoned).
      if (isShuttingDown()) return;
      this.beat().catch(() => undefined);
    }, COMPLETION_HEARTBEAT_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Conditional on the claim; a changed version means the claim is lost. */
  async beat(): Promise<void> {
    const now = await serverNow();
    const updated = await prisma.recordingUploadSession.updateMany({
      where: claimWhere(this.claim),
      data: { lastActivityAt: now },
    });
    if (updated.count !== 1) this.lost = true;
    else this.lastBeatMs = now.getTime();
  }

  /** Throws when the claim is lost; beats when 30 s passed (database errors propagate: temporary). */
  async check(): Promise<void> {
    if (this.lost) throw new ClaimLostError();
    if (isShuttingDown()) throw new ShutdownError();
    if (serverNowSync().getTime() - this.lastBeatMs >= COMPLETION_HEARTBEAT_MS) await this.beat();
    if (this.lost) throw new ClaimLostError();
  }

  /** A fresh, successful beat right now (before publishing). */
  async confirm(): Promise<void> {
    if (isShuttingDown()) throw new ShutdownError();
    await this.beat();
    if (this.lost) throw new ClaimLostError();
  }
}

// ---- Background jobs -----------------------------------------------------------------------------------

const jobState = globalThis as unknown as { slRecordedLectureCompletionJobs?: Set<Promise<void>> };
function jobs(): Set<Promise<void>> {
  if (!jobState.slRecordedLectureCompletionJobs) jobState.slRecordedLectureCompletionJobs = new Set();
  return jobState.slRecordedLectureCompletionJobs;
}

/** Completion jobs running in this process. */
export function completionJobsRunning(): number {
  return jobs().size;
}

/** Resolves when every completion job running in this process has finished (tests, shutdown). */
export async function waitForCompletionJobs(): Promise<void> {
  while (jobs().size > 0) await Promise.all([...jobs()]);
}

function reportJobError(error: unknown) {
  try {
    reportRouteError(error, {
      request: new Request("http://internal/recorded-lectures/completion-job", { method: "POST" }),
      label: "Recorded lecture completion job",
    });
  } catch {
    // Logging must never break the job's own error handling.
  }
}

/** Starts the job; the mutex is released when it ends. The returned promise never rejects. */
function startCompletionJob(claim: CompletionClaim, storage: LocalFileStorage, config: RecordedLectureConfig, release: () => void) {
  runningClaims().set(claim.uploadId, claim);
  const job: Promise<void> = (async () => {
    try {
      await runCompletionJob(claim, storage, config);
    } catch (error) {
      reportJobError(error);
    } finally {
      if (runningClaims().get(claim.uploadId) === claim) runningClaims().delete(claim.uploadId);
      release();
    }
  })();
  jobs().add(job);
  void job.then(() => jobs().delete(job));
}

async function runCompletionJob(claim: CompletionClaim, storage: LocalFileStorage, config: RecordedLectureConfig): Promise<void> {
  const heartbeat = new Heartbeat(claim);
  const assembly = assemblyKey(claim.uploadId, claim.claimName);
  const recordingDir = recordingDirectoryKey({ teacherId: claim.teacherId, lectureId: claim.lectureId, recordingId: claim.recordingId });
  const finalKey = recordingFileKey({ teacherId: claim.teacherId, lectureId: claim.lectureId, recordingId: claim.recordingId, storedName: claim.claimName });
  let chunks: PlannedChunk[] = [];

  heartbeat.start((await serverNow()).getTime());
  try {
    // 1. The committed chunk records describe the whole file exactly.
    const rows = await prisma.recordingUploadChunk.findMany({
      where: { uploadSessionId: claim.uploadId },
      orderBy: { chunkIndex: "asc" },
    });
    const plan = planChunks(rows, { expectedBytes: claim.expectedBytes, chunkCount: claim.chunkCount });
    if (!plan.ok) throw new PermanentFailure(plan.problem);
    chunks = plan.chunks;

    // 2. Every chunk file exists with exactly its recorded size.
    for (const chunk of chunks) {
      await heartbeat.check();
      const info = await storage.stat(chunkScratchKey(claim.uploadId, chunk.token));
      if (!info) throw new PermanentFailure("CHUNK_MISSING");
      if (info.size !== chunk.length) throw new PermanentFailure("CHUNK_SIZE_MISMATCH");
    }

    // 3. Assembly into this claim's own file (chunk hashes recomputed on the way).
    await heartbeat.check();
    const holder: FaultHolder = { fault: null };
    try {
      await storage.writeNewFile(
        assembly,
        assembledChunkSource(storage, claim.uploadId, chunks, holder, () => heartbeat.check()),
        { maxBytes: claim.expectedBytes, exactBytes: claim.expectedBytes, sync: true, syncDirectory: true }
      );
    } catch (error) {
      // The storage reports a failing source as IO_ERROR; the source recorded the real cause.
      if (holder.fault instanceof AssemblyFault) throw new PermanentFailure(holder.fault.code);
      if (holder.fault) throw holder.fault;
      throw error;
    }

    // 4. D5 second pass over the assembled file: exact size and every recorded range.
    await heartbeat.check();
    const verified = await verifyAssembledFile(storage, assembly, chunks, claim.expectedBytes, () => heartbeat.check());
    if (verified) throw new PermanentFailure(verified);

    // 5. MP4 inspection of the exact file to publish.
    await heartbeat.check();
    const inspected = await inspectStoredMp4(storage, assembly, config);
    if (!inspected.ok) throw new PermanentFailure(`MP4_${inspected.code}`);
    const info = inspected.info;
    const duration = info.durationSeconds;
    if (duration === null || !Number.isSafeInteger(duration) || duration < 1 || duration > 172_800) {
      throw new PermanentFailure("DURATION_INVALID");
    }
    for (const dimension of [info.width, info.height]) {
      if (dimension !== null && (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 65_535)) {
        throw new PermanentFailure("DIMENSIONS_INVALID");
      }
    }

    // 6. Publish under this claim's own name (never overwrites), then flush both directories.
    await heartbeat.confirm();
    await storage.ensureDirectory(recordingDir);
    await storage.promote(assembly, finalKey);
    await storage.syncDirectory(TEMPORARY_UPLOADS_DIRECTORY);
    await storage.syncDirectory(recordingDir);

    // 7. READY, conditional on the claim.
    await markReady(claim, info);
  } catch (error) {
    heartbeat.stop();
    await handleJobFailure(error, claim, storage, { assembly, finalKey });
    return;
  } finally {
    heartbeat.stop();
  }

  // 8. READY: the chunk files are no longer needed. Best effort; never affects READY.
  for (const chunk of chunks) {
    await storage.remove(chunkScratchKey(claim.uploadId, chunk.token)).catch(() => undefined);
  }
}

/** Removes only this claim's own (claim-named) files. Never throws. */
async function removeClaimFiles(storage: LocalFileStorage, keys: { assembly: string; finalKey: string }) {
  await storage.remove(keys.assembly).catch(() => undefined);
  await storage.remove(keys.finalKey).catch(() => undefined);
}

async function handleJobFailure(
  error: unknown,
  claim: CompletionClaim,
  storage: LocalFileStorage,
  keys: { assembly: string; finalKey: string }
): Promise<void> {
  if (error instanceof OutcomeUnknownError) {
    // READY may or may not have been recorded with this claim's file: touch nothing.
    reportJobError(error);
    return;
  }
  if (error instanceof ClaimLostError) {
    await removeClaimFiles(storage, keys);
    return;
  }
  if (error instanceof PermanentFailure) {
    try {
      await failClaim(claim, error.code);
      await removeClaimFiles(storage, keys);
      return;
    } catch (failError) {
      if (failError instanceof ClaimLostError) {
        await removeClaimFiles(storage, keys);
        return;
      }
      // FAILED could not be recorded (database): keep the claim for a retry (it fails again).
      error = failError;
    }
  }
  // Temporary: keep the claim, make it stale so the next complete request retries at once.
  await removeClaimFiles(storage, keys);
  await abandonClaim(claim);
  const expected = error instanceof ShutdownError || (error instanceof Error && error.name === "StorageError" && isStorageError(error, "NO_SPACE"));
  if (!expected) reportJobError(error);
}

/** COMPLETING -> FAILED and VERIFYING -> FAILED, conditional on the claim. */
async function failClaim(claim: CompletionClaim, code: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await setUploadLockTimeout(tx);
    const now = await serverNow();
    const session = await tx.recordingUploadSession.updateMany({
      where: claimWhere(claim),
      data: { state: "FAILED", failureCode: code, endedAt: now, updatedAt: now, version: { increment: 1 } },
    });
    if (session.count !== 1) throw new ClaimLostError();
    const recording = await tx.recordedLecture.updateMany({
      where: claimRecordingWhere(claim),
      data: { state: "FAILED", failureCode: code, failedAt: now, updatedAt: now },
    });
    if (recording.count !== 1) throw new ClaimLostError();
  }, RECORDED_LECTURE_TRANSACTION_OPTIONS);
}

/** Keeps the claim but makes its heartbeat stale (conditional), so a retry can take it over at once. Never throws. */
async function abandonClaim(claim: CompletionClaim): Promise<void> {
  try {
    const now = await serverNow();
    await prisma.recordingUploadSession.updateMany({
      where: claimWhere(claim),
      data: { lastActivityAt: new Date(now.getTime() - COMPLETION_CLAIM_STALE_MS) },
    });
  } catch {
    // The heartbeat simply stops; the claim goes stale within 10 minutes.
  }
}

type ClaimOutcome = "ready" | "claimed" | "lost" | "unknown";

async function readClaimOutcome(claim: CompletionClaim): Promise<ClaimOutcome> {
  try {
    const recording = await prisma.recordedLecture.findFirst({ where: { id: claim.recordingId, teacherId: claim.teacherId } });
    if (recording && recording.state === "READY" && recording.storedFileName === claim.claimName) return "ready";
    const session = await prisma.recordingUploadSession.findFirst({ where: { id: claim.uploadId, teacherId: claim.teacherId } });
    if (
      session &&
      session.state === "COMPLETING" &&
      session.version === claim.claimVersion &&
      recording &&
      recording.state === "VERIFYING" &&
      recording.storedFileName === claim.claimName
    ) {
      return "claimed";
    }
    return "lost";
  } catch {
    return "unknown";
  }
}

type Mp4Metadata = {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string;
  audioCodec: string;
  fragmented: boolean;
};

/** C2: COMPLETING -> COMPLETED and VERIFYING -> READY, conditional on the claim; ambiguity resolved by re-reading. */
async function markReady(claim: CompletionClaim, info: Mp4Metadata): Promise<void> {
  const attempt = () =>
    prisma.$transaction(async (tx) => {
      await setUploadLockTimeout(tx);
      const now = await serverNow();
      try {
        await assertTeacherCanUpload(tx, claim.teacherId);
        await assertLectureActiveForUpload(tx, claim.lectureId, claim.teacherId);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string" && (code === "TEACHER_ACCOUNT_INACTIVE" || code === "LECTURE_NOT_ACTIVE")) throw new PermanentFailure(code);
        throw error;
      }
      const session = await tx.recordingUploadSession.updateMany({
        where: claimWhere(claim),
        data: { state: "COMPLETED", endedAt: now, lastActivityAt: now, updatedAt: now, version: { increment: 1 } },
      });
      if (session.count !== 1) throw new ClaimLostError();
      const recording = await tx.recordedLecture.updateMany({
        where: { ...claimRecordingWhere(claim), status: 0 },
        data: {
          state: "READY",
          readyAt: now,
          updatedAt: now,
          durationSeconds: info.durationSeconds,
          width: info.width,
          height: info.height,
          videoCodec: info.videoCodec,
          audioCodec: info.audioCodec,
          fragmented: info.fragmented,
        },
      });
      if (recording.count !== 1) throw new ClaimLostError();
    }, RECORDED_LECTURE_TRANSACTION_OPTIONS);

  const isOwnRefusal = (error: unknown) => error instanceof PermanentFailure || error instanceof ClaimLostError;
  try {
    await attempt();
    return;
  } catch (error) {
    if (isOwnRefusal(error) || isDefiniteRollback(error)) throw error;
  }

  // The commit's outcome is unknown: establish it before doing anything else.
  const outcome = await readClaimOutcome(claim);
  if (outcome === "ready") return;
  if (outcome === "lost") throw new ClaimLostError();
  if (outcome === "unknown") throw new OutcomeUnknownError();

  // Still claimed and not READY: the transaction did not commit; one retry.
  try {
    await attempt();
    return;
  } catch (error) {
    if (isOwnRefusal(error) || isDefiniteRollback(error)) throw error;
  }
  const second = await readClaimOutcome(claim);
  if (second === "ready") return;
  if (second === "lost") throw new ClaimLostError();
  throw new OutcomeUnknownError();
}

// ---- Complete (the request) ------------------------------------------------------------------------------

type ClaimOutcomeOfRequest =
  | { kind: "expired" }
  | { kind: "in-progress"; dto: UploadStatusDto }
  | { kind: "claimed"; claim: CompletionClaim; dto: UploadStatusDto };

type SessionRow = NonNullable<Awaited<ReturnType<Tx["recordingUploadSession"]["findFirst"]>>>;
type RecordingRow = NonNullable<Awaited<ReturnType<Tx["recordedLecture"]["findFirst"]>>>;

function claimedDto(session: SessionRow, recording: RecordingRow, now: Date, config: RecordedLectureConfig) {
  return buildUploadStatusDto(
    {
      ...session,
      state: "COMPLETING",
      lastActivityAt: now,
      leaseToken: null,
      leaseBytes: null,
      leaseExpiresAt: null,
    },
    { ...recording, state: "VERIFYING" },
    config,
    now.getTime()
  );
}

/**
 * Takes a STALE claim over (conditional: same version, heartbeat still stale,
 * the old claim's file name): a new version and the new claim's file name.
 * Throws (rolling the transaction back) when another worker got there first.
 */
async function takeOverStaleClaim(tx: Tx, session: SessionRow, recording: RecordingRow, claimName: string, now: Date): Promise<void> {
  const taken = await tx.recordingUploadSession.updateMany({
    where: {
      id: session.id,
      teacherId: session.teacherId,
      state: "COMPLETING",
      version: session.version,
      lastActivityAt: { lte: new Date(now.getTime() - COMPLETION_CLAIM_STALE_MS) },
    },
    data: { lastActivityAt: now, updatedAt: now, version: { increment: 1 } },
  });
  const renamed = await tx.recordedLecture.updateMany({
    where: { id: recording.id, teacherId: session.teacherId, state: "VERIFYING", status: 0, storedFileName: recording.storedFileName },
    data: { storedFileName: claimName, updatedAt: now },
  });
  if (taken.count !== 1 || renamed.count !== 1) throw uploadBusyConflict();
}

/**
 * A STALE claim whose teacher or lecture is no longer allowed is FAILED
 * (conditional on that stale claim, exactly as a takeover), never resumed.
 */
async function failStaleClaim(tx: Tx, session: SessionRow, recording: RecordingRow, code: string, now: Date): Promise<void> {
  const failed = await tx.recordingUploadSession.updateMany({
    where: {
      id: session.id,
      teacherId: session.teacherId,
      state: "COMPLETING",
      version: session.version,
      lastActivityAt: { lte: new Date(now.getTime() - COMPLETION_CLAIM_STALE_MS) },
    },
    data: { state: "FAILED", failureCode: code, endedAt: now, updatedAt: now, version: { increment: 1 } },
  });
  const failedRecording = await tx.recordedLecture.updateMany({
    where: { id: recording.id, teacherId: session.teacherId, state: "VERIFYING", storedFileName: recording.storedFileName },
    data: { state: "FAILED", failureCode: code, failedAt: now, updatedAt: now },
  });
  if (failed.count !== 1 || failedRecording.count !== 1) throw uploadBusyConflict();
}

async function claimTransaction(
  tx: Tx,
  input: { teacherId: string; uploadId: string; claimName: string; storage: LocalFileStorage; config: RecordedLectureConfig },
  onClaimVersion: (claim: CompletionClaim) => void
): Promise<ClaimOutcomeOfRequest> {
  const { teacherId, uploadId, claimName, config } = input;
  await setUploadLockTimeout(tx);
  const now = await serverNow();

  const session = await tx.recordingUploadSession.findFirst({ where: { id: uploadId, teacherId } });
  if (!session) throw uploadError("UPLOAD_NOT_FOUND");
  const recording = await tx.recordedLecture.findFirst({ where: { id: session.recordedLectureId, teacherId } });
  if (!recording) throw uploadError("UPLOAD_NOT_FOUND");

  if (session.state === "COMPLETED") throw uploadError("UPLOAD_ALREADY_COMPLETED");
  if (session.state === "EXPIRED") throw uploadError("UPLOAD_EXPIRED");
  if (ENDED_STATES.has(session.state)) throw uploadError("UPLOAD_NOT_ACTIVE");

  await assertTeacherCanUpload(tx, teacherId);
  await assertLectureActiveForUpload(tx, recording.lectureId, teacherId);

  const base = {
    uploadId,
    teacherId,
    recordingId: recording.id,
    lectureId: recording.lectureId,
    claimVersion: session.version + 1,
    claimName,
    expectedBytes: byteCountToNumber(session.expectedBytes, "expectedBytes"),
    chunkCount: session.chunkCount,
  };

  if (session.state === "COMPLETING") {
    if (!isCompletionClaimStale(session.lastActivityAt, now.getTime())) {
      return { kind: "in-progress", dto: buildUploadStatusDto(session, recording, config, now.getTime()) };
    }
    // Take the stale claim over: a new version and a new claim file name.
    onClaimVersion(base);
    await takeOverStaleClaim(tx, session, recording, claimName, now);
    return { kind: "claimed", claim: base, dto: claimedDto(session, recording, now, config) };
  }

  // ACTIVE
  if (session.expiresAt.getTime() <= now.getTime()) {
    await expireStaleUploads(tx, { teacherId, uploadId }, now);
    return { kind: "expired" };
  }
  if (recording.state !== "UPLOADING" || recording.status !== 0) throw uploadError("UPLOAD_NOT_ACTIVE");
  const receivedBytes = byteCountToNumber(session.receivedBytes, "receivedBytes");
  if (receivedBytes !== base.expectedBytes) throw uploadError("UPLOAD_INCOMPLETE", { receivedBytes });
  if (session.leaseToken !== null && session.leaseExpiresAt !== null && session.leaseExpiresAt.getTime() > now.getTime()) {
    throw uploadError("CHUNK_IN_PROGRESS", { retryAfterSeconds: retryAfterSecondsForLease(session.leaseExpiresAt.getTime(), now.getTime()) });
  }

  await lockUploadCapacity(tx);
  onClaimVersion(base);
  const claimed = await tx.recordingUploadSession.updateMany({
    where: { id: uploadId, teacherId, state: "ACTIVE", version: session.version, receivedBytes: session.expectedBytes, expiresAt: { gt: now } },
    data: {
      state: "COMPLETING",
      leaseToken: null,
      leaseOffset: null,
      leaseBytes: null,
      leaseGrantedAt: null,
      leaseExpiresAt: null,
      lastActivityAt: now,
      updatedAt: now,
      version: { increment: 1 },
    },
  });
  const verifying = await tx.recordedLecture.updateMany({
    where: { id: recording.id, teacherId, state: "UPLOADING", status: 0 },
    data: { state: "VERIFYING", storedFileName: claimName, updatedAt: now },
  });
  if (claimed.count !== 1 || verifying.count !== 1) throw uploadBusyConflict();

  // The claim is stored: the aggregate includes its assembly reservation (expectedBytes).
  const reservations = computeReservations(await reservationRows(tx, now), now.getTime());
  const decision = decideCapacity({ freeBytes: await input.storage.freeBytes(), reservations }, config);
  if (!decision.ok) {
    throw decision.reason === "INSUFFICIENT_STORAGE"
      ? uploadError("INSUFFICIENT_STORAGE")
      : uploadError("INFLIGHT_CHUNK_CAP", { retryAfterSeconds: Math.min(config.chunkLeaseSeconds, 30) });
  }
  return { kind: "claimed", claim: base, dto: claimedDto(session, recording, now, config) };
}

/** The status of a COMPLETING upload (null otherwise), for a request that found the upload busy. */
async function statusIfCompleting(teacherId: string, uploadId: string, config: RecordedLectureConfig): Promise<UploadStatusDto | null> {
  const session = await prisma.recordingUploadSession.findFirst({ where: { id: uploadId, teacherId } });
  if (!session || session.state !== "COMPLETING") return null;
  const recording = await prisma.recordedLecture.findFirst({ where: { id: session.recordedLectureId, teacherId } });
  if (!recording) return null;
  return buildUploadStatusDto(session, recording, config, (await serverNow()).getTime());
}

/**
 * POST /api/recorded-lectures/uploads/[uploadId]/complete. Returns the status
 * (always COMPLETING on success: 202); the work continues in the background.
 */
export async function completeRecordingUpload(input: { teacherId: string; uploadId: string }): Promise<UploadStatusDto> {
  const { teacherId, uploadId } = input;
  if (!isRecordedLectureId(uploadId)) throw uploadError("UPLOAD_NOT_FOUND");
  const config = loadConfig();
  const opened = await openRecordedLectureStorage(process.env);
  if (!opened.ok) throw uploadError("RECORDED_LECTURES_NOT_CONFIGURED");
  const { storage } = opened;

  let release: () => void;
  try {
    release = await getUploadMutex().acquire(uploadMutexKey(uploadId), { timeoutMs: COMPLETION_MUTEX_WAIT_MS });
  } catch (error) {
    if (!isUploadMutexTimeoutError(error)) throw error;
    // Busy in this process: a completion already running here answers with its status.
    const running = await statusIfCompleting(teacherId, uploadId, config);
    if (running) return running;
    throw uploadBusyConflict();
  }

  let handedOff = false;
  try {
    // RL-3.5: a bounded number of completion jobs per process, none while shutting down.
    if (isShuttingDown() || jobs().size >= MAX_CONCURRENT_COMPLETION_JOBS) throw uploadError("UPLOAD_BUSY", { retryAfterSeconds: 30 });
    const claimName = generateRecordingFileName();
    let attempted: CompletionClaim | null = null;
    let outcome: ClaimOutcomeOfRequest;
    try {
      outcome = await prisma.$transaction(
        (tx) => claimTransaction(tx, { teacherId, uploadId, claimName, storage, config }, (claim) => (attempted = claim)),
        RECORDED_LECTURE_TRANSACTION_OPTIONS
      );
    } catch (error) {
      const claim = attempted as CompletionClaim | null;
      if (isDefiniteRollback(error) || claim === null) throw error;
      // Ambiguous: was the claim stored?
      if ((await readClaimOutcome(claim)) !== "claimed") throw uploadError("UPLOAD_BUSY", { retryAfterSeconds: 1 });
      const running = await statusIfCompleting(teacherId, uploadId, config);
      if (!running) throw uploadError("UPLOAD_BUSY", { retryAfterSeconds: 1 });
      outcome = { kind: "claimed", claim, dto: running };
    }

    if (outcome.kind === "expired") throw uploadError("UPLOAD_EXPIRED");
    if (outcome.kind === "in-progress") return outcome.dto;

    handedOff = true;
    startCompletionJob(outcome.claim, storage, config, release);
    return outcome.dto;
  } finally {
    if (!handedOff) release();
  }
}

// ---- Automatic recovery (RL-3.5) ------------------------------------------------------------------------

export type RecoveryOutcome = "recovered" | "failed-ineligible" | "not-stale" | "busy" | "lost-race";

/**
 * Recovers one STALE completion without a teacher request (the maintenance
 * worker; the teacher is the session's). Exactly the request's takeover:
 * conditional on the stale claim (version, heartbeat, file name), so of two
 * workers (two processes, or a worker and a request) only one wins; the new
 * claim has a fresh identity and assembly path, its job beats every 30 s, and
 * the old claim stays fenced. A claim whose teacher account or lecture is no
 * longer allowed is FAILED instead (TEACHER_ACCOUNT_INACTIVE /
 * LECTURE_NOT_ACTIVE), under the same conditions.
 *   recovered          a new claim was taken and its job started here;
 *   failed-ineligible  marked FAILED;
 *   not-stale          nothing to do (no longer COMPLETING, or fresh);
 *   busy               not now (job limit, shutdown, storage, or the upload is busy here);
 *   lost-race          another worker changed it first.
 */
export async function recoverStaleCompletion(uploadId: string): Promise<RecoveryOutcome> {
  if (!isRecordedLectureId(uploadId)) return "not-stale";
  if (isShuttingDown() || jobs().size >= MAX_CONCURRENT_COMPLETION_JOBS) return "busy";
  const config = loadConfig();
  const opened = await openRecordedLectureStorage(process.env);
  if (!opened.ok) return "busy";
  const { storage } = opened;

  let release: () => void;
  try {
    release = await getUploadMutex().acquire(uploadMutexKey(uploadId), { timeoutMs: 0 });
  } catch (error) {
    if (isUploadMutexTimeoutError(error)) return "busy";
    throw error;
  }

  let handedOff = false;
  try {
    const claimName = generateRecordingFileName();
    type Outcome = { kind: "not-stale" } | { kind: "failed-ineligible" } | { kind: "claimed"; claim: CompletionClaim };
    let outcome: Outcome;
    try {
      outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
        await setUploadLockTimeout(tx);
        const now = await serverNow();
        const session = await tx.recordingUploadSession.findFirst({ where: { id: uploadId } });
        if (!session || session.state !== "COMPLETING" || !isCompletionClaimStale(session.lastActivityAt, now.getTime())) {
          return { kind: "not-stale" };
        }
        const recording = await tx.recordedLecture.findFirst({ where: { id: session.recordedLectureId, teacherId: session.teacherId } });
        if (!recording) return { kind: "not-stale" };

        let ineligible: string | null = null;
        for (const check of [
          () => assertTeacherCanUpload(tx, session.teacherId),
          () => assertLectureActiveForUpload(tx, recording.lectureId, session.teacherId),
        ]) {
          try {
            await check();
          } catch (error) {
            const code = (error as { code?: unknown }).code;
            if (code !== "TEACHER_ACCOUNT_INACTIVE" && code !== "LECTURE_NOT_ACTIVE") throw error;
            ineligible = code;
            break;
          }
        }
        if (ineligible) {
          await failStaleClaim(tx, session, recording, ineligible, now);
          return { kind: "failed-ineligible" };
        }

        await takeOverStaleClaim(tx, session, recording, claimName, now);
        return {
          kind: "claimed",
          claim: {
            uploadId,
            teacherId: session.teacherId,
            recordingId: recording.id,
            lectureId: recording.lectureId,
            claimVersion: session.version + 1,
            claimName,
            expectedBytes: byteCountToNumber(session.expectedBytes, "expectedBytes"),
            chunkCount: session.chunkCount,
          },
        };
      }, RECORDED_LECTURE_TRANSACTION_OPTIONS);
    } catch (error) {
      if ((error as { code?: unknown }).code === "UPLOAD_BUSY") return "lost-race";
      throw error;
    }

    if (outcome.kind !== "claimed") return outcome.kind;
    handedOff = true;
    startCompletionJob(outcome.claim, storage, config, release);
    return "recovered";
  } finally {
    if (!handedOff) release();
  }
}

// ---- Cancel ------------------------------------------------------------------------------------------------

/**
 * Whether a chunk lease is still current, i.e. its writer may still consume
 * disk space, so its capacity reservation (the lease is counted by
 * computeReservations only while ACTIVE) must not be released.
 *
 * A chunk writer (recorded-lecture-chunk-service.ts) streams with a write
 * deadline of leaseExpiresAt - writeMarginMs (60 s for the default 300 s
 * lease). LocalFileStorage.writeNewFile checks that deadline before every
 * piece and a timer rejects a read still pending at the deadline, so after it
 * the writer accepts no further piece; only a piece it already received may
 * still be finishing its single write, then the file is deleted. Once
 * now >= leaseExpiresAt the writer is therefore at least writeMarginMs past
 * its deadline, and releasing its reservation is safe (at most that one piece,
 * covered by minFreeBytes). Before that, the lease counts as held, whichever
 * process the writer runs in (the in-process mutex cannot see other processes).
 */
function leaseHeld(session: { leaseToken: string | null; leaseExpiresAt: Date | null }, now: Date): boolean {
  return session.leaseToken !== null && session.leaseExpiresAt !== null && session.leaseExpiresAt.getTime() > now.getTime();
}

function chunkInProgress(leaseExpiresAt: Date, now: Date) {
  return uploadError("CHUNK_IN_PROGRESS", { retryAfterSeconds: retryAfterSecondsForLease(leaseExpiresAt.getTime(), now.getTime()) });
}

async function currentStatus(teacherId: string, uploadId: string, config: RecordedLectureConfig): Promise<UploadStatusDto> {
  const session = await prisma.recordingUploadSession.findFirst({ where: { id: uploadId, teacherId } });
  if (!session) throw uploadError("UPLOAD_NOT_FOUND");
  const recording = await prisma.recordedLecture.findFirst({ where: { id: session.recordedLectureId, teacherId } });
  if (!recording) throw uploadError("UPLOAD_NOT_FOUND");
  return buildUploadStatusDto(session, recording, config, (await serverNow()).getTime());
}

/**
 * DELETE /api/recorded-lectures/uploads/[uploadId]. Allowed for the owner even
 * when blocked (D3). Database only: no file is deleted (RL-3.5 cleans up).
 */
export async function cancelRecordingUpload(input: { teacherId: string; uploadId: string }): Promise<UploadStatusDto> {
  const { teacherId, uploadId } = input;
  if (!isRecordedLectureId(uploadId)) throw uploadError("UPLOAD_NOT_FOUND");
  const config = loadConfig();

  let session = await prisma.recordingUploadSession.findFirst({ where: { id: uploadId, teacherId } });
  if (!session) throw uploadError("UPLOAD_NOT_FOUND");

  if (session.state === "ACTIVE") {
    let release: () => void;
    try {
      release = await getUploadMutex().acquire(uploadMutexKey(uploadId), { timeoutMs: COMPLETION_MUTEX_WAIT_MS });
    } catch (error) {
      // A chunk (or completion) of this upload is being handled here: change nothing.
      if (isUploadMutexTimeoutError(error)) throw uploadBusyConflict();
      throw error;
    }
    try {
      await prisma.$transaction(async (tx) => {
        await setUploadLockTimeout(tx);
        const now = await serverNow();
        const current = await tx.recordingUploadSession.findFirst({ where: { id: uploadId, teacherId } });
        if (!current) throw uploadError("UPLOAD_NOT_FOUND");
        if (current.state !== "ACTIVE") return; // changed meanwhile (another process): handled below
        // A chunk writer of ANY process may hold a lease: its capacity reservation must stay
        // until it can no longer write (see leaseHeld). Nothing is changed while it is current,
        // also when the upload itself has expired (expiry waits for the lease too).
        if (leaseHeld(current, now)) throw chunkInProgress(current.leaseExpiresAt as Date, now);
        if (current.expiresAt.getTime() <= now.getTime()) {
          await expireStaleUploads(tx, { teacherId, uploadId }, now);
          return;
        }
        const cancelled = await tx.recordingUploadSession.updateMany({
          where: {
            id: uploadId,
            teacherId,
            state: "ACTIVE",
            version: current.version,
            // No current lease (also checked above; the version makes a concurrent grant fail this update).
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
          },
          data: {
            state: "CANCELLED",
            endedAt: now,
            updatedAt: now,
            leaseToken: null,
            leaseOffset: null,
            leaseBytes: null,
            leaseGrantedAt: null,
            leaseExpiresAt: null,
            version: { increment: 1 },
          },
        });
        if (cancelled.count !== 1) {
          // Lost a race: a chunk lease may just have been granted (by another process).
          const again = await tx.recordingUploadSession.findFirst({ where: { id: uploadId, teacherId } });
          if (again && again.state === "ACTIVE" && leaseHeld(again, now)) throw chunkInProgress(again.leaseExpiresAt as Date, now);
          throw uploadBusyConflict();
        }
        await tx.recordedLecture.updateMany({
          where: { id: current.recordedLectureId, teacherId, state: "UPLOADING" },
          data: { state: "FAILED", failureCode: "UPLOAD_CANCELLED", failedAt: now, updatedAt: now },
        });
      }, RECORDED_LECTURE_TRANSACTION_OPTIONS);
    } finally {
      release();
    }
    session = await prisma.recordingUploadSession.findFirst({ where: { id: uploadId, teacherId } });
    if (!session) throw uploadError("UPLOAD_NOT_FOUND");
  }

  if (session.state === "COMPLETING") {
    const stale = session;
    const recording = await prisma.recordedLecture.findFirst({ where: { id: stale.recordedLectureId, teacherId } });
    if (!recording) throw uploadError("UPLOAD_NOT_FOUND");
    // Only a stale claim; no mutex needed: completion files are claim-specific, and the
    // old job's heartbeat and READY / FAILED transitions are conditional on its claim.
    await prisma.$transaction(async (tx) => {
      await setUploadLockTimeout(tx);
      const now = await serverNow();
      if (!isCompletionClaimStale(stale.lastActivityAt, now.getTime())) throw uploadError("UPLOAD_COMPLETING");
      const cancelled = await tx.recordingUploadSession.updateMany({
        where: {
          id: uploadId,
          teacherId,
          state: "COMPLETING",
          version: stale.version,
          lastActivityAt: { lte: new Date(now.getTime() - COMPLETION_CLAIM_STALE_MS) },
        },
        data: { state: "CANCELLED", endedAt: now, updatedAt: now, version: { increment: 1 } },
      });
      const failed = await tx.recordedLecture.updateMany({
        where: { id: recording.id, teacherId, state: "VERIFYING", storedFileName: recording.storedFileName },
        data: { state: "FAILED", failureCode: "UPLOAD_CANCELLED", failedAt: now, updatedAt: now },
      });
      if (cancelled.count !== 1 || failed.count !== 1) throw uploadError("UPLOAD_COMPLETING");
    }, RECORDED_LECTURE_TRANSACTION_OPTIONS);
  } else if (session.state === "COMPLETED") {
    throw uploadError("UPLOAD_ALREADY_COMPLETED");
  }

  return currentStatus(teacherId, uploadId, config);
}
