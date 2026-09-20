import type { BreakoutRoom } from "./types";

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

/**
 * Turns Jitsi's rooms object (either `{ rooms }` from the event or the bare object from
 * `listBreakoutRooms()`) into a list: main room first, then breakout rooms by name.
 * Participants without a display name (Jicofo, the recorder) are dropped.
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
      participants?: Record<string, { jid?: string; displayName?: string }>;
    };

    if (!room || typeof room.id !== "string" || typeof room.jid !== "string") {
      continue;
    }

    rooms.push({
      id: room.id,
      jid: room.jid,
      name: room.name ?? "",
      isMainRoom: Boolean(room.isMainRoom),
      participants: Object.values(room.participants ?? {})
        .filter(
          (participant): participant is { jid: string; displayName: string } =>
            typeof participant?.jid === "string" &&
            typeof participant?.displayName === "string" &&
            participant.displayName.trim().length > 0
        )
        .map((participant) => ({ jid: participant.jid, displayName: participant.displayName })),
    });
  }

  return rooms.sort((a, b) => {
    if (a.isMainRoom !== b.isMainRoom) {
      return a.isMainRoom ? -1 : 1;
    }

    return collator.compare(a.name, b.name);
  });
}

/** Display name -> label of the room that person is in ("Main room" or the breakout room name). */
export function roomLabelByParticipantName(rooms: BreakoutRoom[]): Record<string, string> {
  const labels: Record<string, string> = {};

  for (const room of rooms) {
    for (const participant of room.participants) {
      labels[participant.displayName] = room.isMainRoom ? "Main room" : room.name;
    }
  }

  return labels;
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
