// Group Activities change notifications: an in-process EventEmitter held on
// globalThis, like the other session buses (lib/session-events.ts,
// lib/classroom-participant-map.ts). Production runs one Node process, so
// this fans out to every live-updates stream of the session.
//
// PostgreSQL stays the source of truth: an event only says "this group's
// work changed, refetch". It carries ids and a revision, never content, and
// lists who may be told (the room's confirmed members); the live-updates
// route sends it only to the class's teacher and to those students.

import { EventEmitter } from "node:events";

const GROUP_EVENT = "breakout-group-change";

export type GroupChangeKind = "members" | "assignment" | "quiz";

export type GroupChangePayload = {
  sessionId: string;
  kind: GroupChangeKind;
  /** The activity whose shared work changed (assignment / quiz); null for "members". */
  activityId: string | null;
  /** The breakout room of the group. */
  roomId: string | null;
  /** Monotonic per activity (work / attempt revision); 0 when not applicable. */
  revision: number;
  /** Students who may receive this event (confirmed members, and anyone just removed). */
  memberStudentIds: string[];
  occurredAt: string;
};

const globalForGroupEvents = globalThis as unknown as { breakoutGroupEventBus?: EventEmitter };

const bus = globalForGroupEvents.breakoutGroupEventBus ?? new EventEmitter({ captureRejections: false });
bus.setMaxListeners(500);
if (!globalForGroupEvents.breakoutGroupEventBus) globalForGroupEvents.breakoutGroupEventBus = bus;

/** Emits after a COMMITTED change (callers emit after their transaction returned). Never throws. */
export function emitGroupChange(payload: Omit<GroupChangePayload, "occurredAt">): void {
  try {
    bus.emit(GROUP_EVENT, { ...payload, memberStudentIds: [...payload.memberStudentIds], occurredAt: new Date().toISOString() });
  } catch {
    /* a notification must never fail the write that caused it */
  }
}

/** `listener` gets every change of `sessionId`; returns the unsubscribe function. */
export function subscribeGroupChanges(sessionId: string, listener: (payload: GroupChangePayload) => void): () => void {
  const wrapped = (payload: GroupChangePayload) => {
    if (payload.sessionId !== sessionId) return;
    try {
      listener(payload);
    } catch {
      /* one broken stream must not break the others */
    }
  };
  bus.on(GROUP_EVENT, wrapped);
  return () => {
    bus.off(GROUP_EVENT, wrapped);
  };
}

/** Whether a stream may receive the event: the class teacher always, a student only when listed. */
export function groupChangeVisibleTo(payload: GroupChangePayload, viewer: { role: "teacher" } | { role: "student"; studentId: string }): boolean {
  if (viewer.role === "teacher") return true;
  return payload.memberStudentIds.includes(viewer.studentId);
}

/** What a stream sends: ids and a revision only (no member list, no content). */
export function groupChangeForClient(payload: GroupChangePayload) {
  return {
    kind: payload.kind,
    activityId: payload.activityId,
    roomId: payload.roomId,
    revision: payload.revision,
    occurredAt: payload.occurredAt,
  };
}
