/**
 * Shared attendance percentage service (Stage 5.7b-3h, foundation only: NO
 * consumer uses it yet; every existing percentage still reads the legacy
 * Attendance table unchanged). READ ONLY: plain reads, no transaction, no
 * lock, never a write. The rule is lib/attendance/percentage.ts; this module
 * only gathers and normalizes the data, with a fixed number of batched
 * queries per call (never one per class, lecture or student).
 *
 * Per student and lecture (see percentage.ts):
 *  - the lecture is considered only when it is not deleted (nor its class),
 *    not CANCELLED, HELD (started, and its scheduled end passed or it is
 *    COMPLETED) and the student was enrolled at its scheduled start
 *    ([assignedAt, removedAt), explainEnrolmentAt). The schedule is the
 *    register's when one exists, else the lecture's date / endDate;
 *  - a canonical LectureAttendance record decides alone (its status);
 *  - without a record: a finalized register → UNRESOLVED; otherwise an
 *    ELIGIBLE legacy online visit (attendanceEligibilityAt at its joinedAt:
 *    active, known approved, enrolled; and the class teacher's student, as
 *    online evidence requires) → ATTENDED, else PENDING. Legacy visits are
 *    read ONLY for those lectures (never alongside a record).
 *
 * Configuration: APPROVAL_FEATURE_STARTED_AT is required (visit eligibility
 * needs it): 503 ATTENDANCE_APPROVAL_NOT_CONFIGURED otherwise, before any
 * read (fail closed, as every attendance service). Visit durations are not
 * part of this service.
 */

import { requireApprovalContext } from "@/lib/attendance/config";
import { attendanceEligibilityAt, type EligibilityStudent } from "@/lib/attendance/eligibility";
import { explainEnrolmentAt, type EnrolmentRow } from "@/lib/attendance/enrolment";
import {
  combineAttendanceSummaries,
  lectureOutcome,
  lectureScope,
  summarizeAttendance,
  type AttendanceSummary,
  type CanonicalAttendanceStatus,
  type LectureAttendanceOutcome,
  type LectureOutcomeSource,
  type LectureScopeReason,
} from "@/lib/attendance/percentage";
import { attendanceError } from "@/lib/attendance/service-errors";
import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import type { ApprovalHistoryContext, ApprovalHistoryEntry } from "@/lib/student-confirmation-history";

type Env = Record<string, string | undefined>;

export type LectureAttendanceDetail = {
  lectureId: string;
  classId: string;
  outcome: LectureAttendanceOutcome;
  source: LectureOutcomeSource;
  /** Why the lecture is not considered (EXCLUDED only). */
  excludedBecause: LectureScopeReason | null;
  /** The schedule's start used for this lecture (the register's, else the lecture's). */
  scheduledStartAt: Date;
};

export type ClassAttendancePercentage = {
  classId: string;
  className: string;
  /** The student has an active enrolment in the class now. */
  currentlyEnrolled: boolean;
  summary: AttendanceSummary;
};

export type StudentAttendancePercentages = {
  studentId: string;
  /** Every class the student has (or had) an enrolment row in (deleted classes left out; the teacher's only when teacherId is given). */
  classes: ClassAttendancePercentage[];
  /** The classes' counts added together; the percentage recomputed from them. */
  overall: AttendanceSummary;
  /** Per lecture (only with includeLectures). */
  lectures?: LectureAttendanceDetail[];
};

export type ClassStudentsAttendancePercentages = {
  classId: string;
  className: string;
  /** Students with an active enrolment who are not deleted (the class roster as the in-session summary lists it). */
  students: { studentId: string; name: string; summary: AttendanceSummary; lectures?: LectureAttendanceDetail[] }[];
};

export type PercentageOptions = { now?: Date; env?: Env };

// ---- Shared normalization --------------------------------------------------------------

type LectureRow = { id: string; classId: string; status: number; classStatus: string; date: Date; endDate: Date | null };
type RegisterRow = { lectureId: string; scheduledStartAt: Date; scheduledEndAt: Date | null; finalizedAt: Date | null };
type StudentRow = EligibilityStudent & { id: string; teacherId: string };
type ClassRow = { id: string; name: string; teacherId: string; status: number };

const enrolmentRow = (row: { id: string; classId: string; assignedAt: Date; removedAt: Date | null; isActive: boolean }): EnrolmentRow => ({
  id: row.id,
  classId: row.classId,
  assignedAt: row.assignedAt,
  removedAt: row.removedAt,
  isActive: row.isActive,
});

const pairKey = (lectureId: string, studentId: string) => `${lectureId}\u0000${studentId}`;

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 191) throw attendanceError("VALIDATION_ERROR", { field });
}

function nowOf(options: PercentageOptions): Date {
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new RangeError("Attendance percentage: a valid time is required.");
  return now;
}

