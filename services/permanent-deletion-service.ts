import { parseSubmissionStorageKey } from "@/lib/assignments/submission-keys";
import { AppError, reportRouteError } from "@/lib/error-handler";
import { parseNoteStorageKey } from "@/lib/notes/storage-keys";
import { prisma } from "@/lib/prisma";
import { lockTeacherStorageQuota, setStorageQuotaLockTimeout } from "@/lib/storage-quota/locks";
import { legacyCopyPathFor, removeLegacyCopyStrict, removeStoredFileStrict, type StoredFileKind } from "@/lib/stored-files/stored-file";

/*
 * Teacher storage quota, Stage 3.6: PERMANENT deletion of Notes and of
 * assignments (with every student submission and its PDF). There is no
 * recycle bin and no restore.
 *
 * Status of Note / Assignment rows:
 *   0 = active (the only status any page, API or count shows);
 *   1 = removed by an earlier version (soft delete; kept as it was);
 *   2 = PERMANENT DELETION PENDING (new): invisible everywhere like 1, the
 *       stored files are being / will be deleted, the row is then deleted.
 *
 * Lifecycle (recoverable; every step idempotent, so a crash or a failure at
 * any point is finished by a retry: the teacher's repeated DELETE or the
 * maintenance scheduler's retry phase, retryPendingDeletions):
 *   1. mark: status 0 -> 2 in its own short statement, COMMITTED before any
 *      file is touched;
 *   2. files: each stored file is deleted one by one, outside any database
 *      transaction; a file already missing counts as deleted;
 *   3. finalize: only after every file is gone, the row is deleted (Note:
 *      its NoteStudent rows cascade; Assignment: after its last submission
 *      row). Usage (getTeacherStorageUsage) counts a row's storageKey
 *      until this moment, so the quota never under-counts a file that still
 *      exists.
 *
 * What is deleted, and only after verification:
 *   - the new-storage file at storageKey, ONLY if the key parses as a key of
 *     exactly this resource (teacher from the database, lecture, note or
 *     assignment + submission ids). A key that does not verify is never
 *     deleted: the row stays pending and the problem is logged (no guessing);
 *   - its rollback copy, ONLY if the row's fileUrl is exactly the copy
 *     paired with the key (legacyCopyPathFor), i.e. a copy this feature
 *     wrote. Single files only; never a directory.
 *   - Legacy-only rows (storageKey null: files uploaded before unified
 *     storage) are not counted in usage and their file cannot be verified as
 *     this row's own: the row is deleted, the legacy file is RETAINED (no
 *     legacy migration or cleanup in this stage). The inventory tool lists
 *     such files as unreferenced.
 *
 * Assignment cascade: while status 2, a student's submission commit is
 * refused (the submit route re-checks status 0 inside its quota-locked
 * commit transaction). Finalize counts the remaining submissions and deletes
 * the assignment in ONE transaction under the teacher's storage quota lock,
 * so it serialises with every submission commit: a submission committed
 * just before the mark is seen and deleted (files first) by the next pass,
 * never cascade-deleted with its file left behind.
 */

export const NOTE_STATUS_DELETION_PENDING = 2;
export const ASSIGNMENT_STATUS_DELETION_PENDING = 2;

/** DELETED = the row and its files are gone; PENDING = marked, files or finalize still to do (retried). */
export type PermanentDeletionState = "DELETED" | "PENDING";

/** Submissions handled by one call (request: a few hundred; maintenance: per item, bounded). */
export const DEFAULT_SUBMISSIONS_PER_CALL = 500;
const SUBMISSION_BATCH = 100;
const FINALIZE_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

function reportDeletionProblem(error: unknown, label: string) {
  try {
    reportRouteError(error, { request: new Request("http://internal/storage/permanent-deletion", { method: "POST" }), label });
  } catch {
    // Logging must never break deletion.
  }
}

class UnverifiableStorageKeyError extends Error {
  constructor(what: string) {
    super(`The storage key of ${what} does not belong to it; nothing was deleted.`);
    this.name = "UnverifiableStorageKeyError";
  }
}

