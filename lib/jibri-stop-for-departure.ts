import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import { serverNow } from "@/lib/server-clock";
import { departureState } from "@/lib/teacher-presence";
import { CLASSROOM_ROOM_NAME, generateSystemJitsiToken } from "@/lib/jitsi-auth";
import type { JibriStopConfig } from "@/lib/jibri-stop-config";
import { armsFences, recordJibriConnectionProof, type JibriFenceMode } from "@/lib/jibri-fence-control";
import {
  armJibriFence,
  departureCovered,
  featureActive,
  fenceDue,
  lateFenceDue,
  fenceFeatureSelect,
  fenceOpen,
  fenceReleased,
  provisionalConfirmed,
  type FenceFeatureRow,
} from "@/lib/jibri-shutdown-gate";
import { ACTIVE_FEATURE_STATUSES } from "@/lib/youtube-feature-state";
import { withLectureYouTubeLock, withTeacherYouTubeLock } from "@/lib/youtube-operation-lock";
import { youtubeDeadlineRemainingMs, youtubeTimeouts } from "@/lib/youtube-request";
import { getYouTubeLiveStream } from "@/lib/youtube-live";
import type { JibriController, JibriStopOutcome, JibriStopReport } from "@/lib/jibri-control";

/*
 * Backend Jibri stop after a teacher departure, and the release of the
 * teacher's shutdown fence (lib/jibri-shutdown-gate.ts). Run ONLY by the
 * standalone worker (scripts/jibri-stop-worker.ts), per class session with
 * an open (or due) fence, active or deactivated, in the shared mode "on"
 * or "drain" (lib/jibri-fence-control.ts).
 *
 * Lock order (every YouTube lock, every caller): the TEACHER lock, then a
 * LECTURE lock, never the other way round (lib/youtube-operation-lock.ts).
 * Recording / Live starts take both; each attempt here takes both, so an
 * attempt, a start of ANY of the teacher's lectures and an administrator's
 * override never interleave. No acquisition ever waits (a held lock is
 * refused at once: "busy", tried again on the next sweep), so no waiting
 * cycle, hence no deadlock, can form. No database transaction is held while
 * the network (XMPP, YouTube) is used.
 *
 * Each attempt (recorded BEFORE connecting; conditional on the state read):
 * - A provisional fence (the tab-close signal's) waits for its departure to
 *   be confirmed, is made a confirmed one then, and is cleared if the
 *   departure was cancelled.
 * - Mode "stop" only with the shared mode "on", the session active, its
 *   departure confirmed, the teacher NOT back since the fence was armed and
 *   no STOP sent for this fence: then the ONE STOP (jibriStopSentAt written
 *   BEFORE it is sent). Otherwise mode "observe": join, look, leave. Never a
 *   second STOP (Jicofo ends its Jibri session on the first one), never an
 *   automatic STOP to a returned teacher's room, never one in "drain".
 * - Room evidence: the stream recorder left voluntarily after our STOP, or
 *   the room shows no stream recorder and no stream session. Never enough
 *   alone (Jibri 8.0-205 leaves the call even when it could not kill ffmpeg).
 * - Independent evidence: YouTube's status of the PINNED reusable stream
 *   (jibriStopStreamId, the one the classroom's Jibri pushed into; a newer
 *   or reconnected stream never stands in for it). "inactive" / "ready":
 *   no ingest at that moment; "active": ingest; anything else (no pinned
 *   ID, not found, not authorized, an error): unknown.
 * - Release (confirmed / not-running) only after JIBRI_STREAM_IDLE_READINGS
 *   idle readings, each with room evidence, each at least
 *   JIBRI_STREAM_IDLE_GAP_MS after the previous one, spanning at least
 *   JIBRI_STREAM_IDLE_SPAN_MS. Any active / unknown reading or the recorder
 *   seen again starts the series over.
 *
 *   What this establishes: YouTube received nothing on that stream at those
 *   moments, over that span, with no stream recorder in the room. NOT that
 *   ffmpeg or the Jibri process exited: a stalled process may push again.
 *   Hence:
 * - After a release the pinned stream is still watched for
 *   JIBRI_POST_RELEASE_WATCH_MS: ingest resuming while the teacher has no
 *   Recording / Live of their own re-opens the fence (observation only).
 *   Once the teacher has started something, the watch ends (its ingest is
 *   expected then and cannot be told apart).
 * - Retries: 30 s, 2 min, 5 min, 5 min; after JIBRI_STOP_MAX_ATTEMPTS the
 *   fence is "unresolved" and observed every 15 min. Nothing is released by
 *   time; an unverifiable shutdown waits for an administrator's override
 *   (services/jibri-fence-override-service.ts).
 *
 * Arming here: a confirmed provisional fence whose departure COVERED a
 * Recording / Live generation is made a confirmed one ("pending"); one that
 * covered none is cleared (decided under the locks every start holds while
 * it writes its row, so a racing start is always seen). Mode "on" also
 * arms a fence that is due for an active session, and a LATE fence for a
 * session that ended after an unfenced departure (lib/jibri-shutdown-gate.ts
 * lateFenceDue): observation only, as for every ended session.
 *
 * Every connection is also PROOF for the worker's health
 * (lib/jibri-fence-control.ts): a login to the expected server, a join of
 * the room as a moderator, or the failure's code.
 *
 * Sweeps are time-boxed (JIBRI_SWEEP_BUDGET_MS) and take the least recently
 * attempted sessions first; the rest wait for the next sweep.
 *
 * States: provisional -> pending -> stop-sent -> verifying -> confirmed /
 * not-running (-> re-opened to stop-sent / pending if the stream resumes
 * while watched). unresolved: attempts exhausted, still observed. Any open
 * state -> released by an override.
 */

