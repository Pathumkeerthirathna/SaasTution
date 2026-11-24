/**
 * The class attendance matrix on the teacher's Attendance page: one Sri
 * Lankan (Asia/Colombo) calendar month of a class, students in rows and the
 * class's actual Lecture rows in columns (never ClassSchedule rows). READ
 * ONLY: no transaction, no lock, never a write.
 *
 * Every cell shows what the unified attendance already stores; nothing is
 * recalculated here:
 *  - a LectureAttendance record: its status (PRESENT / LATE / ABSENT /
 *    EXCUSED, PRESENT vs LATE already decided by the register's grace rule
 *    when the evidence arrived), the earliest evidence time (firstQrAt /
 *    firstOnlineAt) and whether a review is pending;
 *  - no record: NOT_ENROLLED when the student was not enrolled at the
 *    lecture's scheduled start (the existing explainEnrolmentAt), else
 *    LECTURE_CANCELLED for a cancelled lecture, NO_RECORD when the register
 *    is finalized, NOT_RECORDED_YET otherwise. ABSENT is never inferred: it
 *    exists only as a record written by finalization or the teacher.
 *
 * Rows: students of this teacher whose enrolment in the class overlaps the
 * month (removed ones included, flagged), plus anyone with a record in the
 * month's lectures. Columns: the class's non-deleted lectures whose start is
 * in the month, oldest first.
 *
 * Fixed number of Prisma calls whatever the class size (no per-lecture or
 * per-student query): the class (with its schedules), the month's lectures,
 * the class's enrolment rows, then for the month's lecture ids the records,
 * the registers and the QR closures, then the students. 404
 * CLASS_NOT_FOUND unless the class exists (status 0) and is the teacher's.
 */

import { explainEnrolmentAt, type EnrolmentRow } from "@/lib/attendance/enrolment";
import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { sriLankaCalendarParts, sriLankaDigitsToInstant } from "@/lib/time";

export type MatrixMonth = { year: number; month: number };

export type MatrixCellState = "RECORD" | "NOT_ENROLLED" | "LECTURE_CANCELLED" | "NO_RECORD" | "NOT_RECORDED_YET";

export type AttendanceMatrixCell = {
  state: MatrixCellState;
  /** The stored LectureAttendance.status (RECORD only). */
  status: "PRESENT" | "LATE" | "ABSENT" | "EXCUSED" | null;
  /** The earliest evidence time (UTC ISO; QR or online), null without evidence. */
  attendedAt: string | null;
  /** Evidence waiting for the teacher's review. */
  pendingReview: boolean;
};

export type AttendanceMatrixLecture = {
  id: string;
  title: string;
  /** UTC ISO instants. */
  date: string;
  endDate: string | null;
  classStatus: "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";
  /** Null: no attendance recorded yet (no register row). */
  register: { finalized: boolean; finalizedAt: string | null; graceMinutes: number } | null;
  qrClosed: boolean;
};

export type AttendanceMatrixStudent = {
  id: string;
  name: string;
  registrationNumber: string | null;
  /** An open (not removed) enrolment in the class now. */
  enrolled: boolean;
  /** Student.status 0. */
  active: boolean;
  /** One cell per lecture, in the order of `lectures`. */
  cells: AttendanceMatrixCell[];
};

export type AttendanceMatrixSchedule = { id: string; dayOfWeek: string; startTime: string; endTime: string };

export type AttendanceMatrix = {
  class: { id: string; name: string; attendanceGraceMinutes: number };
  month: MatrixMonth & { key: string; previous: string; next: string };
  /** The class's weekly ClassSchedule rows (for the lecture creation dialog). */
  schedules: AttendanceMatrixSchedule[];
  lectures: AttendanceMatrixLecture[];
  students: AttendanceMatrixStudent[];
};

const MONTH_PARAM = /^(\d{4})-(\d{2})$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

export const monthKeyOf = ({ year, month }: MatrixMonth) => `${year}-${String(month).padStart(2, "0")}`;