/** Deletes a verified stored file and its paired rollback copy. Throws on any failure (missing = done). */
async function removeVerifiedFiles(kind: StoredFileKind, storageKey: string, fileUrl: string): Promise<void> {
  await removeStoredFileStrict(storageKey);
  const pairedCopy = legacyCopyPathFor(kind, storageKey);
  if (pairedCopy && fileUrl === pairedCopy) await removeLegacyCopyStrict(pairedCopy);
}

// ---- Notes -------------------------------------------------------------------------------------------------

/**
 * Teacher DELETE of a note: marks it pending (if still active) and tries to
 * finish at once. A note already pending is retried (idempotent).
 * 404 unless the teacher owns the note through an active lecture.
 */
export async function deleteNotePermanently(input: { teacherId: string; lectureId: string; noteId: string }): Promise<{ state: PermanentDeletionState; classId: string }> {
  const note = await prisma.note.findFirst({
    where: {
      id: input.noteId,
      lectureId: input.lectureId,
      status: { in: [0, NOTE_STATUS_DELETION_PENDING] },
      lecture: { status: 0, class: { teacherId: input.teacherId } },
    },
    select: { id: true, status: true, lecture: { select: { classId: true } } },
  });
  if (!note) throw new AppError("Note not found.", 404, "NOTE_NOT_FOUND");
  if (note.status === 0) {
    await prisma.note.updateMany({ where: { id: note.id, status: 0 }, data: { status: NOTE_STATUS_DELETION_PENDING } });
  }
  return { state: await purgePendingNote(note.id), classId: note.lecture.classId };
}

/** Files, then the row, of ONE pending note. Never throws (a failure leaves it pending, logged). */
export async function purgePendingNote(noteId: string): Promise<PermanentDeletionState> {
  return publicState(await purgeNote(noteId));
}

/** Internal outcome: FAILED (an error, logged) is distinguished from plain PENDING (more work / a concurrent change). */
type PurgeOutcome = PermanentDeletionState | "FAILED";
const publicState = (outcome: PurgeOutcome): PermanentDeletionState => (outcome === "DELETED" ? "DELETED" : "PENDING");

async function purgeNote(noteId: string): Promise<PurgeOutcome> {
  try {
    const row = await prisma.note.findFirst({
      where: { id: noteId, status: NOTE_STATUS_DELETION_PENDING },
      select: { id: true, lectureId: true, fileUrl: true, storageKey: true, lecture: { select: { class: { select: { teacherId: true } } } } },
    });
    if (!row) return (await prisma.note.count({ where: { id: noteId } })) === 0 ? "DELETED" : "PENDING";

    if (row.storageKey !== null) {
      const parsed = parseNoteStorageKey(row.storageKey);
      if (!parsed || parsed.teacherId !== row.lecture.class.teacherId || parsed.lectureId !== row.lectureId || parsed.noteId !== row.id) {
        throw new UnverifiableStorageKeyError(`note ${row.id}`);
      }
      await removeVerifiedFiles("NOTE", row.storageKey, row.fileUrl);
    }
    // Finalize only the row whose files were just removed (same key, same fileUrl).
    await prisma.note.deleteMany({ where: { id: row.id, status: NOTE_STATUS_DELETION_PENDING, storageKey: row.storageKey, fileUrl: row.fileUrl } });
    return (await prisma.note.count({ where: { id: noteId } })) === 0 ? "DELETED" : "PENDING";
  } catch (error) {
    reportDeletionProblem(error, "Permanent deletion: note (left pending, retried)");
    return "FAILED";
  }
}

// ---- Assignments (cascade to every submission) ------------------------------------------------------------

/**
 * Teacher DELETE of an assignment: marks it pending (if still active) and
 * tries to delete every submission's files and rows, then the assignment.
 */
export async function deleteAssignmentPermanently(input: {
  teacherId: string;
  lectureId: string;
  assignmentId: string;
}): Promise<{ state: PermanentDeletionState; classId: string }> {
  const assignment = await prisma.assignment.findFirst({
    where: {
      id: input.assignmentId,
      lectureId: input.lectureId,
      status: { in: [0, ASSIGNMENT_STATUS_DELETION_PENDING] },
      lecture: { status: 0, class: { teacherId: input.teacherId } },
    },
    select: { id: true, status: true, lecture: { select: { classId: true } } },
  });
  if (!assignment) throw new AppError("Assignment not found.", 404, "ASSIGNMENT_NOT_FOUND");
  if (assignment.status === 0) {
    await prisma.assignment.updateMany({ where: { id: assignment.id, status: 0 }, data: { status: ASSIGNMENT_STATUS_DELETION_PENDING } });
  }
  return { state: await purgePendingAssignment(assignment.id), classId: assignment.lecture.classId };
}

