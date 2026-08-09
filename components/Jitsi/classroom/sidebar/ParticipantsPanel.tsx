"use client";

import {
  Camera,
  CameraOff,
  Mic,
  MicOff,
  Crown,
  Hand,
  BookOpenCheck,
  UserRoundX,
} from "lucide-react";

import type { ClassroomStudent, JitsiParticipant } from "../../types";
import { ClassStudent } from "@prisma/client";
import { ClassItem } from "@/components/class-management-panel";

type ParticipantsPanelProps = {
  participants: JitsiParticipant[];
  ClassroomStudents?: ClassroomStudent[];
  role : string
};

export default function ParticipantsPanel({
  participants,ClassroomStudents,role
}: ParticipantsPanelProps) {

  console.log(participants);

const presentStudents = ClassroomStudents?.filter(
  (student) =>
    participants.some(
      (participant) =>
        participant.displayName === student.displayName
    )
);

const absentStudents = ClassroomStudents?.filter(
  (student) =>
    !participants.some(
      (participant) =>
        participant.displayName === student.displayName
    )
);

console.log(presentStudents);
console.log(absentStudents);

   // =====================================================
  // STUDENT VIEW
  // =====================================================

  if (role === "student") {
    return (
      <div className="rounded-3xl border border-slate-700 bg-[#111827] p-6 shadow-xl">

        <div className="mb-5 flex items-center justify-between">

          <h3 className="text-lg font-semibold text-white">
            Participants
          </h3>

          <span className="rounded-full bg-blue-600 px-3 py-1 text-sm text-white">
            {participants.length}
          </span>

        </div>

        {participants.length === 0 ? (

          <div className="rounded-xl bg-slate-800 p-6 text-center text-slate-400">
            Waiting for participants...
          </div>

        ) : (

          <div className="space-y-3">

            {participants.map((participant) => (
              <ParticipantRow
                key={participant.participantId}
                participant={participant}
              />
            ))}

          </div>

        )}

      </div>
    );
  }

  

    return (
    <div className="rounded-3xl border border-slate-700 bg-[#111827] p-4 shadow-xl">

      {/* SUMMARY */}

      <div className="mb-5 flex items-center justify-between">

        <h3 className="text-lg font-semibold text-white">
          Class register
        </h3>

        <span className="rounded-full bg-blue-600 px-3 py-1 text-sm text-white">
          {presentStudents?.length}/{ClassroomStudents?.length}
        </span>

      </div>


      {/* PRESENT / ABSENT */}

      <div className="max-h-[calc(100vh-250px)] overflow-y-auto scrollbar-thin pr-1">

      {/* PRESENT */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-green-500" />

          <h3 className="font-semibold text-white">
            Present
          </h3>

          <span className="text-sm text-slate-400">
            {presentStudents?.length}
          </span>
        </div>

        <div className="space-y-2">
          {presentStudents?.length === 0 ? (
            <div className="rounded-xl bg-slate-800 p-3 text-center text-xs text-slate-500">
              No students
            </div>
          ) : (
            presentStudents?.map((student) => (
              <div
                key={student.studentId}
                className="flex items-center gap-3 rounded-xl bg-slate-800 px-3 py-2.5"
              >
                {/* Learning / Present Icon */}
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
                  <BookOpenCheck
                    size={17}
                    className="text-emerald-400"
                  />
                </div>

                {/* Student */}
                <div className="min-w-0">
                  <span className="block truncate text-sm font-medium text-white">
                    {student.displayName}
                  </span>

                  {/* Registration number - add later */}
                  {/* <span className="block truncate text-xs text-slate-500">
                    {student.registrationNumber}
                  </span> */}
                </div>
              </div>
            ))
          )}
        </div>
      </div>


      {/* ABSENT */}
      <div>
        <div className="mb-3 flex items-center gap-2 mt-4">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" />

          <h3 className="font-semibold text-white">
            Absent
          </h3>

          <span className="text-sm text-slate-400">
            {absentStudents?.length}
          </span>
        </div>

        <div className="space-y-2">
          {absentStudents?.length === 0 ? (
            <div className="rounded-xl bg-slate-800 p-3 text-center text-xs text-slate-500">
              No students
            </div>
          ) : (
            absentStudents?.map((student) => (
              <div
                key={student.studentId}
                className="flex items-center gap-3 rounded-xl bg-slate-800 px-3 py-2.5"
              >
                {/* Absent Icon */}
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500/10">
                  <UserRoundX
                    size={17}
                    className="text-red-400"
                  />
                </div>

                {/* Student */}
                <div className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-300">
                    {student.displayName}
                  </span>

                  {/* Registration number - add later */}
                  {/* <span className="block truncate text-xs text-slate-500">
                    {student.registrationNumber}
                  </span> */}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

    </div>

    </div>
  );

}

function ParticipantRow({
  participant,
}: {
  participant: JitsiParticipant;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-slate-800 px-4 py-3">

      <div className="flex items-center gap-3">

        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 font-semibold text-white">

          {participant.displayName?.charAt(0) ?? "?"}

        </div>

        <div>

          <div className="flex items-center gap-2">

            <span className="font-medium text-white">
              {participant.displayName ?? "Unknown User"}
            </span>

            {participant.role === "moderator" && (
              <Crown
                size={16}
                className="text-yellow-400"
              />
            )}

          </div>

        </div>

      </div>

      <div className="flex items-center gap-2">

        {participant.status?.audioMuted ?? false ? (
          <MicOff
            size={18}
            className="text-red-400"
          />
        ) : (
          <Mic
            size={18}
            className="text-green-400"
          />
        )}

        {participant.status?.videoMuted ?? false ? (
          <CameraOff
            size={18}
            className="text-red-400"
          />
        ) : (
          <Camera
            size={18}
            className="text-green-400"
          />
        )}

        {/* {participant.status.raisedHand && (
          <Hand className="h-4 w-4 text-yellow-400" />
        )} */}

      </div>

    </div>
  );
}