/** The month after (+1) or before (-1). */
export function shiftMonth({ year, month }: MatrixMonth, delta: 1 | -1): MatrixMonth {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/**
 * "YYYY-MM" → the month; absent or blank → the current Sri Lankan month at
 * `now`; malformed or outside 2000–2100 → null (400).
 */
export function parseMatrixMonth(value: string | null | undefined, now: Date): MatrixMonth | null {
  if (value === null || value === undefined || value.trim() === "") {
    const { year, month } = sriLankaCalendarParts(now);
    return { year, month };
  }
  const match = MONTH_PARAM.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || year < MIN_YEAR || year > MAX_YEAR) return null;
  return { year, month };
}

/** The month as real instants: [first instant, first instant of the next month), at +05:30. */
export function colomboMonthRange(month: MatrixMonth): { start: Date; end: Date } {
  const next = shiftMonth(month, 1);
  return {
    start: sriLankaDigitsToInstant(new Date(Date.UTC(month.year, month.month - 1, 1))),
    end: sriLankaDigitsToInstant(new Date(Date.UTC(next.year, next.month - 1, 1))),
  };
}

type EnrolmentWithStudent = EnrolmentRow & { studentId: string };

/** Whether any usable enrolment row overlaps [start, end), or a row cannot be placed in time (shown rather than hidden). */
function enrolmentTouchesMonth(rows: readonly EnrolmentWithStudent[], range: { start: Date; end: Date }): boolean {
  return rows.some((row) => {
    if (!(row.assignedAt instanceof Date) || Number.isNaN(row.assignedAt.getTime())) return true;
    if (row.removedAt === null && row.isActive === false) return true;
    const from = sriLankaDigitsToInstant(row.assignedAt).getTime();
    const to = row.removedAt === null ? null : sriLankaDigitsToInstant(row.removedAt).getTime();
    if (to !== null && Number.isNaN(to)) return true;
    return from < range.end.getTime() && (to === null || to > range.start.getTime());
  });
}

const earliestIso = (a: Date | null, b: Date | null): string | null => {
  const first = a === null ? b : b === null ? a : a.getTime() <= b.getTime() ? a : b;
  return first ? first.toISOString() : null;
};