/**
 * Submissions (files, then rows), then the assignment, of ONE pending
 * assignment. Bounded by `maxSubmissions`; never throws.
 */
export async function purgePendingAssignment(
  assignmentId: string,
  options: { maxSubmissions?: number } = {}
): Promise<PermanentDeletionState> {
  return publicState(await purgeAssignment(assignmentId, options));
}

async function purgeAssignment(assignmentId: string, options: { maxSubmissions?: number }): Promise<PurgeOutcome> {
  const maxSubmissions = options.maxSubmissions ?? DEFAULT_SUBMISSIONS_PER_CALL;
  try {
    const row = await prisma.assignment.findFirst({
      where: { id: assignmentId, status: ASSIGNMENT_STATUS_DELETION_PENDING },
      select: { id: true, lectureId: true, lecture: { select: { class: { select: { teacherId: true } } } } },
    });
    if (!row) return (await prisma.assignment.count({ where: { id: assignmentId } })) === 0 ? "DELETED" : "PENDING";
    const teacherId = row.lecture.class.teacherId;

    let handled = 0;
    // Two passes at most: the second one picks up a submission committed just before the mark.
    for (let pass = 0; pass < 2; pass++) {
      for (;;) {
        const batch = await prisma.assignmentSubmission.findMany({
          where: { assignmentId: row.id },
          orderBy: { id: "asc" },
          take: SUBMISSION_BATCH,
          select: { id: true, fileUrl: true, storageKey: true },
        });
        if (batch.length === 0) break;
        for (const submission of batch) {
          if (handled >= maxSubmissions) return "PENDING";
          handled++;
          if (submission.storageKey !== null) {
            const parsed = parseSubmissionStorageKey(submission.storageKey);
            if (
              !parsed ||
              parsed.teacherId !== teacherId ||
              parsed.lectureId !== row.lectureId ||
              parsed.assignmentId !== row.id ||
              parsed.submissionId !== submission.id
            ) {
              throw new UnverifiableStorageKeyError(`submission ${submission.id}`);
            }
            await removeVerifiedFiles("SUBMISSION", submission.storageKey, submission.fileUrl);
          }
          // Only the row whose files were just removed; a concurrent replacement is re-read next.
          await prisma.assignmentSubmission.deleteMany({
            where: { id: submission.id, assignmentId: row.id, storageKey: submission.storageKey, fileUrl: submission.fileUrl },
          });
        }
      }

      const finalized = await prisma.$transaction(async (tx) => {
        await setStorageQuotaLockTimeout(tx);
        await lockTeacherStorageQuota(tx, teacherId);
        if ((await tx.assignmentSubmission.count({ where: { assignmentId: row.id } })) > 0) return false;
        await tx.assignment.deleteMany({ where: { id: row.id, status: ASSIGNMENT_STATUS_DELETION_PENDING } });
        return true;
      }, FINALIZE_TRANSACTION_OPTIONS);
      if (finalized) return (await prisma.assignment.count({ where: { id: assignmentId } })) === 0 ? "DELETED" : "PENDING";
    }
    return "PENDING";
  } catch (error) {
    reportDeletionProblem(error, "Permanent deletion: assignment (left pending, retried)");
    return "FAILED";
  }
}

// ---- Maintenance retry -------------------------------------------------------------------------------------

export type PendingDeletionCounts = { examined: number; deleted: number; pending: number; failed: number; backoff: number };
export type PendingDeletionReport = { notes: PendingDeletionCounts; assignments: PendingDeletionCounts };

