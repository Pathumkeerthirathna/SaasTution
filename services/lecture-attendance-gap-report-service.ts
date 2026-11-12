/**
 * Unified lecture attendance, Stage 5.4f-3: online attendance gap report.
 * See docs/lecture-attendance.md ("Online attendance gap report").
 *
 * READ ONLY. For the requesting teacher's LIVE, open lectures, how many
 * students' eligible online visits are not yet represented in canonical
 * attendance (what reconciliation would repair, and what blocks
 * finalization). Request-driven; no worker. Plain autocommit reads only: no
 * attendance transaction, no row locks, no register creation, no writes, no
 * reconciliation or backfill calls (a static test guard enforces this).
 *
 * Lecture selection (one database query per page, ordered by lecture id):
 * the teacher's lectures (Lecture.class.teacherId), not deleted (status 0),
 * not CANCELLED, and LIVE + open: either no register and Lecture.date >=
 * ATTENDANCE_EVIDENCE_STARTED_AT, or an open register (finalizedAt null)
 * whose scheduledStartAt >= it (the same LIVE / HISTORICAL rule as
 * classifyLecture: the register's start, else the lecture date).
 *
 * Gap calculation: the existing pure evidenceRepresentation helper
 * (services/lecture-attendance-service.ts) on the same inputs getRegister
 * gives it (student, approval history, enrolments in the class, the record's
 * source and firstOnlineAt, the visits' joinedAt). Per student, V = the
 * earliest visit eligible at its own join time; represented when a record
 * exists with firstOnlineAt <= V. The eligible total comes from the SAME
 * helper run once more with no records (then every student with an eligible
 * visit is "pending"), so no eligibility logic is duplicated here.
 *
 * Output: counts per lecture and the cursor only (no names, student / visit
 * ids, times or hashes). Nothing is logged.
 */

import {
  classifyLecture,
  requireApprovalContext,
  requireEvidenceStartedAt,
} from "@/lib/attendance/config";
import { attendanceError } from "@/lib/attendance/service-errors";
import { prisma } from "@/lib/prisma";
import type { ApprovalHistoryContext } from "@/lib/student-confirmation-history";
import { evidenceRepresentation, type RepresentationStudent } from "@/services/lecture-attendance-service";

type Env = Record<string, string | undefined>;

export const GAP_REPORT_DEFAULT_LIMIT = 100;
export const GAP_REPORT_MAX_LIMIT = 500;

export type GapReportInput = {
  teacherId: string;
  /** The previous page's nextCursor (the last lecture id returned); omit for the first page. */
  cursor?: string | null;
  /** Lectures per page: 1–500 (default 100). */
  limit?: number | null;
};

export type LectureGap = {
  lectureId: string;
  /** Online visits (Attendance rows) of the teacher's students to the lecture's sessions. */
  visits: number;
  /** Distinct students with at least one such visit. */
  studentsWithVisits: number;
  /** Students with a visit eligible at its own join time (each counted once: their earliest eligible visit). */
  eligibleStudents: number;
  /** Of those, the canonical record represents the earliest eligible visit. */
  representedStudents: number;
  /** Of those, not represented (reconciliation would repair; blocks finalization). */
  pendingStudents: number;
  /** No record and a visit whose approval was UNKNOWN at its join time (teacher review; blocks finalization). */
  unknownEligibilityStudents: number;
};

export type GapReport = {
  lectures: LectureGap[];
  totals: { lectures: number; lecturesWithGaps: number; pendingStudents: number; unknownEligibilityStudents: number };
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
};

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 191) {
    throw attendanceError("VALIDATION_ERROR", { field });
  }
}

/**
 * The teacher's online attendance gaps, one page of LIVE open lectures in
 * lecture-id order (see the module header). Errors: 400 VALIDATION_ERROR
 * (`details.field`), 503 ATTENDANCE_APPROVAL_NOT_CONFIGURED /
 * ATTENDANCE_EVIDENCE_NOT_CONFIGURED (nothing is read).
 */