/** The schedule attendance uses: the register's when it exists, else the lecture's (as ensureRegister would copy it). */
function scheduleOf(lecture: LectureRow, register: RegisterRow | undefined) {
  return register
    ? { scheduledStartAt: register.scheduledStartAt, scheduledEndAt: register.scheduledEndAt }
    : { scheduledStartAt: lecture.date, scheduledEndAt: lecture.endDate };
}

type Evaluation = {
  lecture: LectureRow;
  studentId: string;
  scheduledStartAt: Date;
  scope: ReturnType<typeof lectureScope>;
  canonicalStatus: CanonicalAttendanceStatus | null;
  registerFinalized: boolean;
};

/** Phase 1: scope and canonical state of each (lecture, student); which pairs need the legacy fallback. */
function evaluatePairs(input: {
  lectures: readonly LectureRow[];
  classesById: ReadonlyMap<string, ClassRow>;
  registers: ReadonlyMap<string, RegisterRow>;
  records: ReadonlyMap<string, CanonicalAttendanceStatus>;
  studentIds: readonly string[];
  enrolmentsByStudent: ReadonlyMap<string, EnrolmentRow[]>;
  now: Date;
}): Evaluation[] {
  const out: Evaluation[] = [];
  for (const lecture of input.lectures) {
    const register = input.registers.get(lecture.id);
    const schedule = scheduleOf(lecture, register);
    const cls = input.classesById.get(lecture.classId);
    for (const studentId of input.studentIds) {
      const enrolments = input.enrolmentsByStudent.get(studentId) ?? [];
      const scope = lectureScope({
        deleted: lecture.status !== 0 || !cls || cls.status !== 0,
        classStatus: lecture.classStatus,
        ...schedule,
        enrolledAtStart: explainEnrolmentAt(enrolments, lecture.classId, schedule.scheduledStartAt).enrolled,
        now: input.now,
      });
      out.push({
        lecture,
        studentId,
        scheduledStartAt: schedule.scheduledStartAt,
        scope,
        canonicalStatus: input.records.get(pairKey(lecture.id, studentId)) ?? null,
        registerFinalized: Boolean(register?.finalizedAt),
      });
    }
  }
  return out;
}

const needsLegacy = (e: Evaluation) => e.scope.considered && e.canonicalStatus === null && !e.registerFinalized;

/** Whether any of these visits was eligible at its own join time (online evidence's rule). */
function hasEligibleVisit(input: {
  joinTimes: readonly Date[];
  student: StudentRow;
  cls: ClassRow;
  history: readonly ApprovalHistoryEntry[];
  enrolments: readonly EnrolmentRow[];
  context: ApprovalHistoryContext;
}): boolean {
  if (input.student.teacherId !== input.cls.teacherId) return false;
  return input.joinTimes.some(
    (instant) =>
      attendanceEligibilityAt({
        student: input.student,
        history: input.history,
        enrolments: input.enrolments,
        classId: input.cls.id,
        instant,
        context: input.context,
      }).outcome === "ELIGIBLE"
  );
}

const STUDENT_SELECT = { id: true, status: true, teacherId: true, confirmationStatus: true, confirmedAt: true, approvedAt: true } as const;
const HISTORY_SELECT = { id: true, studentId: true, fromStatus: true, toStatus: true, decidedAt: true, previousConfirmedAt: true } as const;
const ENROLMENT_SELECT = { id: true, studentId: true, classId: true, assignedAt: true, removedAt: true, isActive: true } as const;
const LECTURE_SELECT = { id: true, classId: true, status: true, classStatus: true, date: true, endDate: true } as const;
const REGISTER_SELECT = { lectureId: true, scheduledStartAt: true, scheduledEndAt: true, finalizedAt: true } as const;

/** Legacy visits only for the pairs that need the fallback: one query, grouped by (lecture, student). */
async function readLegacyJoinTimes(pairs: readonly Evaluation[]): Promise<Map<string, Date[]>> {
  const joins = new Map<string, Date[]>();
  if (pairs.length === 0) return joins;
  const lectureIds = [...new Set(pairs.map((p) => p.lecture.id))];
  const studentIds = [...new Set(pairs.map((p) => p.studentId))];
  const wanted = new Set(pairs.map((p) => pairKey(p.lecture.id, p.studentId)));
  const visits = await prisma.attendance.findMany({
    where: { studentId: { in: studentIds }, classSession: { lectureId: { in: lectureIds } } },
    select: { studentId: true, joinedAt: true, classSession: { select: { lectureId: true } } },
  });
  for (const visit of visits) {
    const lectureId = visit.classSession.lectureId;
    if (!lectureId) continue;
    const key = pairKey(lectureId, visit.studentId);
    if (!wanted.has(key)) continue;
    const list = joins.get(key) ?? [];
    list.push(visit.joinedAt);
    joins.set(key, list);
  }
  return joins;
}

