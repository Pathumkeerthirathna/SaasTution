// The rooms a teacher publishes an activity to: the main room and/or
// breakout rooms. Each target becomes one activity row with its own
// targetRoomType, targetRoomId and targetRoomName (VARCHAR(120)).
//
// Breakout rooms come from a trusted TeacherRoomDirectory: the session's
// current breakout rooms as the server knows them. That is the roster of
// Phase 2b. Until it exists the default directory FAILS CLOSED: it knows no
// breakout room, so any BREAKOUT target is refused. A room id or name sent
// by the client is never used for a row; the client only names which of the
// directory's rooms it means.
//
// All or nothing (approved rule): if ANY breakout target cannot be resolved,
// the whole request is refused with 409 ROOM_UNKNOWN, and nothing is created
// or published, the MAIN target included.
//
// (Students whose room cannot be resolved get 404 instead:
// room-resolver.ts.)

import { breakoutError } from "./errors";
import type { BreakoutTarget } from "./validation";

export const MAIN_ROOM_NAME = "Main room";
export const ROOM_NAME_MAX = 120;

export type DirectoryRoom = { id: string; name: string };

export type TeacherRoomQuery = { sessionId: string; teacherId: string };

export type TeacherRoomDirectory = {
  /** The session's current breakout rooms, or null when they are not known. */
  listBreakoutRooms(query: TeacherRoomQuery): Promise<DirectoryRoom[] | null>;
};

/** Phase 2a default: no breakout room is ever known. */
export const failClosedTeacherRoomDirectory: TeacherRoomDirectory = {
  async listBreakoutRooms() {
    return null;
  },
};

export const defaultTeacherRoomDirectory: TeacherRoomDirectory = failClosedTeacherRoomDirectory;

export type ResolvedTarget =
  | { targetRoomType: "MAIN"; targetRoomId: null; targetRoomName: string }
  | { targetRoomType: "BREAKOUT"; targetRoomId: string; targetRoomName: string };

// Control characters and bidirectional overrides / isolates (as for file
// display names). ZWJ / ZWNJ are kept: Sinhala and Tamil names need them.
const UNSAFE_NAME_CHARS = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu;

/** A room name fit for the VARCHAR(120) column (code points), or null when nothing is left. */
export function normalizeRoomName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  // Whitespace first (a newline or tab becomes a space), then the unsafe characters.
  const cleaned = name.normalize("NFC").replace(/\s+/gu, " ").replace(UNSAFE_NAME_CHARS, "").replace(/ {2,}/g, " ").trim();
  if (cleaned === "") return null;
  const chars = Array.from(cleaned);
  return chars.length > ROOM_NAME_MAX ? chars.slice(0, ROOM_NAME_MAX).join("").trim() : cleaned;
}

function roomUnknown(): never {
  throw breakoutError("ROOM_UNKNOWN");
}

/**
 * Validated targets (targetsSchema: 1-50, distinct) -> the rows' room
 * fields, in the same order. The directory is consulted only when there is
 * a BREAKOUT target; a failure, an unknown roster, or any target it does not
 * list (with a usable name) refuses the whole request.
 */
export async function resolveTargets(
  targets: readonly BreakoutTarget[],
  query: TeacherRoomQuery,
  directory: TeacherRoomDirectory = defaultTeacherRoomDirectory
): Promise<ResolvedTarget[]> {
  if (!Array.isArray(targets) || targets.length === 0) throw breakoutError("VALIDATION_ERROR", "Choose at least one room.");

  let rooms: Map<string, string> | null = null;
  if (targets.some((t) => t.type === "BREAKOUT")) {
    let listed: DirectoryRoom[] | null;
    try {
      listed = await directory.listBreakoutRooms(query);
    } catch (error) {
      console.error("Breakout room directory failed; activity creation refused.", { sessionId: query.sessionId, error });
      roomUnknown();
    }
    if (!Array.isArray(listed)) roomUnknown();
    rooms = new Map();
    for (const room of listed) {
      if (!room || typeof room.id !== "string" || room.id === "") continue;
      const name = normalizeRoomName(room.name);
      if (name !== null && !rooms.has(room.id)) rooms.set(room.id, name);
    }
  }

  return targets.map((target): ResolvedTarget => {
    if (target.type === "MAIN") return { targetRoomType: "MAIN", targetRoomId: null, targetRoomName: MAIN_ROOM_NAME };
    const name = rooms?.get(target.id);
    if (name === undefined) roomUnknown();
    return { targetRoomType: "BREAKOUT", targetRoomId: target.id, targetRoomName: name };
  });
}