export const JIBRI_STOP_STATES = ["provisional", "pending", "stop-sent", "verifying", "unresolved", "confirmed", "not-running"] as const;

export type JibriStopState = (typeof JIBRI_STOP_STATES)[number];

/** Delay before the next attempt, by attempts made (1st .. 4th). */
export const JIBRI_STOP_RETRY_DELAYS_MS = [30_000, 120_000, 300_000, 300_000] as const;

/** Attempts before the fence is "unresolved" (observation continues). */
export const JIBRI_STOP_MAX_ATTEMPTS = 5;

/** Observation interval of an unresolved fence. */
export const JIBRI_STOP_UNRESOLVED_OBSERVE_MS = 900_000;

/** After a refusal (forbidden / not-allowed: a configuration problem). */
export const JIBRI_STOP_REFUSED_DELAY_MS = 300_000;

/** Idle readings needed, their minimum spacing and the minimum span of the series. */
export const JIBRI_STREAM_IDLE_READINGS = 3;
export const JIBRI_STREAM_IDLE_GAP_MS = 30_000;
export const JIBRI_STREAM_IDLE_SPAN_MS = 120_000;

/** How long the pinned stream is still watched after a release, and how often. */
export const JIBRI_POST_RELEASE_WATCH_MS = 600_000;
export const JIBRI_POST_RELEASE_CHECK_MS = 60_000;

/**
 * One sweep starts no new session after this long (the one in flight ends
 * within its own lock budget). Below the app's stall threshold
 * (JIBRI_SWEEP_STALL_MS) with room for that attempt.
 */
export const JIBRI_SWEEP_BUDGET_MS = 120_000;

/** Lock budget for one attempt (within the lock's TTL minus its safety margin). */
export const JIBRI_STOP_LOCK_BUDGET_MS = 40_000;

/** The XMPP part of an attempt (leaves time for the database writes and the stream read). */
export const JIBRI_STOP_XMPP_BUDGET_MS = 30_000;

/** Bound on each database step of an attempt (a hung query never holds the lock). */
export const JIBRI_STOP_DB_TIMEOUT_MS = 5_000;

/** Bound on the controller's re-checks and on recording the STOP (fail closed). */
export const JIBRI_STOP_CHECK_TIMEOUT_MS = 3_000;

export { readJibriStopConfig, type JibriStopConfig } from "@/lib/jibri-stop-config";

export class JibriStopDbTimeoutError extends Error {
  constructor() {
    super("Database step timed out");
    this.name = "JibriStopDbTimeoutError";
  }
}

/**
 * Stops waiting for a step after `ms` (a query itself cannot be cancelled;
 * its late result is ignored). Rejects with JibriStopDbTimeoutError.
 */
function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => {});

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new JibriStopDbTimeoutError()), Math.max(0, ms));

    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

const sessionSelect = {
  id: true,
  lectureId: true,
  isActive: true,
  startedAt: true,
  endedAt: true,
  roomName: true,
  jitsiDomain: true,
  teacherDepartureAt: true,
  teacherActiveAfterDepartureAt: true,
  jibriStopDepartureAt: true,
  jibriStopState: true,
  jibriStopAttemptedAt: true,
  jibriStopAttemptCount: true,
  jibriStopLastError: true,
  jibriStopSentAt: true,
  jibriStopRecorderLeftAt: true,
  jibriStopStreamInactiveAt: true,
  jibriStopIdleReadingCount: true,
  jibriStopLastIdleAt: true,
  jibriStopWatchUntil: true,
  jibriStopStreamId: true,
  jibriStopOverrideAt: true,
  class: { select: { teacherId: true } },
} as const;