export async function getOnlineAttendanceGapReport(input: GapReportInput, options: { env?: Env } = {}): Promise<GapReport> {
  assertId(input.teacherId, "teacherId");
  const cursor = input.cursor ?? null;
  if (cursor !== null) assertId(cursor, "cursor");
  const limit = input.limit ?? GAP_REPORT_DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > GAP_REPORT_MAX_LIMIT) {
    throw attendanceError("VALIDATION_ERROR", { field: "limit" });
  }

  const env = options.env ?? process.env;
  const context = requireApprovalContext(env);
  const evidenceStartedAt = requireEvidenceStartedAt(env);
  const teacherId = input.teacherId;

  const rows = await prisma.lecture.findMany({
    where: {
      class: { teacherId },
      status: 0,
      classStatus: { not: "CANCELLED" },
      ...(cursor !== null ? { id: { gt: cursor } } : {}),
      OR: [
        { attendanceRegister: { is: null }, date: { gte: evidenceStartedAt } },
        { attendanceRegister: { is: { finalizedAt: null, scheduledStartAt: { gte: evidenceStartedAt } } } },
      ],
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      classId: true,
      date: true,
      attendanceRegister: { select: { scheduledStartAt: true, finalizedAt: true } },
    },
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit && page.length ? page[page.length - 1].id : null;

  const lectures: LectureGap[] = [];
  // One lecture at a time: memory is bounded by the largest lecture, not the page.
  for (const lecture of page) {
    // Defensive: the query already selected exactly these.
    const register = lecture.attendanceRegister;
    if (register?.finalizedAt) continue;
    if (classifyLecture(register?.scheduledStartAt ?? lecture.date, evidenceStartedAt) !== "LIVE") continue;
    lectures.push(await lectureGap(lecture.id, lecture.classId, teacherId, context));
  }

  return {
    lectures,
    totals: {
      lectures: lectures.length,
      lecturesWithGaps: lectures.filter((l) => l.pendingStudents > 0 || l.unknownEligibilityStudents > 0).length,
      pendingStudents: lectures.reduce((sum, l) => sum + l.pendingStudents, 0),
      unknownEligibilityStudents: lectures.reduce((sum, l) => sum + l.unknownEligibilityStudents, 0),
    },
    nextCursor,
  };
}

async function lectureGap(lectureId: string, classId: string, teacherId: string, context: ApprovalHistoryContext): Promise<LectureGap> {
  const visitRows = await prisma.attendance.findMany({
    where: { classSession: { lectureId } },
    select: { studentId: true, joinedAt: true },
  });
  const visitedIds = [...new Set(visitRows.map((v) => v.studentId))].sort();

  const empty: LectureGap = {
    lectureId,
    visits: 0,
    studentsWithVisits: 0,
    eligibleStudents: 0,
    representedStudents: 0,
    pendingStudents: 0,
    unknownEligibilityStudents: 0,
  };
  if (visitedIds.length === 0) return empty;

  // Only the teacher's own students (as getRegister); visits of anyone else are not this teacher's evidence.
  const students = await prisma.student.findMany({
    where: { id: { in: visitedIds }, teacherId },
    select: { id: true, status: true, confirmationStatus: true, confirmedAt: true, approvedAt: true },
  });
  const ids = students.map((s) => s.id);
  if (ids.length === 0) return empty;

  const [history, enrolments, records] = await Promise.all([
    prisma.studentConfirmationHistory.findMany({
      where: { studentId: { in: ids } },
      select: { id: true, studentId: true, fromStatus: true, toStatus: true, decidedAt: true, previousConfirmedAt: true },
    }),
    prisma.classStudent.findMany({
      where: { classId, studentId: { in: ids } },
      select: { id: true, classId: true, studentId: true, assignedAt: true, removedAt: true, isActive: true },
    }),
    prisma.lectureAttendance.findMany({
      where: { lectureId, studentId: { in: ids } },
      select: { studentId: true, statusSource: true, firstOnlineAt: true },
    }),
  ]);

  const historyBy = groupBy(history, (h) => h.studentId);
  const enrolmentsBy = groupBy(enrolments, (e) => e.studentId);
  const visitsBy = groupBy(visitRows, (v) => v.studentId);
  const recordBy = new Map(records.map((r) => [r.studentId, r]));

  const inputs: RepresentationStudent[] = students.map((s) => {
    const record = recordBy.get(s.id);
    return {
      studentId: s.id,
      student: s,
      history: historyBy.get(s.id) ?? [],
      enrolments: enrolmentsBy.get(s.id) ?? [],
      record: record ? { statusSource: record.statusSource, firstOnlineAt: record.firstOnlineAt } : null,
      visitTimes: (visitsBy.get(s.id) ?? []).map((v) => v.joinedAt),
    };
  });

  const actual = evidenceRepresentation({ classification: "LIVE", classId, context, students: inputs });
  // The same helper with no records: every student with an eligible visit is then pending.
  const eligible = evidenceRepresentation({
    classification: "LIVE",
    classId,
    context,
    students: inputs.map((s) => ({ ...s, record: null })),
  });

  const eligibleStudents = eligible.pending.length;
  const pendingStudents = actual.pending.length;
  return {
    lectureId,
    visits: inputs.reduce((sum, s) => sum + s.visitTimes.length, 0),
    studentsWithVisits: inputs.length,
    eligibleStudents,
    representedStudents: eligibleStudents - pendingStudents,
    pendingStudents,
    unknownEligibilityStudents: actual.unknownVisits.length,
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}
