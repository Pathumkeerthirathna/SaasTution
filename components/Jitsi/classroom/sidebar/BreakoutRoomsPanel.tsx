"use client";

import { useState } from "react";
import {
  AlertTriangle,
  DoorOpen,
  Loader2,
  LogIn,
  Plus,
  Shuffle,
  Trash2,
  Undo2,
  UsersRound,
  X,
} from "lucide-react";

import type { BreakoutController } from "../../hooks/useBreakoutRooms";
import type { BreakoutRoom } from "../../types";

type BreakoutRoomsPanelProps = {
  controller: BreakoutController;
  /** The teacher's Jitsi display name; the teacher is never listed as a student. */
  teacherName: string;
};

const primaryButton =
  "inline-flex items-center justify-center gap-1.5 rounded-md bg-[#4D6C90] px-3 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-[#3B5776] disabled:cursor-not-allowed disabled:opacity-60";
const secondaryButton =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[12.5px] font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60";
const dangerButton =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60";

function Banner({ tone, children, onClose }: { tone: "warn" | "info"; children: React.ReactNode; onClose?: () => void }) {
  const styles =
    tone === "warn"
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : "border-sky-200 bg-sky-50 text-sky-800";

  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] leading-snug ${styles}`}>
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      {onClose ? (
        <button type="button" onClick={onClose} aria-label="Dismiss" className="shrink-0 rounded p-0.5 hover:bg-black/5">
          <X size={13} />
        </button>
      ) : null}
    </div>
  );
}

/* --------------------------------- teacher --------------------------------- */

function MoveSelect({
  room,
  targets,
  onMove,
  jid,
}: {
  room: BreakoutRoom;
  targets: BreakoutRoom[];
  onMove: (jid: string, roomId: string) => void;
  jid: string;
}) {
  return (
    <select
      value=""
      onChange={(event) => {
        if (event.target.value) {
          onMove(jid, event.target.value);
        }
      }}
      aria-label="Move to another room"
      className="max-w-[9.5rem] rounded-md border border-slate-300 bg-white px-1.5 py-1 text-[12px] text-slate-700 outline-none focus:border-[#4D6C90]"
    >
      <option value="">Move to...</option>
      {targets
        .filter((target) => target.id !== room.id)
        .map((target) => (
          <option key={target.id} value={target.id}>
            {target.isMainRoom ? "Main room" : target.name}
          </option>
        ))}
    </select>
  );
}

function TeacherView({ controller, teacherName }: BreakoutRoomsPanelProps) {
  const [name, setName] = useState("");

  const { supported, mainRoom, breakoutRooms, rooms, currentRoom, busy, isInBreakout } = controller;
  const working = busy !== null;
  const students = (room: BreakoutRoom) => room.participants.filter((p) => p.displayName !== teacherName);
  const studentsInMain = mainRoom ? students(mainRoom) : [];

  const submitCreate = () => {
    controller.createRoom(name);
    setName("");
  };

  const roomCard = (room: BreakoutRoom) => {
    const people = students(room);
    const teacherHere = currentRoom?.roomName === room.id;

    return (
      <div key={room.id} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-semibold text-slate-900">
              {room.isMainRoom ? "Main room" : room.name || "Breakout room"}
            </p>
            <p className="text-[11px] text-slate-500">
              {people.length} student{people.length === 1 ? "" : "s"}
              {teacherHere ? " · you are here" : ""}
            </p>
          </div>

          {!room.isMainRoom ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => controller.joinRoom(room)}
                disabled={!supported || working || teacherHere}
                className={secondaryButton}
              >
                <LogIn size={13} />
                Join
              </button>
              <button
                type="button"
                onClick={() => {
                  if (
                    people.length === 0 ||
                    window.confirm(`Send everyone in "${room.name}" back to the main room and remove it?`)
                  ) {
                    void controller.removeRoom(room);
                  }
                }}
                disabled={!supported || working}
                title="Remove room"
                aria-label="Remove room"
                className={dangerButton}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ) : null}
        </div>

        {people.length === 0 ? (
          <p className="mt-2 rounded-md bg-slate-50 px-2.5 py-2 text-center text-[12px] text-slate-400">
            {room.isMainRoom ? "No students here." : "Empty"}
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {people.map((person) => (
              <li
                key={person.jid}
                className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-slate-800">{person.displayName}</span>
                <MoveSelect
                  room={room}
                  targets={rooms}
                  jid={person.jid}
                  onMove={controller.moveParticipant}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {!supported ? (
        <Banner tone="warn">Breakout rooms are not available on this Jitsi server.</Banner>
      ) : null}

      {isInBreakout ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
          <p className="text-[12.5px] font-medium text-emerald-800">
            You are in{" "}
            <strong>{breakoutRooms.find((room) => room.id === currentRoom?.roomName)?.name || "a breakout room"}</strong>
          </p>
          <button type="button" onClick={controller.returnToMain} className={secondaryButton}>
            <Undo2 size={13} />
            Return to main room
          </button>
        </div>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitCreate();
        }}
        className="flex items-center gap-2"
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={60}
          placeholder="Room name (optional)"
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-[13px] outline-none focus:border-[#4D6C90]"
        />
        <button type="submit" disabled={!supported || working} className={primaryButton}>
          {busy === "creating" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Create Room
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={controller.autoAssign}
          disabled={!supported || working || breakoutRooms.length === 0 || studentsInMain.length === 0}
          title="Spread the students in the main room evenly across the rooms"
          className={secondaryButton}
        >
          <Shuffle size={13} />
          Auto Assign
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm("Send everyone back to the main room and remove all breakout rooms?")) {
              void controller.closeAllRooms();
            }
          }}
          disabled={!supported || working || breakoutRooms.length === 0}
          className={dangerButton}
        >
          {busy === "closing" ? <Loader2 size={13} className="animate-spin" /> : <DoorOpen size={13} />}
          Close Breakout Rooms
        </button>
      </div>

      {controller.notice ? (
        <Banner tone="warn" onClose={controller.dismissNotice}>
          {controller.notice}
        </Banner>
      ) : null}

      {breakoutRooms.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-5 text-center">
          <UsersRound className="mx-auto h-7 w-7 text-slate-300" />
          <p className="mt-2 text-[13.5px] font-semibold text-slate-700">No rooms yet.</p>
          <p className="mt-1 text-[12px] text-slate-500">Create a room to split the class into groups.</p>
        </div>
      ) : null}

      {mainRoom ? roomCard(mainRoom) : null}
      {breakoutRooms.map(roomCard)}

      <p className="text-[11.5px] leading-snug text-slate-500">
        Students are moved automatically when you assign them. Room names can only be set when a room is created.
      </p>
    </div>
  );
}

/* --------------------------------- student --------------------------------- */

function StudentView({ controller }: { controller: BreakoutController }) {
  const { supported, breakoutRooms, assignedRoom, currentRoom, isInBreakout } = controller;

  const insideAssigned = Boolean(assignedRoom && currentRoom?.roomName === assignedRoom.id);

  // The room list can be empty while inside a breakout room, so always show the assigned room.
  const listed = assignedRoom && !breakoutRooms.some((room) => room.id === assignedRoom.id)
    ? [
        ...breakoutRooms,
        {
          id: assignedRoom.id,
          jid: assignedRoom.jid,
          name: assignedRoom.name,
          isMainRoom: false,
          participants: [],
        } satisfies BreakoutRoom,
      ]
    : breakoutRooms;

  return (
    <div className="space-y-3">
      {!supported ? (
        <Banner tone="warn">Breakout rooms are not available on this Jitsi server.</Banner>
      ) : null}

      {controller.notice ? (
        <Banner tone="warn" onClose={controller.dismissNotice}>
          {controller.notice}
        </Banner>
      ) : null}

      {isInBreakout ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
          <p className="text-[12.5px] font-medium text-emerald-800">You are in your breakout room.</p>
          <button type="button" onClick={controller.returnToMain} className={secondaryButton}>
            <Undo2 size={13} />
            Return to main room
          </button>
        </div>
      ) : null}

      {!assignedRoom ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-5 text-center">
          <UsersRound className="mx-auto h-7 w-7 text-slate-300" />
          <p className="mt-2 text-[13.5px] font-semibold text-slate-700">
            No breakout room has been assigned yet.
          </p>
          <p className="mt-1 text-[12px] text-slate-500">
            Your teacher will move you automatically when breakout rooms start.
          </p>
        </div>
      ) : null}

      {listed.length > 0 ? (
        <ul className="space-y-2">
          {listed.map((room) => {
            const isAssigned = assignedRoom?.id === room.id;

            return (
              <li
                key={room.id}
                className={`rounded-xl border p-3 ${
                  isAssigned ? "border-emerald-300 bg-emerald-50/60" : "border-slate-200 bg-white"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-semibold text-slate-900">{room.name || "Breakout room"}</p>
                    <p className={`text-[12px] ${isAssigned ? "font-semibold text-emerald-700" : "text-slate-400"}`}>
                      {isAssigned ? "You are assigned here" : "Not assigned"}
                    </p>
                  </div>

                  {isAssigned ? (
                    insideAssigned ? (
                      <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                        You are inside
                      </span>
                    ) : (
                      <button type="button" onClick={controller.joinAssignedRoom} disabled={!supported} className={primaryButton}>
                        <LogIn size={13} />
                        Join Room
                      </button>
                    )
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      <p className="text-[11.5px] leading-snug text-slate-500">
        Your teacher moves you between rooms automatically. Use Join Room only to re-enter your assigned room after
        returning to the main room.
      </p>
    </div>
  );
}

export default function BreakoutRoomsPanel({ controller, teacherName }: BreakoutRoomsPanelProps) {
  return (
    <div className="scrollbar-thin h-full overflow-y-auto pr-1 text-slate-900">
      {controller.role === "teacher" ? (
        <TeacherView controller={controller} teacherName={teacherName} />
      ) : (
        <StudentView controller={controller} />
      )}
    </div>
  );
}
