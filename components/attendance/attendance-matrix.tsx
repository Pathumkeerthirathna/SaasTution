/*
 * The class attendance matrix on the Attendance page: one Sri Lankan month,
 * students in rows, the class's actual lectures in columns, from GET
 * /api/classes/[id]/attendance-matrix. Presentational and read only: every
 * status comes from the API (the stored LectureAttendance record or the
 * register's finalization state); nothing is recalculated here. Manual
 * changes stay on the register page (each cell and column links to it).
 *
 * Layout: one table at every width, scrolling sideways, with the student
 * column and the header row sticky. Names, numbers and titles wrap; nothing
 * is truncated or hidden on small screens.
 */

import Link from "next/link";
import { AlertCircle, Ban, CheckCircle2, Clock, Eye, Lock, MinusCircle, UserX } from "lucide-react";

import type { AttendanceMatrix, AttendanceMatrixCell, AttendanceMatrixLecture } from "@/services/class-attendance-matrix-service";
import { registerPath } from "@/components/attendance/qr-scanner-logic";

const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Colombo" });
const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Colombo" });
const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** "HH:MM" in Asia/Colombo; "—" when absent or invalid. */
export function colomboTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "—" : TIME.format(new Date(ms));
}

/** "Mon 24 Nov" in Asia/Colombo. */
export function colomboDay(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "—" : DAY.format(new Date(ms));
}

/** "November 2026" for "2026-11". */
export function monthLabel(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  return match ? MONTH.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))) : key;
}

export type CellTone = "positive" | "warning" | "danger" | "info" | "neutral" | "muted";

/** What a cell says, exactly from the API's state (see services/class-attendance-matrix-service.ts). */
export function matrixCellLabel(cell: AttendanceMatrixCell): { label: string; tone: CellTone; time: string | null } {
  if (cell.state === "RECORD") {
    const time = cell.attendedAt ? colomboTime(cell.attendedAt) : null;
    switch (cell.status) {
      case "PRESENT":
        return { label: "Present", tone: "positive", time };
      case "LATE":
        return { label: "Late", tone: "warning", time };
      case "ABSENT":
        return { label: "Absent", tone: "danger", time };
      case "EXCUSED":
        return { label: "Excused", tone: "info", time };
      default:
        return { label: "Recorded", tone: "neutral", time };
    }
  }
  if (cell.state === "NOT_ENROLLED") return { label: "Not enrolled", tone: "muted", time: null };
  if (cell.state === "LECTURE_CANCELLED") return { label: "Lecture cancelled", tone: "muted", time: null };
  if (cell.state === "NO_RECORD") return { label: "No record", tone: "neutral", time: null };
  return { label: "Not recorded yet", tone: "neutral", time: null };
}

const TONE: Record<CellTone, string> = {
  positive: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-rose-200 bg-rose-50 text-rose-800",
  info: "border-sky-200 bg-sky-50 text-sky-800",
  neutral: "border-slate-200 bg-white text-slate-700",
  muted: "border-transparent bg-transparent text-slate-400",
};

function CellIcon({ cell }: { cell: AttendanceMatrixCell }) {
  const props = { size: 12, "aria-hidden": true } as const;
  if (cell.state === "RECORD") {
    if (cell.status === "PRESENT") return <CheckCircle2 {...props} />;
    if (cell.status === "LATE") return <Clock {...props} />;
    if (cell.status === "ABSENT") return <UserX {...props} />;
    return <MinusCircle {...props} />;
  }
  if (cell.state === "LECTURE_CANCELLED") return <Ban {...props} />;
  return null;
}

/** The column header's register line. */
export function lectureColumnState(lecture: AttendanceMatrixLecture): string {
  if (lecture.classStatus === "CANCELLED") return "Cancelled";
  if (lecture.register?.finalized) return "Finalized";
  if (lecture.register) return "Open";
  return "No attendance yet";
}

/**
 * `flush`: rendered inside a card (the Attendance workspace's control card):
 * no border or rounding of its own (the card draws them), the same internal
 * scrolling and sticky student column; empty states keep the card's padding.
 */