export async function getClassAttendanceMatrixForTeacher(input: {
  teacherId: string;
  classId: string;
  month: MatrixMonth;
}): Promise<AttendanceMatrix> {
  const cls = await prisma.class.findFirst({
    where: { id: input.classId, teacherId: input.teacherId, status: 0 },
    select: {
      id: true,
      name: true,
      attendanceGraceMinutes: true,
      schedules: { select: { id: true, dayOfWeek: true, startTime: true, endTime: true } },
    },
  });
  if (!cls) throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");

  const range = colomboMonthRange(input.month);

  const [lectures, enrolments] = await Promise.all([
    prisma.lecture.findMany({
      where: { classId: cls.id, status: 0, date: { gte: range.start, lt: range.end } },
      orderBy: [{ date: "asc" }, { id: "asc" }],
      select: { id: true, title: true, date: true, endDate: true, classStatus: true },
    }),
    prisma.classStudent.findMany({
      where: { classId: cls.id, student: { teacherId: input.teacherId } },
      select: { id: true, classId: true, studentId: true, assignedAt: true, removedAt: true, isActive: true },
    }),
  ]);

  const lectureIds = lectures.map((lecture) => lecture.id);
  const [records, registers, closures] = lectureIds.length
    ? await Promise.all([
        prisma.lectureAttendance.findMany({
          where: { classId: cls.id, lectureId: { in: lectureIds } },
          select: { lectureId: true, studentId: true, status: true, firstOnlineAt: true, firstQrAt: true, pendingReviewSince: true },
        }),
        prisma.lectureAttendanceRegister.findMany({
          where: { lectureId: { in: lectureIds } },
          select: { lectureId: true, scheduledStartAt: true, graceMinutes: true, finalizedAt: true },
        }),
        prisma.lectureQrAttendanceClosure.findMany({
          where: { lectureId: { in: lectureIds } },
          select: { lectureId: true },
        }),
      ])
    : [[], [], []];

  const enrolmentsBy = new Map<string, EnrolmentWithStudent[]>();
  for (const row of enrolments) {
    const list = enrolmentsBy.get(row.studentId);
    if (list) list.push(row);
    else enrolmentsBy.set(row.studentId, [row]);
  }
  const recordedIds = new Set(records.map((record) => record.studentId));
  const candidateIds = [
    ...new Set([
      ...[...enrolmentsBy.entries()].filter(([, rows]) => enrolmentTouchesMonth(rows, range)).map(([id]) => id),
      ...recordedIds,
    ]),
  ].sort();

  const students = candidateIds.length
    ? await prisma.student.findMany({
        where: { id: { in: candidateIds }, teacherId: input.teacherId },
        select: { id: true, name: true, registrationNumber: true, status: true },
      })
    : [];

  const registerBy = new Map(registers.map((register) => [register.lectureId, register]));
  const closed = new Set(closures.map((closure) => closure.lectureId));
  const recordBy = new Map(records.map((record) => [`${record.lectureId}:${record.studentId}`, record]));

  const matrixLectures = lectures.map((lecture): AttendanceMatrixLecture => {
    const register = registerBy.get(lecture.id);
    return {
      id: lecture.id,
      title: lecture.title,
      date: lecture.date.toISOString(),
      endDate: lecture.endDate ? lecture.endDate.toISOString() : null,
      classStatus: lecture.classStatus,
      register: register
        ? { finalized: register.finalizedAt !== null, finalizedAt: register.finalizedAt ? register.finalizedAt.toISOString() : null, graceMinutes: register.graceMinutes }
        : null,
      qrClosed: closed.has(lecture.id),
    };
  });

  const rows = [...students]
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((student): AttendanceMatrixStudent => {
      const studentEnrolments = enrolmentsBy.get(student.id) ?? [];
      return {
        id: student.id,
        name: student.name,
        registrationNumber: student.registrationNumber,
        enrolled: studentEnrolments.some((row) => row.isActive && row.removedAt === null),
        active: student.status === 0,
        cells: lectures.map((lecture): AttendanceMatrixCell => {
          const record = recordBy.get(`${lecture.id}:${student.id}`);
          if (record) {
            return {
              state: "RECORD",
              status: record.status,
              attendedAt: earliestIso(record.firstQrAt, record.firstOnlineAt),
              pendingReview: record.pendingReviewSince !== null,
            };
          }
          const register = registerBy.get(lecture.id);
          const start = register?.scheduledStartAt ?? lecture.date;
          const state: MatrixCellState = !explainEnrolmentAt(studentEnrolments, cls.id, start).enrolled
            ? "NOT_ENROLLED"
            : lecture.classStatus === "CANCELLED"
              ? "LECTURE_CANCELLED"
              : register?.finalizedAt
                ? "NO_RECORD"
                : "NOT_RECORDED_YET";
          return { state, status: null, attendedAt: null, pendingReview: false };
        }),
      };
    });

  const weekdayOrder = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const schedules = [...cls.schedules].sort(
    (a, b) => weekdayOrder.indexOf(a.dayOfWeek) - weekdayOrder.indexOf(b.dayOfWeek) || a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id)
  );

  return {
    class: { id: cls.id, name: cls.name, attendanceGraceMinutes: cls.attendanceGraceMinutes },
    month: {
      ...input.month,
      key: monthKeyOf(input.month),
      previous: monthKeyOf(shiftMonth(input.month, -1)),
      next: monthKeyOf(shiftMonth(input.month, 1)),
    },
    schedules: schedules.map((s) => ({ id: s.id, dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime })),
    lectures: matrixLectures,
    students: rows,
  };
}