type SessionRow = {
  id: string;
  lectureId: string | null;
  isActive: boolean;
  startedAt: Date;
  endedAt: Date | null;
  roomName: string;
  jitsiDomain: string;
  teacherDepartureAt: Date | null;
  teacherActiveAfterDepartureAt: Date | null;
  jibriStopDepartureAt: Date | null;
  jibriStopState: string | null;
  jibriStopAttemptedAt: Date | null;
  jibriStopAttemptCount: number;
  jibriStopLastError: string | null;
  jibriStopSentAt: Date | null;
  jibriStopRecorderLeftAt: Date | null;
  jibriStopStreamInactiveAt: Date | null;
  jibriStopIdleReadingCount: number;
  jibriStopLastIdleAt: Date | null;
  jibriStopWatchUntil: Date | null;
  jibriStopStreamId: string | null;
  jibriStopOverrideAt: Date | null;
  class: { teacherId: string };
};

async function readSession(id: string): Promise<SessionRow | null> {
  return prisma.classSession.findUnique({ where: { id }, select: sessionSelect }) as Promise<SessionRow | null>;
}

async function readFeatureRows(lectureId: string | null): Promise<FenceFeatureRow[]> {
  if (!lectureId) return [];

  const [recordings, lives] = await Promise.all([
    prisma.youTubeRecording.findMany({ where: { lectureId }, select: fenceFeatureSelect }),
    prisma.youTubeLiveBroadcast.findMany({ where: { lectureId }, select: fenceFeatureSelect }),
  ]);

  return [...recordings, ...lives] as FenceFeatureRow[];
}

/** Any active Recording / Live of the teacher, in any lecture (a new start since the release). */
async function teacherHasActiveFeature(teacherId: string): Promise<boolean> {
  const where = { status: { in: ACTIVE_FEATURE_STATUSES }, lecture: { class: { teacherId } } };
  const [recording, live] = await Promise.all([
    prisma.youTubeRecording.findFirst({ where, select: { id: true } }),
    prisma.youTubeLiveBroadcast.findFirst({ where, select: { id: true } }),
  ]);

  return Boolean(recording || live);
}

/** When the next attempt is due (null: the fence is released). */
export function nextJibriStopAttemptAt(state: {
  released: boolean;
  attemptedAt: Date | null;
  count: number;
  lastError: string | null;
}): Date | null {
  if (state.released) return null;
  if (state.count === 0 || !state.attemptedAt) return new Date(0);

  let delay = state.count >= JIBRI_STOP_MAX_ATTEMPTS
    ? JIBRI_STOP_UNRESOLVED_OBSERVE_MS
    : JIBRI_STOP_RETRY_DELAYS_MS[Math.min(state.count, JIBRI_STOP_RETRY_DELAYS_MS.length) - 1];

  if (state.lastError === "refused") delay = Math.max(delay, JIBRI_STOP_REFUSED_DELAY_MS);

  return new Date(state.attemptedAt.getTime() + delay);
}

/** The room as Jitsi names it (lowercase), or null if it is not a classroom room. */
function classroomRoom(session: SessionRow): string | null {
  const room = session.roomName.toLowerCase();
  return CLASSROOM_ROOM_NAME.test(room) ? room : null;
}

export type JibriStopSkipReason =
  | "no-session"
  | "no-fence"
  | "already-done"
  | "departure-pending"
  | "cancelled"
  | "other-domain"
  | "invalid-room"
  | "feature-active"
  | "not-due"
  | "changed";

type Plan =
  | { action: "skip"; reason: JibriStopSkipReason }
  | { action: "arm"; late?: boolean }
  | { action: "clear" }
  | { action: "watch" }
  | { action: "attempt"; mode: "stop" | "observe" };

/** May this attempt send the one STOP? (Otherwise: observe only.) */
function stopAllowed(session: SessionRow, now: Date, mode: JibriFenceMode): boolean {
  return mode === "on" &&
    session.jibriStopState !== "provisional" &&
    session.isActive &&
    session.lectureId !== null &&
    session.jibriStopSentAt === null &&
    session.teacherActiveAfterDepartureAt === null &&
    session.teacherDepartureAt !== null &&
    session.jibriStopDepartureAt !== null &&
    session.teacherDepartureAt.getTime() === session.jibriStopDepartureAt.getTime() &&
    departureState(session, now) === "confirmed";
}

