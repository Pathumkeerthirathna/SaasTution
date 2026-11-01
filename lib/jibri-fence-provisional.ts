import { prisma } from "@/lib/prisma";
import { armsFences, readJibriFenceControl } from "@/lib/jibri-fence-control";

/*
 * The provisional shutdown fence (lib/jibri-shutdown-gate.ts), written in
 * the SAME database update as the teacher's tab-close signal
 * (lib/teacher-presence.ts recordTeacherDepartureSignal), so a departure
 * that may leave an orphaned Jibri always has a durable fence: whatever
 * closes the session's YouTube rows afterwards (the departure stop, YouTube
 * itself, reconciliation) and whatever deactivates the session (End
 * Session, a replacing session), the fence stays on the row.
 *
 * - Created with the mode "on" for EVERY tab-close signal of a lecture's
 *   session, whatever its YouTube rows look like at that moment. Deciding
 *   from a read made before the signal's write would race with a start
 *   writing its row in between (the feature would escape the fence). The
 *   question "did this departure cover a Recording / Live generation?" is
 *   answered later instead, from durable timestamps (the rows'
 *   generationStartedAt / endedAt against the departure:
 *   departureCoversRow in lib/jibri-shutdown-gate.ts), under the teacher's
 *   and the lecture's locks, which every start holds while it writes.
 * - Not enforced until the departure is confirmed (the 15 s reload window
 *   has passed without teacher activity) AND it covered a generation;
 *   cancelled (cleared) by activity within the window, or by the page
 *   withdrawing its signal; cleared by the worker once confirmed if it
 *   covered none.
 * - Pins the teacher's reusable YouTube stream ID at that moment: the only
 *   stream the worker will ever check for this fence.
 * - A fence already open is never replaced: a confirmed fence (pending, or
 *   an enforced provisional one, which is upgraded to pending so a later
 *   signal cannot un-confirm it) continues as it is.
 *
 * No import of lib/teacher-presence.ts (it imports this module); callers
 * pass the departure-state test.
 */

const RELEASED: readonly string[] = ["confirmed", "not-running"];

export type JibriFenceOrigin = "signal" | "departure" | "worker" | "late" | "start";

/** Columns a new fence starts from (earlier evidence and override cleared). */
export function freshFenceData(
  departureAt: Date,
  state: "provisional" | "pending",
  streamId: string | null,
  origin: JibriFenceOrigin = "departure"
) {
  return {
    jibriStopOrigin: origin,
    jibriStopDepartureAt: departureAt,
    jibriStopState: state,
    jibriStopAttemptedAt: null,
    jibriStopAttemptCount: 0,
    jibriStopLastError: null,
    jibriStopConfirmedAt: null,
    jibriStopSentAt: null,
    jibriStopRecorderLeftAt: null,
    jibriStopStreamInactiveAt: null,
    jibriStopIdleReadingCount: 0,
    jibriStopLastIdleAt: null,
    jibriStopWatchUntil: null,
    jibriStopOverrideAt: null,
    jibriStopOverrideBy: null,
    jibriStopOverrideReason: null,
    jibriStopStreamId: streamId,
  };
}

export type FenceStateFields = {
  teacherDepartureAt: Date | null;
  teacherActiveAfterDepartureAt: Date | null;
  jibriStopDepartureAt: Date | null;
  jibriStopState: string | null;
  jibriStopOverrideAt: Date | null;
};

const released = (s: FenceStateFields) => s.jibriStopOverrideAt !== null || RELEASED.includes(s.jibriStopState ?? "");

/**
 * What the tab-close signal's update must also write for the fence, and the
 * fence state it was computed from (added to that update's condition, so
 * it applies only if nothing changed meanwhile). Null: nothing to write.
 * `confirmed(s)`: the departure the session currently records is confirmed.
 */
