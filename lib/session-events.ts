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

    listener(payload);
  };

  sessionEventBus.on(SESSION_ATTENDANCE_EVENT, wrappedListener);

  return () => {
    sessionEventBus.off(SESSION_ATTENDANCE_EVENT, wrappedListener);
  };
}
