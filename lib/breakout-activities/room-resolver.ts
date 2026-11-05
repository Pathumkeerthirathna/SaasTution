// Which room a student is in right now: the main room or one breakout room.
// Student breakout routes only show and accept activities targeted at that
// room.
//
// Room resolution (the roster built from the Jitsi breakout rooms) is
// Phase 2b. Until it exists the default resolver FAILS CLOSED: it resolves
// no student to any room, and requireStudentRoom() answers 404, so a student
// can neither see nor submit to any breakout activity. Services take the
// resolver as a parameter; tests pass their own, and Phase 2b replaces the
// default. There is deliberately no global setter.

import { breakoutError } from "./errors";

export type StudentRoom = { type: "MAIN" } | { type: "BREAKOUT"; id: string };

export type StudentRoomQuery = { sessionId: string; studentId: string };

export type StudentRoomResolver = {
  /** The student's current room, or null when it cannot be determined. */
  resolveStudentRoom(query: StudentRoomQuery): Promise<StudentRoom | null>;
};

/** Phase 2a default: no student is ever placed in a room. */
export const failClosedStudentRoomResolver: StudentRoomResolver = {
  async resolveStudentRoom() {
    return null;
  },
};

export const defaultStudentRoomResolver: StudentRoomResolver = failClosedStudentRoomResolver;

function isValidRoom(room: unknown): room is StudentRoom {
  if (!room || typeof room !== "object") return false;
  const r = room as { type?: unknown; id?: unknown };
  if (r.type === "MAIN") return true;
  return r.type === "BREAKOUT" && typeof r.id === "string" && r.id !== "";
}

/**
 * The student's room, or 404 NOT_FOUND when it cannot be determined (no
 * room, an invalid answer, or a resolver failure: all fail closed).
 */
export async function requireStudentRoom(
  query: StudentRoomQuery,
  resolver: StudentRoomResolver = defaultStudentRoomResolver
): Promise<StudentRoom> {
  let room: StudentRoom | null;
  try {
    room = await resolver.resolveStudentRoom(query);
  } catch (error) {
    console.error("Breakout room resolution failed; access refused.", { sessionId: query.sessionId, error });
    throw breakoutError("NOT_FOUND");
  }
  if (!isValidRoom(room)) throw breakoutError("NOT_FOUND");
  return room.type === "MAIN" ? { type: "MAIN" } : { type: "BREAKOUT", id: room.id };
}

/** Whether an activity's target is exactly this room. */
export function activityTargetsRoom(
  activity: { targetRoomType: "MAIN" | "BREAKOUT"; targetRoomId: string | null },
  room: StudentRoom
): boolean {
  if (activity.targetRoomType === "MAIN") return room.type === "MAIN";
  return room.type === "BREAKOUT" && typeof activity.targetRoomId === "string" && activity.targetRoomId === room.id;
}