export function AttendanceMatrixTable({ matrix, selectedLectureId, flush = false }: { matrix: AttendanceMatrix; selectedLectureId: string | null; flush?: boolean }) {
  if (matrix.lectures.length === 0) {
    return (
      <p className={`${flush ? "m-3 " : ""}rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600`} data-matrix="empty">
        No lectures in {monthLabel(matrix.month.key)} for this class.
      </p>
    );
  }
  if (matrix.students.length === 0) {
    return (
      <p className={`${flush ? "m-3 " : ""}rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600`} data-matrix="no-students">
        No students were enrolled in this class in {monthLabel(matrix.month.key)}.
      </p>
    );
  }

  return (
    <div className={flush ? "max-h-[70vh] overflow-auto bg-white" : "max-h-[70vh] overflow-auto rounded-xl border border-slate-200 bg-white"} data-matrix="table">
      <table className="min-w-max border-separate border-spacing-0 text-left text-xs">
        <caption className="sr-only">
          Attendance of {matrix.class.name} in {monthLabel(matrix.month.key)}: students in rows, lectures in columns. Times are Sri Lankan time.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 top-0 z-30 w-40 min-w-[10rem] max-w-[14rem] border-b border-r border-slate-200 bg-slate-50 px-3 py-2 align-bottom text-[11px] font-semibold uppercase tracking-wide text-slate-500 sm:w-56">
              Student
            </th>
            {matrix.lectures.map((lecture) => {
              const selected = lecture.id === selectedLectureId;
              return (
                <th
                  key={lecture.id}
                  scope="col"
                  aria-current={selected ? "true" : undefined}
                  data-selected={selected ? "true" : undefined}
                  className={`sticky top-0 z-20 w-32 min-w-[8rem] border-b border-slate-200 px-2 py-2 align-bottom font-normal ${
                    selected ? "bg-[#112D5C] text-white" : lecture.classStatus === "CANCELLED" ? "bg-rose-50 text-slate-700" : "bg-slate-50 text-slate-700"
                  }`}
                >
                  <Link href={registerPath(lecture.id)} className="block break-words hover:underline">
                    <span className="block text-[11px] font-semibold">{colomboDay(lecture.date)}</span>
                    <span className="block text-[11px]">
                      {colomboTime(lecture.date)}
                      {lecture.endDate ? `–${colomboTime(lecture.endDate)}` : ""}
                    </span>
                    <span className="block break-words text-[11px] font-medium">{lecture.title}</span>
                  </Link>
                  <span className={`mt-1 inline-flex items-center gap-1 text-[10px] ${selected ? "text-white/80" : "text-slate-500"}`}>
                    {lecture.register?.finalized ? <Lock size={10} aria-hidden /> : null}
                    {lectureColumnState(lecture)}
                    {lecture.qrClosed ? " · QR closed" : ""}
                    {selected ? " · Selected" : ""}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {matrix.students.map((student) => (
            <tr key={student.id}>
              <th scope="row" className="sticky left-0 z-10 w-40 min-w-[10rem] max-w-[14rem] border-b border-r border-slate-200 bg-white px-3 py-2 align-top font-normal sm:w-56">
                <span className="block break-words text-sm font-medium text-slate-900">{student.name}</span>
                {student.registrationNumber ? <span className="block break-words text-[11px] text-slate-500">{student.registrationNumber}</span> : null}
                {!student.enrolled ? <span className="mt-0.5 block text-[10px] font-semibold uppercase text-slate-500">Removed from class</span> : null}
                {!student.active ? <span className="mt-0.5 block text-[10px] font-semibold uppercase text-slate-500">Inactive student</span> : null}
              </th>
              {student.cells.map((cell, index) => {
                const lecture = matrix.lectures[index];
                const label = matrixCellLabel(cell);
                const selected = lecture.id === selectedLectureId;
                return (
                  <td key={lecture.id} className={`border-b border-slate-100 px-2 py-1.5 align-top ${selected ? "bg-[#112D5C]/5" : ""}`} data-state={cell.state}>
                    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE[label.tone]}`}>
                      <CellIcon cell={cell} />
                      {label.label}
                    </span>
                    {label.time ? <span className="mt-0.5 block text-[11px] tabular-nums text-slate-600">{label.time}</span> : null}
                    {cell.pendingReview ? (
                      <span className="mt-0.5 flex items-center gap-1 text-[10px] font-semibold text-amber-800">
                        <Eye size={10} aria-hidden />
                        Review pending
                      </span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MatrixLegend() {
  return (
    <p className="flex items-start gap-1.5 text-[11px] text-slate-600">
      <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden />
      Statuses come from each lecture&apos;s attendance register. &quot;Not recorded yet&quot;: nothing recorded and the register is not finalized.
      &quot;No record&quot;: the register is finalized without a record for the student. Times are when attendance was first recorded (Sri Lankan time).
      Open a lecture to change a student&apos;s attendance.
    </p>
  );
}