function plan(session: SessionRow | null, rows: FenceFeatureRow[], now: Date, config: JibriStopConfig, mode: JibriFenceMode): Plan {
  if (!session) return { action: "skip", reason: "no-session" };

  if (session.jibriStopDepartureAt && fenceReleased(session)) {
    // Released: the pinned stream is still watched for a while.
    const watching = session.jibriStopWatchUntil !== null && now < session.jibriStopWatchUntil && session.jibriStopOverrideAt === null;

    if (watching) {
      const due = !session.jibriStopAttemptedAt || now.getTime() - session.jibriStopAttemptedAt.getTime() >= JIBRI_POST_RELEASE_CHECK_MS;
      return due ? { action: "watch" } : { action: "skip", reason: "not-due" };
    }
  }

  if (session.jibriStopState === "provisional" && fenceOpen(session)) {
    if (provisionalConfirmed(session, now)) {
      // Covered a generation: a confirmed fence. Covered none: nothing to stop.
      return departureCovered(session, session.jibriStopDepartureAt as Date, rows) ? { action: "arm" } : { action: "clear" };
    }

    const sameDeparture = session.teacherDepartureAt?.getTime() === session.jibriStopDepartureAt?.getTime();
    const state = sameDeparture ? departureState(session, now) : "cancelled";

    return state === "pending" ? { action: "skip", reason: "departure-pending" } : { action: "clear" };
  }

  if (!fenceOpen(session)) {
    if (armsFences(mode) && fenceDue(session, rows, now)) return { action: "arm" };
    if (armsFences(mode) && lateFenceDue(session, rows, now)) return { action: "arm", late: true };
    return { action: "skip", reason: session.jibriStopDepartureAt && fenceReleased(session) ? "already-done" : "no-fence" };
  }

  // Unobservable here: stays fenced (an administrator's override releases it).
  if (session.jitsiDomain.toLowerCase() !== config.jitsiDomain) return { action: "skip", reason: "other-domain" };
  if (!classroomRoom(session)) return { action: "skip", reason: "invalid-room" };

  // The departure's YouTube stop is still ending them (nothing new can start: fenced).
  if (featureActive(session, rows)) return { action: "skip", reason: "feature-active" };

  const due = nextJibriStopAttemptAt({
    released: false,
    attemptedAt: session.jibriStopAttemptedAt,
    count: session.jibriStopAttemptCount ?? 0,
    lastError: session.jibriStopLastError,
  });

  if (!due || now < due) return { action: "skip", reason: "not-due" };

  return { action: "attempt", mode: stopAllowed(session, now, mode) ? "stop" : "observe" };
}

/** YouTube's view of the pinned stream: is anything pushing into it? */
export type StreamIngest = "none" | "active" | "unknown";

/** The PINNED stream only: no pinned ID, not found, not authorized or an error: unknown. */
async function defaultReadStreamIngest(teacherId: string, streamId: string | null): Promise<StreamIngest> {
  if (!streamId) return "unknown";

  const connection = await prisma.youTubeConnection.findUnique({ where: { teacherId } });

  if (!connection || connection.status === "REAUTH_REQUIRED") return "unknown";

  // Another channel's token cannot see the pinned stream: "not found" (an
  // error) -> unknown. A newer stream of this connection is never read.
  const stream = await getYouTubeLiveStream(connection.refreshTokenEncrypted, streamId);
  const found = stream as { id?: string; status?: { streamStatus?: string } } | undefined;

  if (!found || (found.id !== undefined && found.id !== streamId)) return "unknown";

  const status = found.status?.streamStatus;

  if (status === "active") return "active";
  if (status === "inactive" || status === "ready") return "none";

  return "unknown";
}

export type JibriStopResult =
  | { status: "skipped"; reason: JibriStopSkipReason }
  | { status: "busy" }
  | { status: "error" }
  | { status: "cleared"; sessionId: string }
  | { status: "watched"; sessionId: string; ingest: StreamIngest; reopened: boolean; watchEnded: boolean }
  | {
    status: "attempted";
    sessionId: string;
    attempt: number;
    mode: "stop" | "observe";
    outcome: JibriStopOutcome | "token-failed";
    ingest: StreamIngest | null;
    state: JibriStopState;
    stopSent: boolean;
  };

