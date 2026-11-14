/*
 * Recorded Lectures (RL-3.5): which stored files may be deleted. Pure: the
 * maintenance service reads the database and the file's modification time,
 * then asks these functions. Nothing here is decided from a file's age or
 * name alone; every rule needs the database facts below.
 *
 * Every "DELETE" condition is ONE-WAY: once true, no later database change can
 * make the file needed again, so a decision cannot be invalidated between the
 * database read and the deletion:
 *   - a lease token is never reused, and time only moves forward;
 *   - a chunk can be committed only under its current, unexpired lease;
 *   - final session states (COMPLETED, CANCELLED, FAILED, EXPIRED) never change;
 *   - a recording's storedFileName only ever changes to a fresh random name, so a
 *     name that is no longer current never becomes current again;
 *   - FAILED is final; a missing row never returns.
 *
 * The maintenance service must read the session (lease) BEFORE the committed
 * chunk rows (see chunkFileDisposition).
 */

export const SCRATCH_GRACE_DEFAULT_MS = 15 * 60_000;
export const ORPHAN_GRACE_DEFAULT_MS = 48 * 3_600_000;

const FINAL_SESSION_STATES = new Set(["COMPLETED", "CANCELLED", "FAILED", "EXPIRED"]);

export type Disposition = { action: "KEEP" | "DELETE"; reason: string };

const keep = (reason: string): Disposition => ({ action: "KEEP", reason });
const del = (reason: string): Disposition => ({ action: "DELETE", reason });

/** The file is at least `graceMs` old (by its last modification). */
function pastGrace(fileModifiedAtMs: number, nowMs: number, graceMs: number): boolean {
  return nowMs - fileModifiedAtMs >= graceMs;
}

export type SessionFacts = {
  state: string;
  leaseToken: string | null;
  leaseExpiresAtMs: number | null;
  endedAtMs: number | null;
};

/**
 * A chunk file System/TemporaryUploads/{uploadId}.{token}.chunk.
 *
 * `session` must be read BEFORE `committed` (whether a RecordingUploadChunk row
 * of this upload has this token): a commit needs the token to be the current,
 * unexpired lease, so if it was not when the session was read, no later commit
 * can add the row, and any earlier commit is visible to the later read.
 *
 *   KEEP   the token is the session's current, unexpired lease (a writer may be
 *          using it, whatever the file's age);
 *   KEEP   committed, and the upload is not final (ACTIVE / COMPLETING: completion
 *          may still need it);
 *   DELETE committed, the upload is final and ended at least the grace ago (or the
 *          session no longer exists), and the file is past the grace;
 *   DELETE not committed (and not the current lease: never committable again), past
 *          the grace (a stale writer is long past its write deadline);
 *   KEEP   otherwise (within the grace).
 */
export function chunkFileDisposition(input: {
  token: string;
  fileModifiedAtMs: number;
  session: SessionFacts | null;
  committed: boolean;
  nowMs: number;
  graceMs?: number;
}): Disposition {
  const grace = input.graceMs ?? SCRATCH_GRACE_DEFAULT_MS;
  const { session } = input;
  if (session && session.leaseToken === input.token && session.leaseExpiresAtMs !== null && session.leaseExpiresAtMs > input.nowMs) {
    return keep("current lease");
  }
  if (!pastGrace(input.fileModifiedAtMs, input.nowMs, grace)) return keep("within grace");
  if (input.committed) {
    if (!session) return del("committed chunk of a removed upload");
    if (!FINAL_SESSION_STATES.has(session.state)) return keep("committed chunk of an unfinished upload");
    if (session.endedAtMs === null || !pastGrace(session.endedAtMs, input.nowMs, grace)) return keep("upload ended within grace");
    return del("committed chunk of a finished upload");
  }
  return del("uncommitted chunk");
}

/**
 * An assembly file System/TemporaryUploads/{uploadId}.{claimHex}.assembly.
 *
 *   KEEP   it is the CURRENT claim's: the session is COMPLETING and the recording's
 *          storedFileName is this claim's file name;
 *   DELETE otherwise, past the grace (a stale claim's job stops at its next
 *          heartbeat and its transitions are fenced);
 *   KEEP   within the grace.
 */
export function assemblyFileDisposition(input: {
  claimFileName: string;
  fileModifiedAtMs: number;
  sessionState: string | null;
  recordingStoredFileName: string | null;
  nowMs: number;
  graceMs?: number;
}): Disposition {
  const grace = input.graceMs ?? SCRATCH_GRACE_DEFAULT_MS;
  if (input.sessionState === "COMPLETING" && input.recordingStoredFileName === input.claimFileName) return keep("current claim");
  if (!pastGrace(input.fileModifiedAtMs, input.nowMs, grace)) return keep("within grace");
  return del("assembly of a claim that is not current");
}

export type RecordingFacts = { state: string; storedFileName: string | null };

/**
 * A final file Teachers/{t}/Lectures/{l}/RecordedLectures/{recordingId}/{name}.
 *
 *   KEEP   the recording exists, its storedFileName is this name and it is not
 *          FAILED (READY: the published file; VERIFYING: a claim between publishing
 *          and READY). Recordings removed by a teacher (status 1 / 2) are kept:
 *          purging them is not part of this stage;
 *   DELETE otherwise (missing recording, another name, FAILED), and only at least
 *          the 48-hour orphan grace after the file's last modification;
 *   KEEP   within that grace.
 */
export function finalFileDisposition(input: {
  storedName: string;
  fileModifiedAtMs: number;
  recording: RecordingFacts | null;
  nowMs: number;
  orphanGraceMs?: number;
}): Disposition {
  const grace = input.orphanGraceMs ?? ORPHAN_GRACE_DEFAULT_MS;
  const { recording } = input;
  if (recording && recording.storedFileName === input.storedName && recording.state !== "FAILED") return keep("referenced recording file");
  if (!pastGrace(input.fileModifiedAtMs, input.nowMs, grace)) return keep("within orphan grace");
  return del(recording ? "file of a claim that is not the recording's" : "file of a removed recording");
}

/** A legacy System/TemporaryUploads/{uploadId}.part file (unused since Option B): only of a finished or removed upload. */
export function partFileDisposition(input: {
  fileModifiedAtMs: number;
  sessionState: string | null;
  nowMs: number;
  graceMs?: number;
}): Disposition {
  const grace = input.graceMs ?? SCRATCH_GRACE_DEFAULT_MS;
  if (input.sessionState !== null && !FINAL_SESSION_STATES.has(input.sessionState)) return keep("upload not finished");
  if (!pastGrace(input.fileModifiedAtMs, input.nowMs, grace)) return keep("within grace");
  return del("part file of a finished upload");
}

/** A recording's (empty) directory may be removed only when nothing will write into it again. */
export function recordingDirectoryRemovable(recording: RecordingFacts | null): boolean {
  return recording === null || recording.state === "FAILED";
}
