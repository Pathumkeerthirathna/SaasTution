import { EventEmitter } from "node:events";

type AttendanceEventPayload = {
  sessionId: string;
  attendanceId: string;
  studentId: string;
  joinedAt: string;
  leftAt: string | null;
  event: "joined" | "left";
  occurredAt: string;
};

const SESSION_ATTENDANCE_EVENT = "session-attendance";

const globalForSessionEvents = globalThis as unknown as {
  sessionEventBus?: EventEmitter;
};

const sessionEventBus =
  globalForSessionEvents.sessionEventBus ??
  new EventEmitter({
    captureRejections: false,
  });

sessionEventBus.setMaxListeners(200);

if (!globalForSessionEvents.sessionEventBus) {
  globalForSessionEvents.sessionEventBus = sessionEventBus;
}

export function emitSessionAttendanceEvent(payload: AttendanceEventPayload) {
  sessionEventBus.emit(SESSION_ATTENDANCE_EVENT, payload);
}

export function subscribeSessionAttendanceEvents(
  sessionId: string,
  listener: (payload: AttendanceEventPayload) => void
) {
  const wrappedListener = (payload: AttendanceEventPayload) => {
    if (payload.sessionId !== sessionId) {
      return;
    }

    // A single broken SSE stream must never break the emit for the other
    // subscribers or throw back into the mutation that triggered it.
    try {
      listener(payload);
    } catch {
      /* ignore a failing subscriber */
    }
  };

  sessionEventBus.on(SESSION_ATTENDANCE_EVENT, wrappedListener);

  return () => {
    sessionEventBus.off(SESSION_ATTENDANCE_EVENT, wrappedListener);
  };
}

/* ------------------------------------------------------------------ *
 * Live-state change signal
 *
 * A push notification that "the live state of a class changed" — a Jitsi
 * session or a YouTube broadcast started or ended. Whoever writes that change
 * to the database calls `emitLiveChange(...)`; the student dashboard's SSE
 * stream listens and re-pushes the authoritative snapshot. No polling.
 *
 * NOTE: this is an in-process EventEmitter, so it only fans out within a
 * single Node process (same constraint as the attendance stream above). A
 * multi-instance deployment would need Postgres LISTEN/NOTIFY or Redis pub/sub
 * as the transport; the API surface here would stay the same.
 * ------------------------------------------------------------------ */

export type LiveChangePayload = {
  classId: string;
  kind: "jitsi" | "youtube";
  event: "started" | "ended";
  occurredAt: string;
};

const LIVE_CHANGE_EVENT = "live-change";

export function emitLiveChange(
  payload: Omit<LiveChangePayload, "occurredAt"> & { occurredAt?: string }
) {
  sessionEventBus.emit(LIVE_CHANGE_EVENT, {
    ...payload,
    occurredAt: payload.occurredAt ?? new Date().toISOString(),
  } satisfies LiveChangePayload);
}

export function subscribeLiveChanges(listener: (payload: LiveChangePayload) => void) {
  const safeListener = (payload: LiveChangePayload) => {
    try {
      listener(payload);
    } catch {
      /* one broken SSE stream must not break the fan-out for the others */
    }
  };
  sessionEventBus.on(LIVE_CHANGE_EVENT, safeListener);
  return () => {
    sessionEventBus.off(LIVE_CHANGE_EVENT, safeListener);
  };
}

/* ------------------------------------------------------------------ *
 * Student coursework / engagement change signal
 *
 * Fired when something that feeds a student's dashboard counts changes —
 * a teacher adds/removes a note, assignment, quiz or paper (`classId`), or a
 * student submits / views one (`studentId`). The dashboard SSE stream listens
 * and tells the affected clients to re-pull their counts. Same in-process
 * constraint as the buses above.
 * ------------------------------------------------------------------ */

export type StudentDataChangePayload = {
  studentId?: string;
  classId?: string;
  occurredAt: string;
};

const STUDENT_DATA_CHANGE_EVENT = "student-data-change";

export function emitStudentDataChange(
  payload: Omit<StudentDataChangePayload, "occurredAt"> & { occurredAt?: string }
) {
  sessionEventBus.emit(STUDENT_DATA_CHANGE_EVENT, {
    ...payload,
    occurredAt: payload.occurredAt ?? new Date().toISOString(),
  } satisfies StudentDataChangePayload);
}

export function subscribeStudentDataChanges(
  listener: (payload: StudentDataChangePayload) => void
) {
  const safeListener = (payload: StudentDataChangePayload) => {
    try {
      listener(payload);
    } catch {
      /* one broken SSE stream must not break the fan-out for the others */
    }
  };
  sessionEventBus.on(STUDENT_DATA_CHANGE_EVENT, safeListener);
  return () => {
    sessionEventBus.off(STUDENT_DATA_CHANGE_EVENT, safeListener);
  };
}