export type JibriStopDeps = {
  controller: JibriController;
  config: JibriStopConfig;
  /** The shared mode the worker read (lib/jibri-fence-control.ts): "on" or "drain". */
  mode?: JibriFenceMode;
  /** System moderator token for the exact room (default: generateSystemJitsiToken). */
  mintToken?: (room: string, jitsiDomain: string) => Promise<string>;
  /** YouTube's view of the PINNED stream (default: liveStreams.list for that ID). */
  readStreamIngest?: (teacherId: string, streamId: string | null) => Promise<StreamIngest>;
  /** Records what a connection proved (default: the shared control's connection proof). */
  recordProof?: (proof: JibriConnectionProofRecord) => Promise<void>;
  /** The sweep's time box (default JIBRI_SWEEP_BUDGET_MS). */
  sweepBudgetMs?: number;
  at?: Date;
};

export type JibriConnectionProofRecord = { at: Date; authenticated: boolean; roomJoined: boolean; error: string | null };

/**
 * What an attempt's connection proved, or null if it never tried to
 * connect (aborted before, no token). Failure codes: connect-failed /
 * connect-timeout / wrong-server (the login), join-failed / join-timeout /
 * not-moderator (the room). Room observations (no focus, a recorder present)
 * are not connection failures.
 */
export function connectionProofOf(report: Pick<JibriStopReport, "outcome" | "connection">, at: Date): JibriConnectionProofRecord | null {
  const c = report.connection;

  if (!c?.attempted) return null;

  if (!c.authenticated) {
    const error = report.outcome === "wrong-server" ? "wrong-server" : report.outcome === "connect-failed" ? "connect-failed" : "connect-timeout";
    return { at, authenticated: false, roomJoined: false, error };
  }

  if (!c.joined) {
    const error = report.outcome === "join-failed" ? "join-failed"
      : report.outcome === "timeout" || report.outcome === "disconnected" ? "join-timeout" : null;
    return { at, authenticated: true, roomJoined: false, error };
  }

  return { at, authenticated: true, roomJoined: c.moderator, error: c.moderator ? null : "not-moderator" };
}

/**
 * One step for one class session's fence: clear a cancelled provisional
 * fence, arm / upgrade, attempt (stop or observe), or watch after release.
 * Never throws.
 */