/*
 * Fairness and log volume (Stage 3.7): each pass continues AFTER the last id
 * of the previous pass (wrapping around at the end), so items that keep
 * failing can never occupy every slot and starve the others; and an item
 * whose retry FAILED is skipped for 1, 2, 4 ... 60 minutes (logged once per
 * attempt, not every minute). Both are process memory only: a restart simply
 * starts over (every item is retried once at once, which is safe: each step is
 * idempotent). The teacher's own repeated DELETE ignores the backoff.
 */
type Backoff = { attempts: number; nextAtMs: number };
type RetryState = { cursors: { note: string | null; assignment: string | null }; backoff: Map<string, Backoff> };
const retryHolder = globalThis as unknown as { slPendingDeletionRetry?: RetryState };
function retryState(): RetryState {
  if (!retryHolder.slPendingDeletionRetry) retryHolder.slPendingDeletionRetry = { cursors: { note: null, assignment: null }, backoff: new Map() };
  return retryHolder.slPendingDeletionRetry;
}

/** Tests only. */
export function resetPendingDeletionRetryStateForTests() {
  delete retryHolder.slPendingDeletionRetry;
}

/** Backoff after the n-th consecutive failure: 1, 2, 4 ... minutes, at most 60. */
export function pendingDeletionBackoffMs(attempts: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

async function retryKind(
  kind: "note" | "assignment",
  take: number,
  purge: (id: string) => Promise<PurgeOutcome>,
  counts: PendingDeletionCounts,
  outOfTime: () => boolean
): Promise<void> {
  const state = retryState();
  const cursor = state.cursors[kind];
  const where = { status: 2, ...(cursor ? { id: { gt: cursor } } : {}) };
  const select = { id: true } as const;
  const rows =
    kind === "note"
      ? await prisma.note.findMany({ where, orderBy: { id: "asc" }, take, select })
      : await prisma.assignment.findMany({ where, orderBy: { id: "asc" }, take, select });
  // A short page means the end was reached: the next pass starts from the beginning.
  state.cursors[kind] = rows.length < take ? null : rows[rows.length - 1].id;
  let lastDone = cursor;
  for (const { id } of rows) {
    if (outOfTime()) {
      state.cursors[kind] = lastDone; // not finished: resume after the last item handled
      return;
    }
    lastDone = id;
    const key = `${kind}:${id}`;
    const entry = state.backoff.get(key);
    if (entry && entry.nextAtMs > Date.now()) {
      counts.backoff++;
      continue;
    }
    counts.examined++;
    const outcome = await purge(id);
    if (outcome === "FAILED") {
      counts.failed++;
      const attempts = (entry?.attempts ?? 0) + 1;
      state.backoff.set(key, { attempts, nextAtMs: Date.now() + pendingDeletionBackoffMs(attempts) });
    } else {
      state.backoff.delete(key);
      counts[outcome === "DELETED" ? "deleted" : "pending"]++;
    }
  }
}

/**
 * One retry pass over pending Notes and assignments (bounded, sequential).
 * Called by the existing maintenance scheduler's tick; never throws.
 */
export async function retryPendingDeletions(
  options: { maxNotes?: number; maxAssignments?: number; maxSubmissionsPerAssignment?: number; deadlineMs?: number } = {}
): Promise<PendingDeletionReport> {
  const empty = (): PendingDeletionCounts => ({ examined: 0, deleted: 0, pending: 0, failed: 0, backoff: 0 });
  const report: PendingDeletionReport = { notes: empty(), assignments: empty() };
  const outOfTime = () => options.deadlineMs !== undefined && Date.now() >= options.deadlineMs;
  // Forget backoffs that can no longer matter (items finished elsewhere).
  const nowMs = Date.now();
  for (const [key, entry] of retryState().backoff) if (entry.nextAtMs + 2 * 3_600_000 < nowMs) retryState().backoff.delete(key);
  try {
    await retryKind("note", options.maxNotes ?? 100, (id) => purgeNote(id), report.notes, outOfTime);
    if (outOfTime()) return report;
    const maxSubmissions = options.maxSubmissionsPerAssignment ?? 200;
    await retryKind("assignment", options.maxAssignments ?? 20, (id) => purgeAssignment(id, { maxSubmissions }), report.assignments, outOfTime);
  } catch (error) {
    reportDeletionProblem(error, "Permanent deletion: maintenance retry");
  }
  return report;
}