function detailOf({ evaluation, result }: { evaluation: Evaluation; result: ReturnType<typeof lectureOutcome> }): LectureAttendanceDetail {
  return {
    lectureId: evaluation.lecture.id,
    classId: evaluation.lecture.classId,
    outcome: result.outcome,
    source: result.source,
    excludedBecause: evaluation.scope.considered ? null : evaluation.scope.reason,
    scheduledStartAt: evaluation.scheduledStartAt,
  };
}

function finish(
  evaluations: readonly Evaluation[],
  legacyEligible: (e: Evaluation) => boolean
): { evaluation: Evaluation; result: ReturnType<typeof lectureOutcome> }[] {
  return evaluations.map((evaluation) => ({
    evaluation,
    result: lectureOutcome({
      scope: evaluation.scope,
      canonicalStatus: evaluation.canonicalStatus,
      registerFinalized: evaluation.registerFinalized,
      eligibleLegacyVisit: needsLegacy(evaluation) && legacyEligible(evaluation),
    }),
  }));
}

// ---- One student, across classes ------------------------------------------------------

/**
 * One student's attendance per class and overall. `teacherId` (optional)
 * restricts it to that teacher's classes (a teacher looking at a student);
 * without it, every class the student has an enrolment row in (the
 * student's or a linked guardian's own view: the caller authorizes the
 * student). 404 STUDENT_NOT_FOUND for an unknown student (and, with
 * teacherId, another teacher's student). Queries: 7 at most.
 */
export async function getStudentAttendancePercentages(
  input: { studentId: string; teacherId?: string; includeLectures?: boolean },
  options: PercentageOptions = {}
): Promise<StudentAttendancePercentages> {
  assertId(input.studentId, "studentId");
  if (input.teacherId !== undefined) assertId(input.teacherId, "teacherId");
  const now = nowOf(options);
  const context = requireApprovalContext(options.env ?? process.env);

  const [student, historyRows, enrolmentRows] = await Promise.all([
    prisma.student.findUnique({ where: { id: input.studentId }, select: STUDENT_SELECT }),
    prisma.studentConfirmationHistory.findMany({ where: { studentId: input.studentId }, select: HISTORY_SELECT }),
    prisma.classStudent.findMany({
      where: { studentId: input.studentId, class: { status: 0, ...(input.teacherId ? { teacherId: input.teacherId } : {}) } },
      select: { ...ENROLMENT_SELECT, class: { select: { id: true, name: true, teacherId: true, status: true } } },
    }),
  ]);
  if (!student || (input.teacherId !== undefined && student.teacherId !== input.teacherId)) throw attendanceError("STUDENT_NOT_FOUND");

  const classesById = new Map<string, ClassRow>();
  for (const row of enrolmentRows) classesById.set(row.class.id, row.class);
  const classIds = [...classesById.keys()];
  if (classIds.length === 0) {
    return { studentId: student.id, classes: [], overall: summarizeAttendance([]), ...(input.includeLectures ? { lectures: [] } : {}) };
  }

  const lectures: LectureRow[] = await prisma.lecture.findMany({ where: { classId: { in: classIds }, status: 0 }, select: LECTURE_SELECT });
  const lectureIds = lectures.map((l) => l.id);
  const [registerRows, recordRows] = await Promise.all([
    prisma.lectureAttendanceRegister.findMany({ where: { lectureId: { in: lectureIds } }, select: REGISTER_SELECT }),
    prisma.lectureAttendance.findMany({ where: { studentId: student.id, lectureId: { in: lectureIds } }, select: { lectureId: true, studentId: true, status: true } }),
  ]);

  const enrolments = enrolmentRows.map(enrolmentRow);
  const evaluations = evaluatePairs({
    lectures,
    classesById,
    registers: new Map(registerRows.map((r) => [r.lectureId, r])),
    records: new Map(recordRows.map((r) => [pairKey(r.lectureId, r.studentId), r.status as CanonicalAttendanceStatus])),
    studentIds: [student.id],
    enrolmentsByStudent: new Map([[student.id, enrolments]]),
    now,
  });

  const joins = await readLegacyJoinTimes(evaluations.filter(needsLegacy));
  const results = finish(evaluations, (e) =>
    hasEligibleVisit({
      joinTimes: joins.get(pairKey(e.lecture.id, e.studentId)) ?? [],
      student,
      cls: classesById.get(e.lecture.classId) as ClassRow,
      history: historyRows,
      enrolments,
      context,
    })
  );

  const classes: ClassAttendancePercentage[] = classIds
    .map((classId) => {
      const cls = classesById.get(classId) as ClassRow;
      return {
        classId,
        className: cls.name,
        currentlyEnrolled: enrolmentRows.some((r) => r.classId === classId && r.isActive && r.removedAt === null),
        summary: summarizeAttendance(results.filter((r) => r.evaluation.lecture.classId === classId).map((r) => r.result)),
      };
    })
    .sort((a, b) => a.className.localeCompare(b.className) || a.classId.localeCompare(b.classId));

  return {
    studentId: student.id,
    classes,
    overall: combineAttendanceSummaries(classes.map((c) => c.summary)),
    ...(input.includeLectures ? { lectures: results.map(detailOf) } : {}),
  };
}