export async function processJibriFence(sessionId: string, deps: JibriStopDeps): Promise<JibriStopResult> {
  const { config, controller } = deps;
  const mode: JibriFenceMode = deps.mode ?? "on";
  const mintToken = deps.mintToken ?? ((room: string, jitsiDomain: string) => generateSystemJitsiToken({ room, jitsiDomain }));
  const readStreamIngest = deps.readStreamIngest ?? defaultReadStreamIngest;
  const clock = async () => deps.at ?? await serverNow();

  if (mode === "off") return { status: "skipped", reason: "no-fence" };

  try {
    // Cheap checks first: no lock without something to do.
    const before = await bounded(readSession(sessionId), JIBRI_STOP_DB_TIMEOUT_MS);
    const first = plan(before, before ? await bounded(readFeatureRows(before.lectureId), JIBRI_STOP_DB_TIMEOUT_MS) : [], await clock(), config, mode);

    if (first.action === "skip" || !before) return { status: "skipped", reason: first.action === "skip" ? first.reason : "no-session" };

    const teacherId = before.class.teacherId;
    const lectureId = before.lectureId;
    const budget = { budgetMs: Math.min(JIBRI_STOP_LOCK_BUDGET_MS, youtubeTimeouts.lockTtlMs - youtubeTimeouts.lockSafetyMarginMs) };
    const underLocks = (operation: () => Promise<JibriStopResult>) =>
      withTeacherYouTubeLock(teacherId, () => (lectureId ? withLectureYouTubeLock(lectureId, operation, budget) : operation()), budget);

    return await underLocks(async (): Promise<JibriStopResult> => {
      // Everything below ends by the lock's deadline: each database step is
      // bounded (a hung query fails closed), the network gets what is left.
      const opDeadline = Date.now() + youtubeDeadlineRemainingMs();
      const dbMs = () => Math.max(0, Math.min(JIBRI_STOP_DB_TIMEOUT_MS, opDeadline - Date.now() - 1_000));

      let session = await bounded(readSession(sessionId), dbMs());
      let rows = session ? await bounded(readFeatureRows(session.lectureId), dbMs()) : [];
      let checked = plan(session, rows, await clock(), config, mode);

      if (checked.action === "clear" && session?.jibriStopDepartureAt) {
        await bounded(prisma.classSession.updateMany({
          where: { id: session.id, jibriStopState: "provisional", jibriStopDepartureAt: session.jibriStopDepartureAt },
          data: { jibriStopDepartureAt: null, jibriStopState: null, jibriStopStreamId: null, jibriStopOrigin: null },
        }), dbMs());

        return { status: "cleared", sessionId: session.id };
      }

      if (checked.action === "watch" && session) {
        return watchAfterRelease(session, teacherId, dbMs);
      }

      if (checked.action === "arm" && session?.teacherDepartureAt) {
        // A confirmed provisional fence keeps its own departure and pinned stream.
        const departureAt = session.jibriStopState === "provisional" && session.jibriStopDepartureAt
          ? session.jibriStopDepartureAt
          : session.teacherDepartureAt;

        await bounded(armJibriFence(session.id, departureAt, {
          armNew: armsFences(mode),
          origin: checked.late ? "late" : "worker",
          late: checked.late === true,
        }), dbMs());
        session = await bounded(readSession(sessionId), dbMs());
        rows = session ? await bounded(readFeatureRows(session.lectureId), dbMs()) : [];
        checked = plan(session, rows, await clock(), config, mode);
      }

      if (checked.action !== "attempt" || !session) {
        return { status: "skipped", reason: checked.action === "skip" ? checked.reason : "changed" };
      }

      const current = session;
      const attemptMode = checked.mode;
      const fenceAt = current.jibriStopDepartureAt as Date;
      const room = classroomRoom(current) as string;
      const attempt = (current.jibriStopAttemptCount ?? 0) + 1;
      const attemptedAt = await clock();

      // The attempt is recorded before anything is sent; conditional on the
      // state read (another process's attempt or an override changes it).
      const { count: claimed } = await bounded(prisma.classSession.updateMany({
        where: {
          id: current.id,
          jibriStopDepartureAt: fenceAt,
          jibriStopAttemptCount: current.jibriStopAttemptCount,
          jibriStopOverrideAt: null,
          jibriStopState: { notIn: ["confirmed", "not-running", "provisional"] },
        },
        data: { jibriStopAttemptedAt: attemptedAt, jibriStopAttemptCount: attempt },
      }), dbMs());

      if (claimed === 0) return { status: "skipped", reason: "changed" };

      const finish = async (
        outcome: JibriStopOutcome | "token-failed",
        stopSent: boolean,
        ingest: StreamIngest | null
      ): Promise<JibriStopResult> => {
        const now = await clock();
        const roomClear = outcome === "recorder-left" || outcome === "not-running";
        const sent = stopSent || current.jibriStopSentAt !== null;

        // The idle series: kept only while every look agrees.
        let firstIdleAt = current.jibriStopStreamInactiveAt;
        let lastIdleAt = current.jibriStopLastIdleAt;
        let idleCount = current.jibriStopIdleReadingCount ?? 0;
        let released: "confirmed" | "not-running" | null = null;

        if (roomClear && ingest === "none") {
          if (!firstIdleAt || !lastIdleAt || idleCount === 0) {
            firstIdleAt = now;
            lastIdleAt = now;
            idleCount = 1;
          } else if (now.getTime() - lastIdleAt.getTime() >= JIBRI_STREAM_IDLE_GAP_MS) {
            lastIdleAt = now;
            idleCount += 1;
          }

          if (idleCount >= JIBRI_STREAM_IDLE_READINGS && lastIdleAt.getTime() - firstIdleAt.getTime() >= JIBRI_STREAM_IDLE_SPAN_MS) {
            released = sent ? "confirmed" : "not-running";
          }
        } else if (outcome === "recorder-present" || roomClear) {
          // The recorder is still there, or the stream is (or may be) in use.
          firstIdleAt = null;
          lastIdleAt = null;
          idleCount = 0;
        }

        const state: JibriStopState = released
          ?? (idleCount > 0 ? "verifying"
            : attempt >= JIBRI_STOP_MAX_ATTEMPTS ? "unresolved"
              : sent ? "stop-sent" : "pending");

        try {
          await bounded(prisma.classSession.updateMany({
            where: { id: current.id, jibriStopDepartureAt: fenceAt, jibriStopAttemptCount: attempt, jibriStopOverrideAt: null },
            data: {
              jibriStopState: state,
              jibriStopLastError: released ? null : outcome,
              jibriStopStreamInactiveAt: firstIdleAt,
              jibriStopLastIdleAt: lastIdleAt,
              jibriStopIdleReadingCount: idleCount,
              ...(outcome === "recorder-left" ? { jibriStopRecorderLeftAt: now } : {}),
              ...(released ? { jibriStopConfirmedAt: now, jibriStopWatchUntil: new Date(now.getTime() + JIBRI_POST_RELEASE_WATCH_MS) } : {}),
            },
          }), dbMs());
        } catch {
          // Not recorded: the fence stays as it was (never released).
          console.error("Jibri shutdown fence: attempt outcome not recorded", { sessionId: current.id, attempt, outcome });
          return { status: "attempted", sessionId: current.id, attempt, mode: attemptMode, outcome, ingest, state: (current.jibriStopState ?? "pending") as JibriStopState, stopSent };
        }

        const log = released ? console.log : console.warn;

        // Codes only: never the token, the room's occupants or their names.
        log("Jibri shutdown fence", { sessionId: current.id, attempt, mode: attemptMode, outcome, ingest, idleCount, stopSent, state });

        return { status: "attempted", sessionId: current.id, attempt, mode: attemptMode, outcome, ingest, state, stopSent };
      };

      let token: string;

      try {
        token = await mintToken(room, config.jitsiDomain);
      } catch {
        return finish("token-failed", false, null);
      }

      // Re-checked by the controller before connecting, after connecting,
      // after joining and right before a STOP. Bounded; a timeout or an
      // error means abort.
      const shouldAbort = async () => {
        try {
          return await bounded((async () => {
            const latest = await readSession(current.id);

            if (!latest || !fenceOpen(latest) || latest.jibriStopDepartureAt?.getTime() !== fenceAt.getTime()) return true;
            if (attemptMode === "observe") return false;

            const latestRows = await readFeatureRows(latest.lectureId);

            return featureActive(latest, latestRows) || !stopAllowed(latest, await clock(), mode);
          })(), Math.min(JIBRI_STOP_CHECK_TIMEOUT_MS, dbMs()));
        } catch {
          return true;
        }
      };

      // Durable BEFORE the one STOP goes out (not written: no STOP).
      const beforeStop = async () => {
        try {
          const { count } = await bounded(prisma.classSession.updateMany({
            where: {
              id: current.id,
              isActive: true,
              teacherActiveAfterDepartureAt: null,
              teacherDepartureAt: fenceAt,
              jibriStopDepartureAt: fenceAt,
              jibriStopAttemptCount: attempt,
              jibriStopSentAt: null,
              jibriStopOverrideAt: null,
            },
            data: { jibriStopSentAt: await clock(), jibriStopState: "stop-sent" },
          }), Math.min(JIBRI_STOP_CHECK_TIMEOUT_MS, dbMs()));

          return count > 0;
        } catch {
          return false;
        }
      };

      // What is left after the stream read's and the outcome write's reserve.
      const xmppBudget = Math.min(JIBRI_STOP_XMPP_BUDGET_MS, opDeadline - Date.now() - 2 * JIBRI_STOP_DB_TIMEOUT_MS - 1_000);

      const report = await controller.stopStreamInRoom({
        websocketUrl: config.websocketUrl,
        xmppDomain: config.jitsiDomain,
        mucDomain: config.mucDomain,
        recorderDomain: config.recorderDomain,
        focusJid: config.focusJid,
        roomName: room,
        token,
        deadlineAt: Date.now() + Math.max(0, xmppBudget),
        mode: attemptMode,
        shouldAbort,
        ...(attemptMode === "stop" ? { beforeStop } : {}),
      });

      // Connection proof for the worker's health (best effort, bounded).
      const proof = connectionProofOf(report, await clock());

      if (proof) {
        await bounded((deps.recordProof ?? recordJibriConnectionProof)(proof), Math.min(JIBRI_STOP_CHECK_TIMEOUT_MS, dbMs()))
          .catch(() => console.error("Jibri shutdown fence: connection proof not recorded", { sessionId: current.id }));
      }

      // The independent check (the pinned stream), only once the room itself is clear.
      let ingest: StreamIngest | null = null;

      if (report.outcome === "recorder-left" || report.outcome === "not-running") {
        ingest = await bounded(readStreamIngest(teacherId, current.jibriStopStreamId), dbMs()).catch((): StreamIngest => "unknown");
      }

      return finish(report.outcome, report.stopSent, ingest);
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "YOUTUBE_OPERATION_IN_PROGRESS") {
      return { status: "busy" };
    }

    console.error("Jibri shutdown fence: attempt failed; tried again later:", {
      sessionId,
      error: error instanceof Error ? error.name : "unknown",
    });

    return { status: "error" };
  }

  /** After a release (under the locks): the pinned stream resuming re-opens the fence. */
  async function watchAfterRelease(
    session: SessionRow,
    teacherId: string,
    dbMs: () => number
  ): Promise<JibriStopResult> {
    const now = await clock();
    const ingest = await bounded(readStreamIngest(teacherId, session.jibriStopStreamId), dbMs()).catch((): StreamIngest => "unknown");
    const where = { id: session.id, jibriStopDepartureAt: session.jibriStopDepartureAt, jibriStopState: session.jibriStopState, jibriStopOverrideAt: null };

    if (ingest === "active") {
      if (await bounded(teacherHasActiveFeature(teacherId), dbMs())) {
        // The teacher started something since: its ingest is expected.
        await bounded(prisma.classSession.updateMany({ where, data: { jibriStopWatchUntil: null, jibriStopAttemptedAt: now } }), dbMs());
        return { status: "watched", sessionId: session.id, ingest, reopened: false, watchEnded: true };
      }

      // Ingest resumed with nothing of the teacher's running: re-opened.
      await bounded(prisma.classSession.updateMany({
        where,
        data: {
          jibriStopState: session.jibriStopSentAt ? "stop-sent" : "pending",
          jibriStopConfirmedAt: null,
          jibriStopWatchUntil: null,
          jibriStopStreamInactiveAt: null,
          jibriStopLastIdleAt: null,
          jibriStopIdleReadingCount: 0,
          jibriStopAttemptCount: 0,
          jibriStopAttemptedAt: now,
          jibriStopLastError: "stream-resumed",
        },
      }), dbMs());

      console.warn("Jibri shutdown fence re-opened: the pinned stream received data again after the release", { sessionId: session.id });

      return { status: "watched", sessionId: session.id, ingest, reopened: true, watchEnded: false };
    }

    await bounded(prisma.classSession.updateMany({ where, data: { jibriStopAttemptedAt: now } }), dbMs());

    return { status: "watched", sessionId: session.id, ingest, reopened: false, watchEnded: false };
  }
}

/** The lecture's newest active session's fence (a convenience for one lecture). */
export async function stopJibriForDepartedSession(lectureId: string, deps: JibriStopDeps): Promise<JibriStopResult> {
  try {
    const session = await bounded(prisma.classSession.findFirst({
      where: { lectureId, isActive: true },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    }), JIBRI_STOP_DB_TIMEOUT_MS);

    return session ? processJibriFence(session.id, deps) : { status: "skipped", reason: "no-session" };
  } catch {
    return { status: "error" };
  }
}

/** How long after its end an unfenced departed session is still looked at (late fences). */
export const JIBRI_LATE_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Sessions to look at: every open fence (provisional included, active or
 * not), released fences still watched, active sessions with a tab-close
 * signal (a fence may be due), and sessions that ENDED recently after a
 * tab-close signal without any fence (a late fence may be due). Least
 * recently attempted first (never attempted first).
 */
async function sessionsToCheck(now: Date): Promise<string[]> {
  const sessions = await prisma.classSession.findMany({
    where: {
      OR: [
        { jibriStopDepartureAt: { not: null }, jibriStopOverrideAt: null, jibriStopState: { notIn: ["confirmed", "not-running"] } },
        { jibriStopWatchUntil: { gt: now }, jibriStopOverrideAt: null },
        { isActive: true, teacherDepartureAt: { not: null }, lectureId: { not: null } },
        {
          isActive: false,
          teacherDepartureAt: { not: null },
          lectureId: { not: null },
          jibriStopDepartureAt: null,
          endedAt: { gte: new Date(now.getTime() - JIBRI_LATE_DISCOVERY_WINDOW_MS) },
        },
      ],
    },
    orderBy: { jibriStopAttemptedAt: { sort: "asc", nulls: "first" } },
    select: { id: true },
  });

  return Array.from(new Set(sessions.map(row => row.id)));
}

/**
 * One sweep (the worker's): candidate sessions one at a time, within the
 * sweep's time box (the rest wait for the next sweep). Throws only if the
 * candidates cannot be listed (the worker then records no sweep progress);
 * each session's step never throws.
 */
export async function sweepJibriStops(
  deps: JibriStopDeps
): Promise<{ sessionId: string; result: JibriStopResult }[]> {
  let sessionIds: string[];

  try {
    sessionIds = await bounded(sessionsToCheck(deps.at ?? await serverNow()), JIBRI_STOP_DB_TIMEOUT_MS);
  } catch (error) {
    console.error("Jibri stop sweep could not list sessions:", error instanceof Error ? error.name : "unknown");
    throw error;
  }

  const results: { sessionId: string; result: JibriStopResult }[] = [];
  const startedAt = Date.now();
  const budgetMs = deps.sweepBudgetMs ?? JIBRI_SWEEP_BUDGET_MS;

  for (const sessionId of sessionIds) {
    if (Date.now() - startedAt >= budgetMs) break;
    results.push({ sessionId, result: await processJibriFence(sessionId, deps) });
  }

  return results;
}