export async function provisionalFenceUpdate(
  sessionId: string,
  signalAt: Date,
  confirmed: (s: FenceStateFields) => boolean
): Promise<{ expect: Record<string, unknown>; data: Record<string, unknown> } | null> {
  const session = await prisma.classSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      lectureId: true,
      startedAt: true,
      teacherDepartureAt: true,
      teacherActiveAfterDepartureAt: true,
      jibriStopDepartureAt: true,
      jibriStopState: true,
      jibriStopOverrideAt: true,
      jibriStopStreamId: true,
      class: { select: { teacherId: true } },
    },
  });

  if (!session) return null;

  const expect = {
    jibriStopDepartureAt: session.jibriStopDepartureAt,
    jibriStopState: session.jibriStopState,
    jibriStopOverrideAt: session.jibriStopOverrideAt,
  };

  if (session.jibriStopDepartureAt && !released(session)) {
    if (session.jibriStopState !== "provisional") return null; // a confirmed fence continues

    // An enforced provisional fence (its departure confirmed): keep it, as
    // a confirmed one (this new signal must not make it look unconfirmed).
    if (session.teacherDepartureAt?.getTime() === session.jibriStopDepartureAt.getTime() && confirmed(session)) {
      return { expect, data: { jibriStopState: "pending" } };
    }
    // Otherwise it belonged to a cancelled departure: replaced below.
  }

  if (!session.lectureId) return null;

  const control = await readJibriFenceControl();

  if (!armsFences(control.mode)) return null;

  // An open provisional fence of an earlier departure is replaced, but its
  // pinned stream is kept: it is the stream that classroom's Jibri used.
  const keptPin = session.jibriStopDepartureAt && !released(session) ? session.jibriStopStreamId : null;
  const connection = keptPin ? null : await prisma.youTubeConnection.findUnique({ where: { teacherId: session.class.teacherId } });

  return { expect, data: freshFenceData(signalAt, "provisional", keptPin ?? connection?.liveStreamId ?? null, "signal") };
}

/**
 * The stream to pin for a fence armed AFTER the fact (a late fence): the
 * connection's stream only if the connection is unchanged since the
 * departure (not reconnected, no new stream since); otherwise none, so the
 * fence is never released by readings of a stream that may not be the one
 * that classroom's Jibri used (fails closed: an administrator decides).
 */
export function lateFencePin(
  connection: { liveStreamId: string | null; updatedAt?: Date | null } | null,
  departureAt: Date
): string | null {
  if (!connection?.liveStreamId) return null;
  if (connection.updatedAt && connection.updatedAt.getTime() > departureAt.getTime()) return null;

  return connection.liveStreamId;
}

/**
 * Clears a provisional fence whose departure was cancelled (activity within
 * the window, or the signal withdrawn). Best effort: the gate never enforces
 * such a fence anyway. `cancelled(s)` decides from the row as read.
 */
export async function clearCancelledProvisionalFence(
  sessionId: string,
  cancelled: (s: FenceStateFields) => boolean
): Promise<void> {
  try {
    const session = await prisma.classSession.findUnique({
      where: { id: sessionId },
      select: {
        teacherDepartureAt: true,
        teacherActiveAfterDepartureAt: true,
        jibriStopDepartureAt: true,
        jibriStopState: true,
        jibriStopOverrideAt: true,
      },
    });

    if (!session || session.jibriStopState !== "provisional" || !session.jibriStopDepartureAt) return;

    const withdrawn = session.teacherDepartureAt?.getTime() !== session.jibriStopDepartureAt.getTime();

    if (!withdrawn && !cancelled(session)) return;

    await prisma.classSession.updateMany({
      where: { id: sessionId, jibriStopState: "provisional", jibriStopDepartureAt: session.jibriStopDepartureAt },
      data: { jibriStopDepartureAt: null, jibriStopState: null, jibriStopStreamId: null, jibriStopOrigin: null },
    });
  } catch (error) {
    console.error("Could not clear a cancelled provisional Jibri shutdown fence:", { sessionId, error });
  }
}
