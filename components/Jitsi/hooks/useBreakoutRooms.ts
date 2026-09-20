"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { breakoutRoomJidFallback } from "../breakout-utils";
import type { BreakoutRoom, CurrentRoomInfo, UserRole } from "../types";
import type { JitsiControls } from "./useJitsi";

const CREATE_TIMEOUT_MS = 7000;
const EMPTY_WAIT_MS = 20000;
const RETURN_WAIT_MS = 15000;
const POLL_MS = 1000;
const REMOVE_GAP_MS = 1200;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type BreakoutBusy = "creating" | "assigning" | "closing" | "removing" | null;

export type BreakoutController = {
  role: UserRole;
  supported: boolean;
  /** Last known rooms: the main room first, then breakout rooms. */
  rooms: BreakoutRoom[];
  mainRoom: BreakoutRoom | null;
  breakoutRooms: BreakoutRoom[];
  /** The room this browser is in right now. */
  currentRoom: CurrentRoomInfo | null;
  isInBreakout: boolean;
  /** Students: the room the teacher put them in (remembered after they return to main). */
  assignedRoom: { id: string; jid: string; name: string } | null;
  busy: BreakoutBusy;
  notice: string | null;
  dismissNotice: () => void;

  // Event handlers to wire into <JitsiMeeting />
  handleRoomsUpdated: (rooms: BreakoutRoom[]) => void;
  handleRoomChanged: (room: CurrentRoomInfo) => void;
  handleSupportChanged: (supported: boolean) => void;

  // Teacher
  createRoom: (name?: string) => void;
  moveParticipant: (participantJid: string, roomId: string) => void;
  autoAssign: () => void;
  joinRoom: (room: BreakoutRoom) => void;
  removeRoom: (room: BreakoutRoom) => Promise<void>;
  closeAllRooms: () => Promise<void>;

  // Both
  returnToMain: () => void;

  // Student
  joinAssignedRoom: () => void;
};

type Options = {
  role: UserRole;
  jitsiDomain: string;
  /** The teacher's Jitsi display name, so the teacher is never treated as a student. */
  teacherName: string;
  /** Recording / live run in the main room, so leaving it is worth a warning. */
  isStreaming: boolean;
  getControls: () => JitsiControls | null;
};