// ---- One class, every rostered student (teacher) -----------------------------------------

/**
 * Every rostered student's attendance in one of the teacher's classes
 * (roster: an active enrolment and not deleted, as the in-session summary).
 * 404 CLASS_NOT_FOUND for another teacher's, a deleted or an unknown class.
 * Queries: 7 at most, whatever the number of students and lectures.
 */
export async function getClassAttendancePercentagesForTeacher(
  input: { teacherId: string; classId: string; includeLectures?: boolean },
  options: PercentageOptions = {}
): Promise<ClassStudentsAttendancePercentages> {
  assertId(input.teacherId, "teacherId");
  assertId(input.classId, "classId");
  const now = nowOf(options);
  const context = requireApprovalContext(options.env ?? process.env);

  const cls = await prisma.class.findFirst({
    where: { id: input.classId, teacherId: input.teacherId, status: 0 },
    select: { id: true, name: true, teacherId: true, status: true },
  });
  if (!cls) throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");

  const [enrolmentRows, lectures] = await Promise.all([
    prisma.classStudent.findMany({ where: { classId: cls.id }, select: { ...ENROLMENT_SELECT, student: { select: { ...STUDENT_SELECT, name: true } } } }),
    prisma.lecture.findMany({ where: { classId: cls.id, status: 0 }, select: LECTURE_SELECT }) as Promise<LectureRow[]>,
  ]);

  const rosterById = new Map<string, StudentRow & { name: string }>();
  for (const row of enrolmentRows) if (row.isActive && row.student.status === 0) rosterById.set(row.student.id, row.student);
  const studentIds = [...rosterById.keys()].sort();
  if (studentIds.length === 0) return { classId: cls.id, className: cls.name, students: [] };

  const lectureIds = lectures.map((l) => l.id);
  const [historyRows, registerRows, recordRows] = await Promise.all([
    prisma.studentConfirmationHistory.findMany({ where: { studentId: { in: studentIds } }, select: HISTORY_SELECT }),
    lectureIds.length ? prisma.lectureAttendanceRegister.findMany({ where: { lectureId: { in: lectureIds } }, select: REGISTER_SELECT }) : Promise.resolve([]),
    lectureIds.length
      ? prisma.lectureAttendance.findMany({ where: { lectureId: { in: lectureIds }, studentId: { in: studentIds } }, select: { lectureId: true, studentId: true, status: true } })
      : Promise.resolve([]),
  ]);

  const enrolmentsByStudent = new Map<string, EnrolmentRow[]>();
  for (const row of enrolmentRows) {
    const list = enrolmentsByStudent.get(row.studentId) ?? [];
    list.push(enrolmentRow(row));
    enrolmentsByStudent.set(row.studentId, list);
  }
  const historyByStudent = new Map<string, ApprovalHistoryEntry[]>();
  for (const row of historyRows) {
    const list = historyByStudent.get(row.studentId) ?? [];
    list.push(row);
    historyByStudent.set(row.studentId, list);
  }

  const evaluations = evaluatePairs({
    lectures,
    classesById: new Map([[cls.id, cls]]),
    registers: new Map(registerRows.map((r) => [r.lectureId, r])),
    records: new Map(recordRows.map((r) => [pairKey(r.lectureId, r.studentId), r.status as CanonicalAttendanceStatus])),
    studentIds,
    enrolmentsByStudent,
    now,
  });
  const joins = await readLegacyJoinTimes(evaluations.filter(needsLegacy));
  const results = finish(evaluations, (e) =>
    hasEligibleVisit({
      joinTimes: joins.get(pairKey(e.lecture.id, e.studentId)) ?? [],
      student: rosterById.get(e.studentId) as StudentRow,
      cls,
      history: historyByStudent.get(e.studentId) ?? [],
      enrolments: enrolmentsByStudent.get(e.studentId) ?? [],
      context,
    })
  );

  return {
    classId: cls.id,
    className: cls.name,
    students: studentIds.map((studentId) => {
      const mine = results.filter((r) => r.evaluation.studentId === studentId);
      return {
        studentId,
        name: (rosterById.get(studentId) as { name: string }).name,
        summary: summarizeAttendance(mine.map((r) => r.result)),
        ...(input.includeLectures ? { lectures: mine.map(detailOf) } : {}),
      };
    }),
  };
}
