"use client";

import { useState } from "react";
import toast from "react-hot-toast";

import {
  Camera,
  CameraOff,
  Mic,
  MicOff,
  Crown,
  BookOpenCheck,
  UserRoundX,
  Bell,
  X,
  Send,
  Loader2,
} from "lucide-react";

import type { ClassroomStudent, JitsiParticipant } from "../../types";
import { ClassStudent } from "@prisma/client";
import { ClassItem } from "@/components/class-management-panel";

type ParticipantsPanelProps = {
  participants: JitsiParticipant[];
  ClassroomStudents?: ClassroomStudent[];
  role : string
  lectureTitle?: string;
  className?: string;
  classId?: string;
};

export default function ParticipantsPanel({
  participants,ClassroomStudents,role,
  lectureTitle,
  className,
  classId,
}: ParticipantsPanelProps) {

  console.log(participants);

  const [showNotify, setShowNotify] = useState(false);

  const [selectedAbsentIds, setSelectedAbsentIds] =
    useState<Set<string>>(new Set());

  const [notifyMessage, setNotifyMessage] = useState("");

  const [isSendingNotify, setIsSendingNotify] =
    useState(false);

  const toggleAbsentSelected = (studentId: string) => {
    setSelectedAbsentIds((current) => {
      const next = new Set(current);

      if (next.has(studentId)) {
        next.delete(studentId);
      } else {
        next.add(studentId);
      }

      return next;
    });
  };

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

  const handleSendNotifyEmails = async () => {
    if (!classId || selectedAbsentIds.size === 0) {
      return;
    }

    setIsSendingNotify(true);

    try {
      const response = await fetch(
        `/api/classes/${classId}/notify-absent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            studentIds: Array.from(selectedAbsentIds),
            message: notifyMessage,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(
          data.error ?? "Unable to send notification emails."
        );
      }

      toast.success(
        `Sending emails to ${data.queued} student${
          data.queued === 1 ? "" : "s"
        }.`
      );

      setShowNotify(false);
    } catch (error) {
      console.error(
        "❌ Failed to send notification emails:",
        error
      );

      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to send notification emails."
      );
    } finally {
      setIsSendingNotify(false);
    }
  };

   // =====================================================
  // STUDENT VIEW
  // =====================================================

  if (role === "student") {
    return (
      <div className="flex h-full min-h-0 flex-col">

        {participants.length === 0 ? (

          <div className="rounded-lg bg-[#1E293B] p-5 text-center text-sm text-[#94A3B8]">
            Waiting for participants...
          </div>

        ) : (

          <div className="scrollbar-thin min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">

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
    <div className="flex h-full min-h-0 flex-col gap-3 text-slate-900">

      {/* PRESENT */}
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-slate-200 bg-white p-3 shadow-sm">

        <div className="mb-2 flex shrink-0 items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />

          <h3 className="text-sm font-semibold text-slate-900">
            Present
          </h3>

          <span className="rounded-full bg-emerald-100 px-1.5 text-xs font-semibold text-emerald-700">
            {presentStudents?.length ?? 0}
          </span>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {presentStudents?.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-2.5 text-center text-xs text-slate-400">
              No students
            </div>
          ) : (
            presentStudents?.map((student) => (
              <div
                key={student.studentId}
                className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2"
              >
                {/* Learning / Present Icon */}
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-100">
                  <BookOpenCheck
                    size={14}
                    className="text-emerald-700"
                  />
                </div>

                {/* Student */}
                <div className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-900">
                    {student.displayName}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>


      {/* ABSENT */}
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-slate-200 bg-white p-3 shadow-sm">

        <div className="mb-2 flex shrink-0 items-center justify-between gap-2">

          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />

            <h3 className="text-sm font-semibold text-slate-900">
              Absent
            </h3>

            <span className="rounded-full bg-red-100 px-1.5 text-xs font-semibold text-red-700">
              {absentStudents?.length ?? 0}
            </span>
          </div>

          <button
            type="button"
            title="Notify absent students"
            disabled={!absentStudents || absentStudents.length === 0}
            onClick={() => {
              setSelectedAbsentIds(
                new Set(
                  absentStudents?.map(
                    (student) => student.studentId
                  ) ?? []
                )
              );

              setNotifyMessage(
                `Hi,\n\nClass has started for ${
                  className ?? "your class"
                } - ${
                  lectureTitle ?? "your lecture"
                }. Please join as soon as you can.\n\nThank you.`
              );

              setShowNotify(true);
            }}
            className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Bell size={12} />
            Notify
          </button>

        </div>

        <div className="scrollbar-thin min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {absentStudents?.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-2.5 text-center text-xs text-slate-400">
              No students
            </div>
          ) : (
            absentStudents?.map((student) => (
              <div
                key={student.studentId}
                className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2"
              >
                {/* Absent Icon */}
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-red-100">
                  <UserRoundX
                    size={14}
                    className="text-red-600"
                  />
                </div>

                {/* Student */}
                <div className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-600">
                    {student.displayName}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {showNotify && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">

            {/* Header */}
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Notify Absent Students
                </h3>

                <p className="mt-1 text-xs text-slate-500">
                  Send an email to the selected students below.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setShowNotify(false)}
                className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              >
                <X size={16} />
              </button>
            </div>

            {/* Selected absent students */}
            <div className="mb-4">
              <div className="mb-2 text-xs font-medium text-slate-500">
                {selectedAbsentIds.size} of {absentStudents?.length ?? 0} selected
              </div>

              <div className="scrollbar-thin max-h-40 space-y-1.5 overflow-y-auto pr-1">
                {absentStudents?.map((student) => (
                  <label
                    key={student.studentId}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 hover:bg-slate-100"
                  >
                    <input
                      type="checkbox"
                      checked={selectedAbsentIds.has(student.studentId)}
                      onChange={() =>
                        toggleAbsentSelected(student.studentId)
                      }
                      className="h-4 w-4 rounded border-slate-300 accent-[#3B82F6]"
                    />

                    <span className="truncate text-sm text-slate-800">
                      {student.displayName}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Message */}
            <div className="mb-4">
              <label className="mb-1.5 block text-xs font-medium text-slate-500">
                Message
              </label>

              <textarea
                value={notifyMessage}
                onChange={(e) => setNotifyMessage(e.target.value)}
                rows={5}
                className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-[#3B82F6]"
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSendNotifyEmails}
                disabled={
                  selectedAbsentIds.size === 0 || isSendingNotify
                }
                className="flex items-center gap-2 rounded-lg bg-[#3B82F6] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#2563EB] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSendingNotify ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Send size={14} />
                )}
                {isSendingNotify ? "Sending..." : "Send Emails"}
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );

}

function ParticipantRow({
  participant,
}: {
  participant: JitsiParticipant;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-[#1E293B] px-3 py-2">

      <div className="flex items-center gap-2.5">

        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#3B82F6] text-sm font-semibold text-white">

          {participant.displayName?.charAt(0) ?? "?"}

        </div>

        <div>

          <div className="flex items-center gap-1.5">

            <span className="text-sm font-medium text-[#F8FAFC]">
              {participant.displayName ?? "Unknown User"}
            </span>

            {participant.role === "moderator" && (
              <Crown
                size={14}
                className="text-yellow-400"
              />
            )}

          </div>

        </div>

      </div>

      <div className="flex items-center gap-1.5">

        {participant.status?.audioMuted ?? false ? (
          <MicOff
            size={15}
            className="text-red-400"
          />
        ) : (
          <Mic
            size={15}
            className="text-[#22C55E]"
          />
        )}

        {participant.status?.videoMuted ?? false ? (
          <CameraOff
            size={15}
            className="text-red-400"
          />
        ) : (
          <Camera
            size={15}
            className="text-[#22C55E]"
          />
        )}

      </div>

    </div>
  );
}