export default function useBreakoutRooms({
  role,
  jitsiDomain,
  teacherName,
  isStreaming,
  getControls,
}: Options): BreakoutController {
  const [supported, setSupported] = useState(false);
  const [rooms, setRooms] = useState<BreakoutRoom[]>([]);
  const [currentRoom, setCurrentRoom] = useState<CurrentRoomInfo | null>(null);
  const [assignedId, setAssignedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<BreakoutBusy>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const roomsRef = useRef<BreakoutRoom[]>([]);
  const currentRoomRef = useRef<CurrentRoomInfo | null>(null);
  const pendingCreateRef = useRef<{ before: number; timer: ReturnType<typeof setTimeout> } | null>(null);

  const mainRoom = useMemo(() => rooms.find((room) => room.isMainRoom) ?? null, [rooms]);
  const breakoutRooms = useMemo(() => rooms.filter((room) => !room.isMainRoom), [rooms]);

  const clearPendingCreate = useCallback(() => {
    if (pendingCreateRef.current) {
      clearTimeout(pendingCreateRef.current.timer);
      pendingCreateRef.current = null;
    }
  }, []);

  useEffect(() => clearPendingCreate, [clearPendingCreate]);

  /* --------------------------------- events --------------------------------- */

  const handleRoomsUpdated = useCallback(
    (next: BreakoutRoom[]) => {
      // A student inside a breakout room can receive an empty list. Keep what we knew.
      if (next.length === 0) {
        return;
      }

      roomsRef.current = next;
      setRooms(next);

      const pending = pendingCreateRef.current;

      if (pending && next.filter((room) => !room.isMainRoom).length > pending.before) {
        clearPendingCreate();
        setBusy((current) => (current === "creating" ? null : current));
      }
    },
    [clearPendingCreate]
  );

  const handleRoomChanged = useCallback((room: CurrentRoomInfo) => {
    currentRoomRef.current = room;
    setCurrentRoom(room);

    // Being moved into a breakout room IS the assignment.
    if (room.isBreakoutRoom) {
      setAssignedId(room.roomName);
    }
  }, []);

  const handleSupportChanged = useCallback((value: boolean) => {
    setSupported(value);

    if (!value) {
      console.warn("[breakout] This Jitsi server does not expose the breakout-room commands.");
    }
  }, []);

  // Forget a remembered room once the teacher has removed it.
  useEffect(() => {
    if (!assignedId || rooms.length === 0) {
      return;
    }

    const stillThere = rooms.some((room) => !room.isMainRoom && room.id === assignedId);
    const inIt = currentRoom?.isBreakoutRoom && currentRoom.roomName === assignedId;

    if (!stillThere && !inIt) {
      setAssignedId(null);
    }
  }, [rooms, assignedId, currentRoom]);

  const assignedRoom = useMemo(() => {
    if (!assignedId) {
      return null;
    }

    const known = breakoutRooms.find((room) => room.id === assignedId);

    return {
      id: assignedId,
      jid: known?.jid ?? breakoutRoomJidFallback(assignedId, jitsiDomain),
      name: known?.name || "Breakout room",
    };
  }, [assignedId, breakoutRooms, jitsiDomain]);

  /* --------------------------------- helpers -------------------------------- */

  const controls = useCallback(() => {
    const value = getControls();

    if (!value) {
      setNotice("The classroom is still connecting. Try again in a moment.");
    }

    return value;
  }, [getControls]);

  const isTeacherName = useCallback((name: string) => name === teacherName, [teacherName]);

  const occupants = useCallback(
    (room: BreakoutRoom) => room.participants.filter((participant) => !isTeacherName(participant.displayName)),
    [isTeacherName]
  );

  /* --------------------------------- teacher -------------------------------- */

  const createRoom = useCallback(
    (name?: string) => {
      const value = controls();

      if (!value) {
        return;
      }

      clearPendingCreate();
      setNotice(null);
      setBusy("creating");

      const before = roomsRef.current.filter((room) => !room.isMainRoom).length;

      pendingCreateRef.current = {
        before,
        timer: setTimeout(() => {
          pendingCreateRef.current = null;
          setBusy((current) => (current === "creating" ? null : current));
          setNotice(
            "The room was not created. Breakout rooms may not be enabled on this Jitsi server, or you are not a moderator."
          );
        }, CREATE_TIMEOUT_MS),
      };

      value.createBreakoutRoom(name);
    },
    [controls, clearPendingCreate]
  );

  const moveParticipant = useCallback(
    (participantJid: string, roomId: string) => {
      setNotice(null);
      controls()?.sendParticipantToBreakoutRoom(participantJid, roomId);
    },
    [controls]
  );

  const autoAssign = useCallback(() => {
    if (roomsRef.current.every((room) => room.isMainRoom)) {
      setNotice("Create at least one breakout room first.");
      return;
    }

    setNotice(null);
    controls()?.autoAssignBreakoutRooms();
  }, [controls]);

  const joinRoom = useCallback(
    (room: BreakoutRoom) => {
      if (
        isStreaming &&
        !window.confirm(
          "Recording / live streaming continues in the main room, but you will not be in it and cannot start or stop it from a breakout room. Join anyway?"
        )
      ) {
        return;
      }

      setNotice(null);
      controls()?.joinBreakoutRoom(room.jid);
    },
    [controls, isStreaming]
  );

  const returnToMain = useCallback(() => {
    setNotice(null);
    controls()?.returnToMainRoom();
  }, [controls]);

  /**
   * Removes rooms without ever stranding anyone. Jitsi destroys the conference of anybody
   * still inside a removed room and leaves them in no room, so first send everyone back
   * to the main room, wait until the rooms are really empty, and only then delete them.
   */
  const removeRooms = useCallback(
    async (targets: BreakoutRoom[], label: "closing" | "removing") => {
      const value = controls();

      if (!value || targets.length === 0) {
        return;
      }

      setNotice(null);
      setBusy(label);

      try {
        // The teacher must be out of the rooms too.
        if (currentRoomRef.current?.isBreakoutRoom) {
          value.returnToMainRoom();

          const returnBy = Date.now() + RETURN_WAIT_MS;

          while (currentRoomRef.current?.isBreakoutRoom && Date.now() < returnBy) {
            await sleep(500);
          }

          if (currentRoomRef.current?.isBreakoutRoom) {
            setNotice("Could not return you to the main room, so the rooms were left open.");
            return;
          }
        }

        const targetIds = new Set(targets.map((room) => room.id));
        let latest = roomsRef.current;

        for (const room of latest) {
          if (targetIds.has(room.id) && occupants(room).length > 0) {
            value.closeBreakoutRoom(room.id);
          }
        }

        const emptyBy = Date.now() + EMPTY_WAIT_MS;
        let allEmpty = false;

        while (Date.now() < emptyBy) {
          const fresh = await value.refreshBreakoutRooms();

          if (fresh.length > 0) {
            latest = fresh;
            roomsRef.current = fresh;
            setRooms(fresh);
          }

          allEmpty = latest
            .filter((room) => targetIds.has(room.id))
            .every((room) => occupants(room).length === 0);

          if (allEmpty && fresh.length > 0) {
            break;
          }

          await sleep(POLL_MS);
        }

        if (!allEmpty) {
          setNotice("Some participants have not returned to the main room yet, so the rooms were kept. Try again in a moment.");
          return;
        }

        for (const room of latest.filter((item) => targetIds.has(item.id))) {
          value.removeBreakoutRoom(room.jid);
          await sleep(REMOVE_GAP_MS);
        }
      } finally {
        setBusy(null);
      }
    },
    [controls, occupants]
  );

  const removeRoom = useCallback((room: BreakoutRoom) => removeRooms([room], "removing"), [removeRooms]);

  const closeAllRooms = useCallback(
    () => removeRooms(roomsRef.current.filter((room) => !room.isMainRoom), "closing"),
    [removeRooms]
  );

  /* --------------------------------- student -------------------------------- */

  const joinAssignedRoom = useCallback(() => {
    if (!assignedRoom) {
      return;
    }

    setNotice(null);
    controls()?.joinBreakoutRoom(assignedRoom.jid);
  }, [assignedRoom, controls]);

  return {
    role,
    supported,
    rooms,
    mainRoom,
    breakoutRooms,
    currentRoom,
    isInBreakout: Boolean(currentRoom?.isBreakoutRoom),
    assignedRoom,
    busy,
    notice,
    dismissNotice: () => setNotice(null),
    handleRoomsUpdated,
    handleRoomChanged,
    handleSupportChanged,
    createRoom,
    moveParticipant,
    autoAssign,
    joinRoom,
    removeRoom,
    closeAllRooms,
    returnToMain,
    joinAssignedRoom,
  };
}
