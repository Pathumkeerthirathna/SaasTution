import { participantIdFromRoomKey } from "./participant-identity.mjs";
import type { BreakoutParticipant, BreakoutRoom } from "./types";

/**
 * Breakout-room support, as verified against the deployed Jitsi web build (9268):
 *
 *  - commands: addBreakoutRoom(name?), sendParticipantToRoom(participant, roomId),
 *    autoAssignToBreakoutRooms(), closeBreakoutRoom(roomId), removeBreakoutRoom(roomJid),
 *    joinBreakoutRoom(roomJid)
 *  - function: listBreakoutRooms()
 *  - event:    breakoutRoomsUpdated
 *
 * Findings from testing against the real server that shape this file:
 *  - `joinBreakoutRoom` must be given the room JID (`<id>@breakout.<domain>`). A bare
 *    room id is looked up in the wrong (main) MUC and fails with "Room and token mismatched".
 *  - Returning to the main room must also use the main room JID; the no-argument form
 *    is unreliable (a student inside a breakout can have an empty room list).
 *  - Removing a room that still has people in it destroys their conference and strands
 *    them in no room. Always move people out (`closeBreakoutRoom`) first.
 *  - There is no rename command.
 */
export const BREAKOUT_REQUIRED_COMMANDS = [
  "addBreakoutRoom",
  "sendParticipantToRoom",
  "joinBreakoutRoom",
  "closeBreakoutRoom",
  "removeBreakoutRoom",
  "autoAssignToBreakoutRooms",
] as const;

type BreakoutApi = {
  executeCommand: (command: string, ...args: unknown[]) => void;
  listBreakoutRooms?: () => Promise<unknown>;
  getSupportedCommands?: () => string[];
};

const LIST_TIMEOUT_MS = 4000;

/** True when the installed Jitsi build exposes every command the feature needs. */
export function isBreakoutSupported(api: BreakoutApi | null): boolean {
  if (!api || typeof api.getSupportedCommands !== "function") {
    return false;
  }

  try {
    const commands = api.getSupportedCommands();
    return BREAKOUT_REQUIRED_COMMANDS.every((command) => commands.includes(command));
  } catch {
    return false;
  }
}

/** JID of the main MUC, used until the real one is seen in a rooms update. */
export function mainRoomJidFallback(session: { roomName: string; jitsiDomain: string }): string {
  return `${session.roomName.toLowerCase()}@conference.${session.jitsiDomain}`;
}

