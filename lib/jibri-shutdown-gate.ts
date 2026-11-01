import { YouTubeBroadcastStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import { serverNow } from "@/lib/server-clock";
import { departureState } from "@/lib/teacher-presence";
import { armsFences, jibriWorkerHealth, readJibriFenceControl, type JibriFenceMode } from "@/lib/jibri-fence-control";
import { freshFenceData, lateFencePin, type JibriFenceOrigin } from "@/lib/jibri-fence-provisional";
import { ACTIVE_FEATURE_STATUSES } from "@/lib/youtube-feature-state";

/*
 * Jibri shutdown fence. All of a teacher's lectures share ONE reusable
 * YouTube stream key, and a classroom's Jibri keeps streaming into it after
 * the teacher's tab closed. From the moment a confirmed departure could
 * leave such an orphaned Jibri, no new Recording / Live start of that
 * TEACHER (any lecture, any session) may begin, until the shutdown is
 * established by evidence (the worker) or an administrator overrides it.
 * Never by time.
 *
 * A session fences the teacher while
 * - its fence is ENFORCED: armed (jibriStopDepartureAt), not released
 *   (confirmed / not-running / overridden), and either confirmed (any state
 *   but "provisional") or provisional with its departure now confirmed
 *   (the tab-close signal wrote it: lib/jibri-fence-provisional.ts). Active
 *   or DEACTIVATED sessions alike (End Session, a replacing session), and
 *   whatever closed the YouTube rows meanwhile. Enforced in EVERY mode: a
 *   mode change never silently drops an open fence;
 *   A provisional fence is enforced only if its departure COVERED a
 *   Recording / Live generation (departureCoversRow);
 * - or (mode "on" only, not armed) it is active, its departure confirmed,
 *   and the departure covered a feature now closed (a fallback for a
 *   signal recorded without its provisional fence);
 * - or (mode "on" only, not armed: a LATE fence) it ENDED within the last
 *   JIBRI_LATE_FENCE_WINDOW_MS (End Session, a replacing session, any
 *   reason) after a confirmed departure the teacher never came back from
 *   before the end, and that departure covered a generation (rows already
 *   COMPLETE included). The recovery for a departure recorded without its
 *   fence. Found from durable facts only (teacherDepartureAt,
 *   teacherActiveAfterDepartureAt, endedAt, the rows' generationStartedAt /
 *   endedAt), which End Session never changes; a session ended WITHOUT a
 *   tab-close signal never qualifies. A start that finds one ARMS it
 *   (durably) before refusing, so a later generation (which rewrites
 *   generationStartedAt) can never erase the evidence: every start passes
 *   this gate, under the teacher's lock, before it writes its row.
 *
 * Arming: the tab-close signal (provisional, same update), the departure's
 * YouTube stop BEFORE it closes any covered row (armJibriFence: upgrades
 * the provisional fence, or arms a new one), and the worker.
 *
 * Ordering with starts (startInCurrentSession, under the teacher's and the
 * lecture's locks): a start checks the stream (assertStreamFreeForLecture)
 * BEFORE this fence; a departure arms the fence BEFORE it closes the rows
 * that check sees. A start either still sees the rows active (refused) or
 * sees the fence armed earlier (refused here).
 *
 * The lookup reads only OPEN fences in SQL (released history is never
 * scanned; index ClassSession(classId, jibriStopState)).
 */

export const SHUTDOWN_ESTABLISHED: readonly string[] = ["confirmed", "not-running"];

/** How long after a session ended a missing fence is still recovered (late fence). */
export const JIBRI_LATE_FENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

const OPEN_NON_FEATURE: YouTubeBroadcastStatus[] = [YouTubeBroadcastStatus.CREATED, YouTubeBroadcastStatus.TESTING];

export const fenceSessionSelect = {
  id: true,
  lectureId: true,
  isActive: true,
  startedAt: true,
  endedAt: true,
  teacherDepartureAt: true,
  teacherActiveAfterDepartureAt: true,
  jibriStopDepartureAt: true,
  jibriStopState: true,
  jibriStopOverrideAt: true,
} as const;

export type FenceSession = {
  id: string;
  lectureId: string | null;
  isActive: boolean;
  startedAt: Date;
  endedAt?: Date | null;
  teacherDepartureAt: Date | null;
  teacherActiveAfterDepartureAt: Date | null;
  jibriStopDepartureAt: Date | null;
  jibriStopState: string | null;
  jibriStopOverrideAt: Date | null;
};

export type FenceFeatureRow = {
  lectureId?: string;
  status: YouTubeBroadcastStatus;
  createdAt: Date;
  generationStartedAt: Date | null;
  endedAt: Date | null;
};

export const fenceFeatureSelect = { lectureId: true, status: true, createdAt: true, generationStartedAt: true, endedAt: true } as const;

/** The armed fence was released by evidence or by an administrator. */
export function fenceReleased(session: Pick<FenceSession, "jibriStopState" | "jibriStopOverrideAt">): boolean {
  return session.jibriStopOverrideAt !== null || SHUTDOWN_ESTABLISHED.includes(session.jibriStopState ?? "");
}

/** Armed and not released (provisional ones included). */
export function fenceOpen(session: FenceSession): boolean {
  return session.jibriStopDepartureAt !== null && !fenceReleased(session);
}

/**
 * Did the departure at `departureAt` cover this feature generation? From
 * durable timestamps only (written by every start under the teacher's and
 * the lecture's locks), so no read-then-write race can let a feature
 * escape:
 * - the row belongs to this session (created at or after its start) and
 *   its generation started before the session ended;
 * - it was still running at the departure: not ended, or ended at or after
 *   it (rows COMPLETE since are covered);
 * - its generation started BEFORE the departure, or AFTER it without the
 *   teacher's activity having been recorded first (a start racing the
 *   tab-close signal: every ordinary start records the teacher's activity
 *   before writing its row, which makes a later generation the returned
 *   teacher's own).
 */
export function departureCoversRow(
  session: Pick<FenceSession, "startedAt" | "endedAt" | "teacherActiveAfterDepartureAt">,
  departureAt: Date,
  row: FenceFeatureRow
): boolean {
  const generation = row.generationStartedAt ?? row.createdAt;

  if (row.createdAt < session.startedAt) return false;
  if (session.endedAt && generation > session.endedAt) return false;
  if (row.endedAt !== null && row.endedAt < departureAt) return false;
  if (generation < departureAt) return true;

  const back = session.teacherActiveAfterDepartureAt;

  return back === null || back > generation;
}

export function departureCovered(
  session: Pick<FenceSession, "startedAt" | "endedAt" | "teacherActiveAfterDepartureAt">,
  departureAt: Date,
  rows: FenceFeatureRow[]
): boolean {
  return rows.some(row => departureCoversRow(session, departureAt, row));
}

/** A provisional fence whose departure is now confirmed. */
export function provisionalConfirmed(session: FenceSession, now: Date): boolean {
  return session.jibriStopState === "provisional" &&
    session.jibriStopDepartureAt !== null &&
    session.teacherDepartureAt?.getTime() === session.jibriStopDepartureAt.getTime() &&
    departureState(session, now) === "confirmed";
}

/**
 * Open and in force: confirmed, or provisional with its departure confirmed
 * and covering a generation. Without `rows` a confirmed provisional fence
 * counts as covering (fails closed).
 */
export function fenceEnforced(session: FenceSession, now: Date, rows?: FenceFeatureRow[]): boolean {
  if (!fenceOpen(session)) return false;
  if (session.jibriStopState !== "provisional") return true;
  if (!provisionalConfirmed(session, now)) return false;

  return rows === undefined || departureCovered(session, session.jibriStopDepartureAt as Date, rows);
}

/** A row of the session the departure covered that has been closed since. */
export function coveredFeatureClosed(session: FenceSession, rows: FenceFeatureRow[]): boolean {
  const departureAt = session.teacherDepartureAt;

  if (!departureAt) return false;

  return rows.some(row =>
    row.createdAt >= session.startedAt &&
    (row.generationStartedAt ?? row.createdAt) < departureAt &&
    row.endedAt !== null &&
    row.endedAt >= departureAt);
}

/** Any Recording / Live row of these rows is active (or a CREATED / TESTING row of the session is open). */
export function featureActive(session: Pick<FenceSession, "startedAt">, rows: FenceFeatureRow[]): boolean {
  return rows.some(row =>
    ACTIVE_FEATURE_STATUSES.includes(row.status) ||
    (row.endedAt === null && OPEN_NON_FEATURE.includes(row.status) && row.createdAt >= session.startedAt));
}

/** No fence for the session's current departure yet (none, a released earlier one, or a provisional one of an earlier departure). */
function unarmedForDeparture(session: FenceSession): boolean {
  const departureAt = session.teacherDepartureAt;
  const armedAt = session.jibriStopDepartureAt;

  if (!departureAt) return false;
  if (!armedAt) return true;
  if (armedAt.getTime() >= departureAt.getTime()) return false;

  return fenceReleased(session) || session.jibriStopState === "provisional";
}

/**
 * Not armed (or only provisionally) for the current departure, but it must
 * be armed now: active, the departure confirmed, a covered feature closed,
 * and no fence for this departure (none, a released one of an earlier
 * departure, or a cancelled provisional one).
 */
export function fenceDue(session: FenceSession, rows: FenceFeatureRow[], now: Date): boolean {
  if (!session.isActive || !session.teacherDepartureAt) return false;
  if (departureState(session, now) !== "confirmed") return false;

  const armedAt = session.jibriStopDepartureAt;

  if (armedAt && fenceOpen(session) && session.jibriStopState !== "provisional") return false;
  if (armedAt && fenceReleased(session) && !(armedAt < session.teacherDepartureAt)) return false;

  return coveredFeatureClosed(session, rows);
}

/**
 * A LATE fence is due (see the header): the session ended recently after a
 * confirmed departure, with no teacher return before the end, the departure
 * covered a generation, and no fence was armed for it.
 */
export function lateFenceDue(session: FenceSession, rows: FenceFeatureRow[], now: Date): boolean {
  const departureAt = session.teacherDepartureAt;
  const endedAt = session.endedAt ?? null;

  if (session.isActive || !departureAt || !endedAt || !session.lectureId) return false;
  if (now.getTime() - endedAt.getTime() > JIBRI_LATE_FENCE_WINDOW_MS) return false;
  // The departure happened while the session ran.
  if (departureAt.getTime() > endedAt.getTime()) return false;

  // The teacher came back before the session ended: their page stopped its own Jibri.
  const back = session.teacherActiveAfterDepartureAt;

  if (back && back.getTime() <= endedAt.getTime()) return false;
  // Ended sessions record no activity any more: confirmed once its window passed.
  if (departureState(session, now) !== "confirmed") return false;
  if (!unarmedForDeparture(session)) return false;

  return departureCovered(session, departureAt, rows);
}

export type FenceKind = "enforced" | "due" | "late";

/** Why the session fences the teacher's stream (see the header), or null. */
export function sessionFenceKind(session: FenceSession, rows: FenceFeatureRow[], now: Date, mode: JibriFenceMode): FenceKind | null {
  if (fenceEnforced(session, now, rows)) return "enforced";
  if (!armsFences(mode)) return null;
  if (fenceDue(session, rows, now)) return "due";
  if (lateFenceDue(session, rows, now)) return "late";

  return null;
}

/** The session fences the teacher's stream (see the header). */
export function sessionFenced(session: FenceSession, rows: FenceFeatureRow[], now: Date, mode: JibriFenceMode): boolean {
  return sessionFenceKind(session, rows, now, mode) !== null;
}

/**
 * Open (unreleased) fences, active or not; with the mode on also active
 * departed sessions and recently ENDED departed sessions (late fences).
 * Released history older than the late window is never read.
 */
async function readTeacherFenceState(teacherId: string, mode: JibriFenceMode, now: Date) {
  const sessions = await prisma.classSession.findMany({
    where: {
      class: { teacherId },
      OR: [
        { jibriStopDepartureAt: { not: null }, jibriStopOverrideAt: null, jibriStopState: { notIn: [...SHUTDOWN_ESTABLISHED] } },
        ...(armsFences(mode)
          ? [
            { isActive: true, teacherDepartureAt: { not: null } },
            {
              isActive: false,
              teacherDepartureAt: { not: null },
              lectureId: { not: null },
              endedAt: { gte: new Date(now.getTime() - JIBRI_LATE_FENCE_WINDOW_MS) },
            },
          ]
          : []),
      ],
    },
    select: fenceSessionSelect,
  }) as FenceSession[];

  // Rows are needed for provisional fences (coverage) and unarmed candidates.
  const lectureIds = Array.from(new Set(sessions
    .filter(s => s.lectureId && (s.jibriStopState === "provisional" || !fenceOpen(s)))
    .map(s => s.lectureId as string)));

  const rows: FenceFeatureRow[] = lectureIds.length === 0 ? [] : (await Promise.all([
    prisma.youTubeRecording.findMany({ where: { lectureId: { in: lectureIds } }, select: fenceFeatureSelect }),
    prisma.youTubeLiveBroadcast.findMany({ where: { lectureId: { in: lectureIds } }, select: fenceFeatureSelect }),
  ])).flat() as FenceFeatureRow[];

  return { sessions, rows };
}

type FoundFence = { session: FenceSession; kind: FenceKind };

async function findTeacherFenceWithKind(teacherId: string, now: Date, mode: JibriFenceMode): Promise<FoundFence | null> {
  const { sessions, rows } = await readTeacherFenceState(teacherId, mode, now);

  for (const session of sessions) {
    const kind = sessionFenceKind(session, rows.filter(r => r.lectureId === session.lectureId), now, mode);

    if (kind) return { session, kind };
  }

  return null;
}

/** The first session fencing the teacher's stream, or null. */
export async function findTeacherFence(teacherId: string, at?: Date, mode?: JibriFenceMode): Promise<FenceSession | null> {
  const now = at ?? await serverNow();
  const currentMode = mode ?? (await readJibriFenceControl()).mode;

  return (await findTeacherFenceWithKind(teacherId, now, currentMode))?.session ?? null;
}

export type TeacherFenceStatus =
  | { blocked: false }
  | {
    blocked: true;
    /** JIBRI_SHUTDOWN_IN_PROGRESS | JIBRI_SHUTDOWN_WORKER_UNAVAILABLE | JIBRI_SHUTDOWN_NEEDS_ADMIN */
    code: string;
    message: string;
    status: number;
    /** The tab close the fence belongs to. */
    since: string | null;
    state: string | null;
  };

async function statusOf(teacherId: string, now: Date): Promise<{ status: TeacherFenceStatus; found: FoundFence | null }> {
  const control = await readJibriFenceControl();
  const found = await findTeacherFenceWithKind(teacherId, now, control.mode);

  if (!found) return { status: { blocked: false }, found: null };

  const fence = found.session;
  const base = {
    blocked: true as const,
    since: (found.kind === "enforced" ? fence.jibriStopDepartureAt : fence.teacherDepartureAt)?.toISOString() ?? null,
    state: found.kind === "enforced" ? fence.jibriStopState : "pending",
  };

  if (control.mode === "off") {
    return {
      found,
      status: {
        ...base,
        code: "JIBRI_SHUTDOWN_NEEDS_ADMIN",
        status: 409,
        message: "A classroom stream from a class you left earlier has not been confirmed stopped, and automatic checking is switched off. An administrator must review it before you can start Recording or Live again.",
      },
    };
  }

  if (!jibriWorkerHealth(control, now).healthy) {
    return {
      found,
      status: {
        ...base,
        code: "JIBRI_SHUTDOWN_WORKER_UNAVAILABLE",
        status: 503,
        message: "A classroom stream from a class you left earlier has not been confirmed stopped, and the service that checks it is not running right now. Please try again later or contact an administrator.",
      },
    };
  }

  return {
    found,
    status: {
      ...base,
      code: "JIBRI_SHUTDOWN_IN_PROGRESS",
      status: 409,
      message: "A classroom stream from a class you left earlier is still being checked and has not been confirmed stopped yet, so nothing was started. Please try again in a few minutes.",
    },
  };
}

/** Whether (and why) the teacher's new starts are refused now (read only). */
export async function teacherFenceStatus(teacherId: string, at?: Date): Promise<TeacherFenceStatus> {
  return (await statusOf(teacherId, at ?? await serverNow())).status;
}

/**
 * Refuses a start while the teacher's stream is fenced (409, or 503 when
 * the worker that would release it is not running). Call under the
 * teacher's lock, AFTER assertStreamFreeForLecture and BEFORE the start
 * writes any row (see the ordering above). A fence found but not armed yet
 * (due, or late) is ARMED here first (best effort: the refusal stands
 * either way), so the start's own generation can never erase its evidence.
 */
export async function assertNoJibriShutdownInProgress(teacherId: string, at?: Date): Promise<void> {
  const { status, found } = await statusOf(teacherId, at ?? await serverNow());

  if (!status.blocked) return;

  if (found && found.kind !== "enforced" && found.session.teacherDepartureAt) {
    await armJibriFence(found.session.id, found.session.teacherDepartureAt, {
      armNew: true,
      origin: found.kind === "late" ? "late" : "start",
      late: found.kind === "late",
    }).catch(error => console.error("Could not arm the Jibri shutdown fence found by a start:", { sessionId: found.session.id, error }));
  }

  throw new AppError(status.message, status.status, status.code);
}

/**
 * Makes the session's fence for `departureAt` a confirmed one: upgrades its
 * provisional fence for that departure (keeping the pinned stream), or arms
 * a new fence unless one is armed for it already or an earlier fence is
 * still open (it continues; a provisional one of an earlier departure is
 * replaced but its pinned stream kept). A fence released for the SAME
 * departure is never re-armed. Pins the teacher's current reusable stream
 * for a new fence (a late one only if the connection is unchanged since the
 * departure: lateFencePin). Returns whether anything was written. Throws on
 * a database error (callers fail closed: nothing is closed without the
 * fence).
 */
export async function armJibriFence(
  sessionId: string,
  departureAt: Date,
  options: { armNew?: boolean; origin?: JibriFenceOrigin; late?: boolean } = {}
): Promise<boolean> {
  const upgraded = await prisma.classSession.updateMany({
    where: { id: sessionId, jibriStopDepartureAt: departureAt, jibriStopState: "provisional", jibriStopOverrideAt: null },
    data: { jibriStopState: "pending" },
  });

  if (upgraded.count > 0) return true;
  // Mode off / drain: an existing (provisional) fence is kept, nothing new is armed.
  if (options.armNew === false) return false;

  const session = await prisma.classSession.findUnique({
    where: { id: sessionId },
    select: {
      jibriStopDepartureAt: true,
      jibriStopState: true,
      jibriStopOverrideAt: true,
      jibriStopStreamId: true,
      class: { select: { teacherId: true } },
    },
  });

  if (!session) return false;

  const replacingProvisional = session.jibriStopState === "provisional" && session.jibriStopOverrideAt === null &&
    session.jibriStopDepartureAt !== null && session.jibriStopDepartureAt < departureAt;
  const connection = await prisma.youTubeConnection.findUnique({ where: { teacherId: session.class.teacherId } });
  const pin = replacingProvisional && session.jibriStopStreamId
    ? session.jibriStopStreamId
    : options.late ? lateFencePin(connection, departureAt) : connection?.liveStreamId ?? null;

  const { count } = await prisma.classSession.updateMany({
    where: {
      id: sessionId,
      OR: [
        { jibriStopDepartureAt: null },
        // A provisional fence of an earlier departure (its pin is kept above).
        { jibriStopDepartureAt: { lt: departureAt }, jibriStopState: "provisional" },
        { jibriStopDepartureAt: { lt: departureAt }, jibriStopState: { in: [...SHUTDOWN_ESTABLISHED] } },
        { jibriStopDepartureAt: { lt: departureAt }, jibriStopOverrideAt: { not: null } },
      ],
    },
    data: freshFenceData(departureAt, "pending", pin, options.origin ?? "departure"),
  });

  return count > 0;
}
