"use client";

import { useState } from "react";
import toast from "react-hot-toast";

import {
  Camera,
  CameraOff,
  Mic,
  MicOff,
  BookOpenCheck,
  UserRound,
  UserRoundX,
  Bell,
  X,
  Send,
  Loader2,
} from "lucide-react";

import type { ClassroomStudent, JitsiParticipant } from "../../types";
import { splitClassRegister } from "../../class-register.mjs";
import { liveParticipantForStudent, type StudentLocation } from "../../participant-identity.mjs";
import StudentClassRegister from "./StudentClassRegister";
import { ClassStudent } from "@prisma/client";
import { ClassItem } from "@/components/class-management-panel";

type ParticipantsPanelProps = {
  participants: JitsiParticipant[];
  ClassroomStudents?: ClassroomStudent[];
  role : string
  lectureTitle?: string;
  className?: string;
  classId?: string;
  onMuteEveryone?: () => void;
  onMuteParticipant?: (participantId: string, muted: boolean) => void;
  /**
   * studentId -> where that class student is: this room (roomLabel null) or
   * another room ("Main room" / a breakout room name; they are in the class, so
   * they must not show as absent). Matched by participant ID, never by name.
   */
  studentLocations?: Map<string, StudentLocation>;
  /** Teacher register only: live participants that are not a class student. */
  otherParticipants?: JitsiParticipant[];
  /** Student register only: the viewing student. */
  currentStudentId?: string;
};

export default function ParticipantsPanel({
  participants,ClassroomStudents,role,
  lectureTitle,
  className,
  classId,
  onMuteEveryone,
  onMuteParticipant,
  studentLocations,
  otherParticipants,
  currentStudentId,
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

// Present / absent (shared with the student's register, class-register.mjs).
// A student in another room (e.g. a breakout room) is still in the class.
const register = splitClassRegister(ClassroomStudents, studentLocations);
const elsewhereLabel = register.elsewhereLabel;

const presentStudents = ClassroomStudents ? register.present : undefined;

const absentStudents = ClassroomStudents ? register.absent : undefined;

console.log(presentStudents);
console.log(absentStudents);

  // Match a class student to their live Jitsi participant by the participant ID
  // they registered (never by display name: names repeat and can change), so we
  // can show mic/camera state and let the teacher mute exactly that student.
  const participantFor = (studentId: string) =>
    liveParticipantForStudent(studentId, studentLocations, participants);

  const others = otherParticipants ?? [];

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

  // Read-only Class Register: no notify / mute / camera / attendance controls.
  if (role === "student") {
    return (
      <StudentClassRegister
        students={ClassroomStudents}
        currentStudentId={currentStudentId}
        studentLocations={studentLocations}
      />
    );
  }



    return (
    <div className="flex h-full min-h-0 flex-col gap-3 text-slate-900">

      {/* PRESENT */}
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-slate-200 bg-white p-3 shadow-sm">

        <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />

            <h3 className="text-sm font-semibold text-slate-900">
              Present
            </h3>

            <span className="rounded-full bg-emerald-100 px-1.5 text-xs font-semibold text-emerald-700">
              {presentStudents?.length ?? 0}
            </span>
          </div>

          {onMuteEveryone ? (
            <button
              type="button"
              title="Mute everyone's microphone"
              disabled={!presentStudents || presentStudents.length === 0}
              onClick={() => onMuteEveryone()}
              className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <MicOff size={12} />
              Mute all
            </button>
          ) : null}
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {presentStudents?.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-2.5 text-center text-xs text-slate-400">
              No students
            </div>
          ) : (
            presentStudents?.map((student) => {
              const participant = participantFor(student.studentId);
              const audioMuted = participant?.status?.audioMuted ?? true;
              const videoMuted = participant?.status?.videoMuted ?? true;

              return (
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
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900">
                      {student.displayName}
                    </span>
                    {elsewhereLabel(student.studentId) ? (
                      <span className="mt-0.5 inline-flex rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">
                        In {elsewhereLabel(student.studentId)}
                      </span>
                    ) : null}
                  </div>

                  {/* Live mic / camera state — the mic icon is the mute toggle:
                      click a red (muted) mic to ask the student to unmute, click
                      a green (live) mic to mute them. */}
                  <div className="flex shrink-0 items-center gap-1.5">
                    {onMuteParticipant && participant ? (
                      <button
                        type="button"
                        title={
                          audioMuted
                            ? "Ask this student to unmute"
                            : "Mute this student"
                        }
                        onClick={() =>
                          onMuteParticipant(participant.participantId, !audioMuted)
                        }
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md transition hover:bg-slate-100"
                      >
                        {audioMuted ? (
                          <MicOff size={15} className="text-red-500" />
                        ) : (
                          <Mic size={15} className="text-emerald-600" />
                        )}
                      </button>
                    ) : audioMuted ? (
                      <MicOff size={15} className="text-red-500" />
                    ) : (
                      <Mic size={15} className="text-emerald-600" />
                    )}

                    {videoMuted ? (
                      <CameraOff size={15} className="text-red-500" />
                    ) : (
                      <Camera size={15} className="text-emerald-600" />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>


      {/* OTHER PARTICIPANTS: live in this room but not matched to a class
          student by participant ID (a co-host, or a student whose registration
          has not arrived). Shown by their Jitsi name; never treated as a student. */}
      {others.length > 0 ? (
        <div className="flex shrink-0 flex-col rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="mb-2 flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-slate-400" />

            <h3 className="text-sm font-semibold text-slate-900">
              Other participants
            </h3>

            <span className="rounded-full bg-slate-100 px-1.5 text-xs font-semibold text-slate-600">
              {others.length}
            </span>
          </div>

          <div className="scrollbar-thin max-h-40 space-y-1.5 overflow-y-auto pr-1">
            {others.map((other) => (
              <div
                key={other.participantId}
                className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100">
                  <UserRound size={14} className="text-slate-500" />
                </div>

                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-700">
                    {other.displayName || "Unnamed participant"}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-slate-400">
                    Not matched to a class student
                  </span>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {(other.status?.audioMuted ?? true) ? (
                    <MicOff size={15} className="text-red-500" />
                  ) : (
                    <Mic size={15} className="text-emerald-600" />
                  )}

                  {(other.status?.videoMuted ?? true) ? (
                    <CameraOff size={15} className="text-red-500" />
                  ) : (
                    <Camera size={15} className="text-emerald-600" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}


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