/** JID of a breakout room, used when only its id is known. */
export function breakoutRoomJidFallback(roomId: string, jitsiDomain: string): string {
  return `${roomId}@breakout.${jitsiDomain}`;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** "<local>@<domain>[/<resource>]" -> lower-cased local part and domain; null when not of that form. */
function splitJid(jid: unknown): { local: string; domain: string } | null {
  if (typeof jid !== "string") {
    return null;
  }

  const slash = jid.indexOf("/");
  const bare = slash === -1 ? jid : jid.slice(0, slash);
  const at = bare.indexOf("@");

  if (at <= 0 || at !== bare.lastIndexOf("@") || at === bare.length - 1) {
    return null;
  }

  return { local: bare.slice(0, at).toLowerCase(), domain: bare.slice(at + 1).toLowerCase() };
}

/**
 * The Jitsi domain of a room, from the room's own JID: "<room>@conference.<domain>" or
 * "<id>@breakout.<domain>" -> "<domain>". Null when the JID is not of that form.
 */
export function jitsiDomainOfRoomJid(roomJid: unknown): string | null {
  const parts = splitJid(roomJid);
  const dot = parts ? parts.domain.indexOf(".") : -1;

  if (!parts || dot <= 0 || dot === parts.domain.length - 1) {
    return null;
  }

  return parts.domain.slice(dot + 1);
}

/**
 * True only for Jicofo's focus occupant: real JID "focus@auth.<jitsiDomain>/...".
 * Decided by the JID alone, never by display name, role or a missing name; anything
 * else (including a missing or malformed JID, or an unknown domain) is not a service.
 */
export function isServiceOccupant(
  entry: { jid?: unknown } | null | undefined,
  jitsiDomain: string | null
): boolean {
  if (!jitsiDomain) {
    return false;
  }

  const parts = splitJid(entry?.jid);

  return parts !== null && parts.local === "focus" && parts.domain === `auth.${jitsiDomain.toLowerCase()}`;
}

/**
 * Turns Jitsi's rooms object (either `{ rooms }` from the event or the bare object from
 * `listBreakoutRooms()`) into a list: main room first, then breakout rooms by name.
 *
 * Each participant keeps its rooms-list key (the occupant JID), the participant ID parsed
 * from that key, and its real `jid` exactly as reported (for moves). Jicofo's focus
 * occupant (listed in every room, without a name) is left out, by its JID. Every other
 * entry is kept, including ones without a display name or without a `jid`: anyone in a
 * room counts when deciding whether the room is empty.
 */
export function normalizeBreakoutRooms(raw: unknown): BreakoutRoom[] {
  const source = (raw as { rooms?: unknown } | null | undefined)?.rooms ?? raw;

  if (!source || typeof source !== "object") {
    return [];
  }

  const rooms: BreakoutRoom[] = [];

  for (const value of Object.values(source as Record<string, unknown>)) {
    const room = value as {
      id?: string;
      jid?: string;
      name?: string;
      isMainRoom?: boolean;
      participants?: Record<string, { jid?: unknown; displayName?: unknown } | null | undefined>;
    };

    if (!room || typeof room.id !== "string" || typeof room.jid !== "string") {
      continue;
    }

    const jitsiDomain = jitsiDomainOfRoomJid(room.jid);

    rooms.push({
      id: room.id,
      jid: room.jid,
      name: room.name ?? "",
      isMainRoom: Boolean(room.isMainRoom),
      participants: Object.entries(room.participants ?? {})
        .filter(([, participant]) => !isServiceOccupant(participant, jitsiDomain))
        .map(
          ([occupantJid, participant]): BreakoutParticipant => ({
            occupantJid,
            participantId: participantIdFromRoomKey(occupantJid),
            jid: typeof participant?.jid === "string" ? participant.jid : null,
            displayName: typeof participant?.displayName === "string" ? participant.displayName : "",
          })
        ),
    });
  }

  return rooms.sort((a, b) => {
    if (a.isMainRoom !== b.isMainRoom) {
      return a.isMainRoom ? -1 : 1;
    }

    return collator.compare(a.name, b.name);
  });
}

/**
 * Participant ID -> label of the room that participant is in ("Main room" or the breakout
 * room name). Entries without a parseable participant ID are left out. Never by name.
 */
export function roomLabelByParticipantId(rooms: BreakoutRoom[]): Record<string, string> {
  const labels: Record<string, string> = {};

  for (const room of rooms) {
    for (const participant of room.participants) {
      if (participant.participantId) {
        labels[participant.participantId] = room.isMainRoom ? "Main room" : room.name;
      }
    }
  }

  return labels;
}

/**
 * Everyone in `room` except this browser's own entries (the teacher's current and earlier
 * participant IDs: after returning to the main room the list can briefly still show the
 * teacher's old entry in the breakout room). Entries without a parseable participant ID,
 * without a name or without a `jid` all count, so a room is only "empty" when it really is.
 */
export function breakoutOccupants(
  room: BreakoutRoom,
  ownParticipantIds: ReadonlySet<string>
): BreakoutParticipant[] {
  return room.participants.filter(
    (participant) => !(participant.participantId && ownParticipantIds.has(participant.participantId))
  );
}

export type BreakoutControls = {
  createBreakoutRoom: (name?: string) => void;
  /** `participantJid` comes from the rooms list, so it works wherever the person currently is. */
  sendParticipantToBreakoutRoom: (participantJid: string, roomId: string) => void;
  autoAssignBreakoutRooms: () => void;
  /** Join a room for this browser. Use the room's `jid`. */
  joinBreakoutRoom: (roomJid: string) => void;
  returnToMainRoom: () => void;
  /** Sends everyone in the room back to the main room. The room itself stays. */
  closeBreakoutRoom: (roomId: string) => void;
  /** Deletes a room. Only call this for an EMPTY room. */
  removeBreakoutRoom: (roomJid: string) => void;
  refreshBreakoutRooms: () => Promise<BreakoutRoom[]>;
};

/** The only place breakout `executeCommand` calls are made. */
export function createBreakoutControls(
  getApi: () => BreakoutApi | null,
  getMainRoomJid: () => string
): BreakoutControls {
  const run = (command: string, ...args: unknown[]) => {
    const api = getApi();

    if (!api) {
      console.warn(`[breakout] Jitsi API is not ready (${command})`);
      return;
    }

    api.executeCommand(command, ...args);
  };

  return {
    createBreakoutRoom: (name) => {
      const trimmed = name?.trim();
      run("addBreakoutRoom", ...(trimmed ? [trimmed] : []));
    },

    sendParticipantToBreakoutRoom: (participantJid, roomId) =>
      run("sendParticipantToRoom", participantJid, roomId),

    autoAssignBreakoutRooms: () => run("autoAssignToBreakoutRooms"),

    joinBreakoutRoom: (roomJid) => run("joinBreakoutRoom", roomJid),

    returnToMainRoom: () => run("joinBreakoutRoom", getMainRoomJid()),

    closeBreakoutRoom: (roomId) => run("closeBreakoutRoom", roomId),

    removeBreakoutRoom: (roomJid) => run("removeBreakoutRoom", roomJid),

    refreshBreakoutRooms: async () => {
      const api = getApi();

      if (!api || typeof api.listBreakoutRooms !== "function") {
        return [];
      }

      try {
        const result = await Promise.race([
          api.listBreakoutRooms(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), LIST_TIMEOUT_MS)),
        ]);

        return normalizeBreakoutRooms(result);
      } catch (error) {
        console.warn("[breakout] listBreakoutRooms failed:", error);
        return [];
      }
    },
  };
}
