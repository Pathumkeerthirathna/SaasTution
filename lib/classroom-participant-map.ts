import { EventEmitter } from "node:events";

/**
 * Live classroom identity map: which Jitsi participant ID each student is
 * currently using inside one class session.
 *
 *   sessionId -> studentId -> { participantId, at }
 *
 * A student registers its own participant ID (from the authenticated student
 * session, never from the request body) every time its Jitsi conference
 * joins, because a reconnect or a breakout-room switch gives it a new ID. The
 * teacher reads the map over SSE so it can address students by application
 * student ID instead of by display name.
 *
 * NOTE: like the other session event buses this is an in-process EventEmitter
 * held only in memory, so it only fans out within a single Node process and is
 * empty again after a restart (students re-register on their next join).
 */

const MAP_EVENT = "participant-map";
const RETAIN_MS = 12 * 60 * 60 * 1000;

/** Jitsi endpoint IDs are short hex strings (e.g. "de809448"); allow some headroom. */
export const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

type ParticipantEntry = { participantId: string; at: number };

type SessionMap = {
  seq: number;
  updatedAt: number;
  students: Map<string, ParticipantEntry>;
};

export type ParticipantMapSnapshot = {
  sessionId: string;
  seq: number;
  /** studentId -> participantId */
  participants: Record<string, string>;
  occurredAt: string;
};

export class ParticipantIdConflictError extends Error {
  constructor() {
    super("This participant ID is already registered to another student.");
    this.name = "ParticipantIdConflictError";
  }
}

const globalForParticipantMap = globalThis as unknown as {
  participantMapEventBus?: EventEmitter;
  participantMapState?: Map<string, SessionMap>;
};

const bus =
  globalForParticipantMap.participantMapEventBus ??
  new EventEmitter({ captureRejections: false });

bus.setMaxListeners(500);

const sessions = globalForParticipantMap.participantMapState ?? new Map<string, SessionMap>();

if (!globalForParticipantMap.participantMapEventBus) {
  globalForParticipantMap.participantMapEventBus = bus;
}

if (!globalForParticipantMap.participantMapState) {
  globalForParticipantMap.participantMapState = sessions;
}

function pruneOldSessions(now: number) {
  sessions.forEach((state, sessionId) => {
    if (now - state.updatedAt > RETAIN_MS) {
      sessions.delete(sessionId);
    }
  });
}

function toSnapshot(sessionId: string, state: SessionMap | undefined): ParticipantMapSnapshot {
  const participants: Record<string, string> = {};

  state?.students.forEach((entry, studentId) => {
    participants[studentId] = entry.participantId;
  });

  return {
    sessionId,
    seq: state?.seq ?? 0,
    participants,
    occurredAt: new Date(state?.updatedAt ?? Date.now()).toISOString(),
  };
}

function publish(sessionId: string, state: SessionMap) {
  bus.emit(MAP_EVENT, toSnapshot(sessionId, state));
}

/** Current studentId -> participantId map for a session (empty when nobody has registered). */
export function getParticipantMap(sessionId: string): ParticipantMapSnapshot {
  return toSnapshot(sessionId, sessions.get(sessionId));
}

/**
 * Records the participant ID a student is using right now. The newest ID
 * replaces any earlier one for that student. Throws
 * {@link ParticipantIdConflictError} if another student already holds the ID.
 */
export function setParticipant(sessionId: string, studentId: string, participantId: string) {
  const now = Date.now();
  pruneOldSessions(now);

  let state = sessions.get(sessionId);

  if (!state) {
    state = { seq: 0, updatedAt: now, students: new Map() };
    sessions.set(sessionId, state);
  }

  for (const [otherStudentId, entry] of state.students) {
    if (otherStudentId !== studentId && entry.participantId === participantId) {
      throw new ParticipantIdConflictError();
    }
  }

  const current = state.students.get(studentId);

  if (current?.participantId === participantId) {
    // Same ID registered again (e.g. a retried request): nothing changed.
    current.at = now;
    state.updatedAt = now;
    return;
  }

  state.students.set(studentId, { participantId, at: now });
  state.seq += 1;
  state.updatedAt = now;
  publish(sessionId, state);
}

/**
 * Forgets a student's mapping. When `participantId` is given, it is removed
 * only if it is still the student's current ID, so a late removal for an old
 * connection cannot drop a newer registration.
 */
export function removeParticipant(sessionId: string, studentId: string, participantId?: string) {
  const state = sessions.get(sessionId);
  const current = state?.students.get(studentId);

  if (!state || !current) {
    return;
  }

  if (participantId && current.participantId !== participantId) {
    return;
  }

  state.students.delete(studentId);
  state.seq += 1;
  state.updatedAt = Date.now();
  publish(sessionId, state);
}

/** Calls `listener` with the full snapshot every time the session's map changes. */
export function subscribeParticipantMap(
  sessionId: string,
  listener: (snapshot: ParticipantMapSnapshot) => void
) {
  const wrapped = (snapshot: ParticipantMapSnapshot) => {
    if (snapshot.sessionId !== sessionId) {
      return;
    }

    // One broken SSE stream must never break the emit for the others.
    try {
      listener(snapshot);
    } catch {
      /* ignore a failing subscriber */
    }
  };

  bus.on(MAP_EVENT, wrapped);

  return () => {
    bus.off(MAP_EVENT, wrapped);
  };
}
