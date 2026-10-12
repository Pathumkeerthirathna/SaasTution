/**
 * One student's attendance visit, as the classroom page sees it.
 *
 * A visit starts when Jitsi first reports the conference joined and ends with
 * a CONFIRMED leave: useJitsi only calls `left()` once Jitsi has stayed out of
 * the conference for its grace period (ROOM_SWITCH_GRACE_MS), or when the page
 * / meeting is torn down (refresh, tab closed, unmount). Jitsi's own
 * "left -> joined" within that grace period (a brief reconnect, a reload of
 * Jitsi's page inside the iframe, a breakout-room switch) cancels the leave, so
 * `joined()` arrives while the visit is still open and is NOT a new visit.
 *
 * After a confirmed leave the next `joined()` starts a new visit (a new
 * Attendance row on the server; closed rows are never reused).
 *
 * Plain TypeScript (no React), so it can be tested on its own.
 */

export type AttendanceVisitTransport = {
  /** Records a new visit; resolves with its attendance ID, or null if it was not recorded. */
  join: () => Promise<string | null>;
  /** Ends a visit (its ID when known). */
  leave: (attendanceId: string | null) => Promise<void>;
};

export type AttendanceVisitState = "none" | "joining" | "open";

export function createAttendanceVisit(transport: AttendanceVisitTransport) {
  let state: AttendanceVisitState = "none";
  let attendanceId: string | null = null;
  // A confirmed leave that arrived while the join request was still running.
  let leaveWhileJoining = false;

  return {
    /** Jitsi reports the conference joined (first join, reconnect, room switch). */
    async joined(): Promise<void> {
      if (state === "open") {
        // Same visit continues (its leave was never confirmed).
        return;
      }

      if (state === "joining") {
        // Joined again before the first join was even answered: still the
        // same visit, and an earlier leave is cancelled by it.
        leaveWhileJoining = false;
        return;
      }

      state = "joining";
      leaveWhileJoining = false;

      let id: string | null = null;

      try {
        id = await transport.join();
      } catch {
        id = null;
      }

      if (leaveWhileJoining) {
        // Left before the server answered: end the visit just recorded.
        state = "none";
        attendanceId = null;
        leaveWhileJoining = false;

        if (id) {
          await transport.leave(id);
        }

        return;
      }

      if (!id) {
        // Not recorded (network / server error): the next join tries again.
        state = "none";
        return;
      }

      state = "open";
      attendanceId = id;
    },

    /** A confirmed leave (grace period over, or page / meeting teardown). */
    async left(): Promise<void> {
      if (state === "none") {
        // Nothing open (never joined, or this visit already ended).
        return;
      }

      if (state === "joining") {
        leaveWhileJoining = true;
        return;
      }

      const id = attendanceId;

      state = "none";
      attendanceId = null;

      await transport.leave(id);
    },

    state: (): AttendanceVisitState => state,
    attendanceId: (): string | null => attendanceId,
  };
}
