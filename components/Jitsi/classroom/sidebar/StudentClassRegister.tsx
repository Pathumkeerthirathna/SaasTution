"use client";

import { BookOpenCheck, UserRoundX } from "lucide-react";

import type { ClassroomStudent, JitsiParticipant } from "../../types";
import { splitClassRegister } from "../../class-register.mjs";

type StudentClassRegisterProps = {
  participants: JitsiParticipant[];
  /** The class roster (names only for students; see GET /api/sessions/[id]/register). */
  students?: ClassroomStudent[];
  /** The viewing student, marked "(You)". */
  currentStudentId?: string;
  breakoutRoomLabels?: Record<string, string>;
};

/**
 * The student's Class Register: the same present / absent split and design
 * as the teacher's register (ParticipantsPanel), strictly read-only. No
 * notify, mute, camera or attendance controls.
 */
export default function StudentClassRegister({
  participants,
  students,
  currentStudentId,
  breakoutRoomLabels,
}: StudentClassRegisterProps) {
  const { present, absent, elsewhereLabel } = splitClassRegister(
    students,
    participants,
    breakoutRoomLabels
  );

  if (!students) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-5 text-center text-sm text-slate-400">
        Loading class register...
      </div>
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
              {present.length}
            </span>
          </div>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {present.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-2.5 text-center text-xs text-slate-400">
              No students
            </div>
          ) : (
            present.map((student) => (
              <div
                key={student.studentId}
                className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-100">
                  <BookOpenCheck size={14} className="text-emerald-700" />
                </div>

                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-900">
                    {student.displayName}
                    {student.studentId === currentStudentId ? (
                      <span className="ml-1 font-normal text-slate-500">(You)</span>
                    ) : null}
                  </span>
                  {elsewhereLabel(student.displayName) ? (
                    <span className="mt-0.5 inline-flex rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">
                      In {elsewhereLabel(student.displayName)}
                    </span>
                  ) : null}
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
              {absent.length}
            </span>
          </div>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {absent.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-2.5 text-center text-xs text-slate-400">
              No students
            </div>
          ) : (
            absent.map((student) => (
              <div
                key={student.studentId}
                className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-red-100">
                  <UserRoundX size={14} className="text-red-600" />
                </div>

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

    </div>
  );
}
