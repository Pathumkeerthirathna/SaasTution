/**
 * Attendance percentage COMPARISON (Stage 5.7b-3i): the legacy calculation
 * next to the new shared one, for the same scope, with the lecture-level
 * reasons for any difference. INTERNAL and DIAGNOSTIC only:
 *  - no route, page or consumer imports it (a test enforces this); nothing
 *    visible changes: the legacy functions run exactly as the screens call
 *    them and their results are only read;
 *  - read only: plain reads, no transaction, no lock, never a write; the
 *    output is returned to the server-side caller, never stored or logged;
 *  - privacy: the output holds ids and counts only (no names), and every
 *    scope is limited to the teacher's own class / students.
 *
 * Legacy (unchanged, services/student-service.ts):
 *   class   getClassAttendanceSummaryForTeacher  round(attended / total × 100)
 *   student getStudentAttendanceSummary          (attended / total × 100).toFixed(2)
 *   where attended = lectures with any Attendance visit, total = every
 *   non-deleted lecture of the class.
 * New: services/attendance-percentage-service.ts (rule:
 *   lib/attendance/percentage.ts), whole-number half up.
 *
 * Reasons are attributed per lecture, only where the legacy and the new
 * contribution of that lecture differ (legacy: 1 in the total, 1 attended
 * with a visit; new: attended / missed count, everything else does not),
 * and only from data that supports it; otherwise OTHER. A difference in
 * the percentage with identical counts is ROUNDING_ONLY (the two legacy
 * roundings differ from whole-number half up).
 */

import { classifyLecture, loadEvidenceConfig } from "@/lib/attendance/config";
import { summarizeAttendance, type AttendanceSummary, type LectureOutcome } from "@/lib/attendance/percentage";
import { prisma } from "@/lib/prisma";
import {
  getClassAttendancePercentagesForTeacher,
  getStudentAttendancePercentages,
  type LectureAttendanceDetail,
} from "@/services/attendance-percentage-service";
import { sriLankaCalendarParts } from "@/lib/time";
import {
  classifyAttendance,
  getClassAttendanceSummaryForTeacher,
  getStudentAttendanceAnalytics,
  getStudentAttendanceSummary,
  type AttendanceStatusLabel,
} from "@/services/student-service";

type Env = Record<string, string | undefined>;

export type AttendanceDifferenceReason =
  | "QR_ONLY_ATTENDANCE"
  | "TEACHER_DECISION"
  | "EXCUSED"
  | "FINALIZATION_ABSENT"
  | "HISTORICAL_BACKFILL_GAP"
  | "PENDING_NOT_FINALIZED"
  | "CANCELLED_LECTURE"
  | "FUTURE_LECTURE"
  | "LECTURE_NOT_HELD"
  | "ENROLMENT_BOUNDARY"
  | "INELIGIBLE_VISIT"
  | "UNRESOLVED_FINALIZED"
  /** The legacy calculation counts a lecture of a deleted class (the new one never reads deleted classes). */
  | "CLASS_DELETED"
  | "OTHER";

export type AttendanceComparisonKind = "IDENTICAL" | "ROUNDING_ONLY" | "COUNTS_DIFFER";

export type AttendanceComparison = {
  classId: string;
  studentId: string;
  legacy: { attended: number; total: number; percentage: number };
  current: Pick<AttendanceSummary, "attended" | "missed" | "excused" | "pending" | "unresolved" | "eligibleLectures" | "countedLectures" | "percentage">;
  /** current − legacy, in percentage points (2 decimals). */
  percentageDifference: number;
  kind: AttendanceComparisonKind;
  /** Lectures whose contribution differs, by reason (absent reasons are omitted). */
  reasons: Partial<Record<AttendanceDifferenceReason, number>>;
};

export type ClassAttendanceComparison = { classId: string; rows: AttendanceComparison[] };
export type StudentAttendanceComparison = {
  studentId: string;
  rows: AttendanceComparison[];
  /** The teacher's classes the new calculation has but the legacy one does not list (no active enrolment now). */
  classesOnlyInNew: string[];
};

type Options = { now?: Date; env?: Env };

type RecordDiagnostics = { statusSource: string; online: boolean; qr: boolean };
const pairKey = (lectureId: string, studentId: string) => `${lectureId}\u0000${studentId}`;

/** Two bounded reads for the attribution: the records' source / channels, and which (lecture, student) has any visit. */
async function readDiagnostics(lectureIds: readonly string[], studentIds: readonly string[]) {
  const records = new Map<string, RecordDiagnostics>();
  const visited = new Set<string>();
  if (lectureIds.length === 0 || studentIds.length === 0) return { records, visited };
  const [recordRows, visitRows] = await Promise.all([
    prisma.lectureAttendance.findMany({
      where: { lectureId: { in: [...lectureIds] }, studentId: { in: [...studentIds] } },
      select: { lectureId: true, studentId: true, statusSource: true, firstOnlineAt: true, firstQrAt: true },
    }),
    prisma.attendance.findMany({
      where: { studentId: { in: [...studentIds] }, classSession: { lectureId: { in: [...lectureIds] } } },
      select: { studentId: true, classSession: { select: { lectureId: true } } },
    }),
  ]);
  for (const r of recordRows) records.set(pairKey(r.lectureId, r.studentId), { statusSource: r.statusSource, online: r.firstOnlineAt !== null, qr: r.firstQrAt !== null });
  for (const v of visitRows) if (v.classSession.lectureId) visited.add(pairKey(v.classSession.lectureId, v.studentId));
  return { records, visited };
}

/** The reason one lecture contributes differently, or null when it contributes the same. */
export function lectureDifferenceReason(input: {
  detail: Pick<LectureAttendanceDetail, "outcome" | "source" | "excludedBecause" | "scheduledStartAt">;
  legacyVisit: boolean;
  record: RecordDiagnostics | null;
  historical: boolean;
  now: Date;
}): AttendanceDifferenceReason | null {
  const { detail, legacyVisit, record } = input;
  const newAttended = detail.outcome === "ATTENDED" ? 1 : 0;
  const newCounted = detail.outcome === "ATTENDED" || detail.outcome === "MISSED" ? 1 : 0;
  if (newCounted === 1 && newAttended === (legacyVisit ? 1 : 0)) return null; // the same contribution

  switch (detail.outcome) {
    case "EXCLUDED":
      if (detail.excludedBecause === "CANCELLED") return "CANCELLED_LECTURE";
      if (detail.excludedBecause === "NOT_ENROLLED") return "ENROLMENT_BOUNDARY";
      if (detail.excludedBecause === "NOT_HELD") return detail.scheduledStartAt.getTime() > input.now.getTime() ? "FUTURE_LECTURE" : "LECTURE_NOT_HELD";
      return "OTHER";
    case "EXCUSED":
      return "EXCUSED";
    case "UNRESOLVED":
      return "UNRESOLVED_FINALIZED";
    case "PENDING":
      if (legacyVisit) return "INELIGIBLE_VISIT"; // a visit exists, but none was eligible at its join time
      return input.historical ? "HISTORICAL_BACKFILL_GAP" : "PENDING_NOT_FINALIZED";
    case "ATTENDED":
      // Legacy has no visit here (otherwise the contribution would match).
      if (!record) return "OTHER";
      if (record.statusSource === "TEACHER") return "TEACHER_DECISION";
      if (record.qr && !record.online) return "QR_ONLY_ATTENDANCE";
      return "OTHER";
    case "MISSED":
      // Legacy counted a visit as attended.
      if (!record) return "OTHER";
      if (record.statusSource === "TEACHER") return "TEACHER_DECISION";
      if (record.statusSource === "FINALIZATION") return "FINALIZATION_ABSENT";
      return "OTHER";
    default:
      return "OTHER";
  }
}

function compareOne(input: {
  classId: string;
  studentId: string;
  legacy: { attended: number; total: number; percentage: number };
  summary: AttendanceSummary;
  lectures: readonly LectureAttendanceDetail[];
  diagnostics: Awaited<ReturnType<typeof readDiagnostics>>;
  evidenceStartedAt: Date | null;
  now: Date;
}): AttendanceComparison {
  const reasons: Partial<Record<AttendanceDifferenceReason, number>> = {};
  let reconstructedAttended = 0;
  for (const detail of input.lectures) {
    const key = pairKey(detail.lectureId, input.studentId);
    const legacyVisit = input.diagnostics.visited.has(key);
    if (legacyVisit) reconstructedAttended += 1;
    const reason = lectureDifferenceReason({
      detail,
      legacyVisit,
      record: input.diagnostics.records.get(key) ?? null,
      historical: input.evidenceStartedAt !== null && classifyLecture(detail.scheduledStartAt, input.evidenceStartedAt) === "HISTORICAL",
      now: input.now,
    });
    if (reason) reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  // The legacy result must be explained by the same lectures; if not, say so rather than guess.
  if (reconstructedAttended !== input.legacy.attended || input.lectures.length !== input.legacy.total) reasons.OTHER = (reasons.OTHER ?? 0) + 1;

  const s = input.summary;
  const countsMatch = s.attended === input.legacy.attended && s.countedLectures === input.legacy.total;
  return {
    classId: input.classId,
    studentId: input.studentId,
    legacy: input.legacy,
    current: {
      attended: s.attended,
      missed: s.missed,
      excused: s.excused,
      pending: s.pending,
      unresolved: s.unresolved,
      eligibleLectures: s.eligibleLectures,
      countedLectures: s.countedLectures,
      percentage: s.percentage,
    },
    percentageDifference: Math.round((s.percentage - input.legacy.percentage) * 100) / 100,
    kind: !countsMatch ? "COUNTS_DIFFER" : s.percentage === input.legacy.percentage ? "IDENTICAL" : "ROUNDING_ONLY",
    reasons,
  };
}

function nowOf(options: Options) {
  return options.now ?? new Date();
}

/**
 * Every rostered student of one of the teacher's classes: the legacy
 * in-session summary next to the new calculation. 404 CLASS_NOT_FOUND for
 * another teacher's class (from both calculations; the new one runs first).
 */
export async function compareClassAttendanceForTeacher(input: { teacherId: string; classId: string }, options: Options = {}): Promise<ClassAttendanceComparison> {
  const now = nowOf(options);
  const env = options.env ?? process.env;
  const current = await getClassAttendancePercentagesForTeacher({ ...input, includeLectures: true }, { now, env });
  const legacy = await getClassAttendanceSummaryForTeacher(input);
  const legacyById = new Map(legacy.map((row) => [row.studentId, row]));
  const lectureIds = [...new Set(current.students.flatMap((s) => (s.lectures ?? []).map((l) => l.lectureId)))];
  const diagnostics = await readDiagnostics(lectureIds, current.students.map((s) => s.studentId));
  const evidence = loadEvidenceConfig(env);

  const rows: AttendanceComparison[] = [];
  for (const student of current.students) {
    const old = legacyById.get(student.studentId);
    if (!old) continue; // the same roster rule on both sides; a student only one side lists is not compared
    rows.push(
      compareOne({
        classId: current.classId,
        studentId: student.studentId,
        legacy: { attended: old.attendedLectures, total: old.totalLectures, percentage: old.attendancePercentage },
        summary: student.summary,
        lectures: student.lectures ?? [],
        diagnostics,
        evidenceStartedAt: evidence.evidenceStartedAt,
        now,
      })
    );
  }
  return { classId: current.classId, rows };
}

/**
 * One student in the teacher's classes: the legacy per-class summary (the
 * profile / guardian one) next to the new calculation, for the classes both
 * list. The teacher is required: another teacher's student is 404
 * STUDENT_NOT_FOUND, and classes of other teachers are never compared.
 */
export async function compareStudentAttendanceForTeacher(input: { teacherId: string; studentId: string }, options: Options = {}): Promise<StudentAttendanceComparison> {
  const now = nowOf(options);
  const env = options.env ?? process.env;
  const current = await getStudentAttendancePercentages({ studentId: input.studentId, teacherId: input.teacherId, includeLectures: true }, { now, env });
  const teachersClasses = new Set(current.classes.map((c) => c.classId));
  const legacy = (await getStudentAttendanceSummary(input.studentId)).filter((row) => teachersClasses.has(row.classId));
  const lectures = current.lectures ?? [];
  const diagnostics = await readDiagnostics([...new Set(lectures.map((l) => l.lectureId))], [current.studentId]);
  const evidence = loadEvidenceConfig(env);

  const rows = legacy.map((old) => {
    const cls = current.classes.find((c) => c.classId === old.classId)!;
    return compareOne({
      classId: old.classId,
      studentId: current.studentId,
      legacy: { attended: old.attendedLectures, total: old.totalLectures, percentage: old.attendancePercentage },
      summary: cls.summary,
      lectures: lectures.filter((l) => l.classId === old.classId),
      diagnostics,
      evidenceStartedAt: evidence.evidenceStartedAt,
      now,
    });
  });
  const legacyClasses = new Set(legacy.map((r) => r.classId));
  return { studentId: current.studentId, rows, classesOnlyInNew: [...teachersClasses].filter((id) => !legacyClasses.has(id)).sort() };
}

/** Counts only, for an operator summary (no ids): how many rows of each kind, and lectures per reason. */
export function summarizeComparisons(rows: readonly AttendanceComparison[]) {
  const kinds: Record<AttendanceComparisonKind, number> = { IDENTICAL: 0, ROUNDING_ONLY: 0, COUNTS_DIFFER: 0 };
  const reasons: Partial<Record<AttendanceDifferenceReason, number>> = {};
  for (const row of rows) {
    kinds[row.kind] += 1;
    for (const [reason, count] of Object.entries(row.reasons) as [AttendanceDifferenceReason, number][]) reasons[reason] = (reasons[reason] ?? 0) + count;
  }
  return { rows: rows.length, kinds, reasons };
}

// =========================================================================================
// Student-wide consumers (Stage 5.7b-3j): analytics (P4), dashboard (P5), guardian overview
// =========================================================================================
//
// Each keeps its legacy CLASS SCOPE on both sides: the new outcomes are taken
// for exactly the lectures the legacy calculation counts, and attributed per
// lecture with lectureDifferenceReason. A lecture the new service never reads
// (a deleted class's lecture, which the analytics still counts) is EXCLUDED
// with reason CLASS_DELETED. Ownership: the teacher is required (the new
// service refuses another teacher's student first); a student enrolled in
// ANY class of another teacher is not compared at all (`withheld`), because
// these legacy scopes span all of the student's classes and must not be
// shown across teachers.

/** Where the comparison was not run, and why (no legacy or student data is returned). */
export type WithheldComparison = { studentId: string; withheld: "OTHER_TEACHER_CLASSES" };

export type ScopeComparison = Omit<AttendanceComparison, "classId"> & {
  scope: "ANALYTICS_ALL_ENROLMENTS" | "DASHBOARD_ACTIVE_ENROLMENTS";
};

export type MonthComparison = {
  key: string;
  label: string;
  legacy: { attended: number; total: number; percent: number };
  current: Pick<AttendanceSummary, "attended" | "missed" | "excused" | "pending" | "unresolved" | "countedLectures" | "percentage">;
  kind: AttendanceComparisonKind;
  reasons: Partial<Record<AttendanceDifferenceReason, number>>;
};

export type AnalyticsComparison = {
  studentId: string;
  monthsBack: number;
  overall: ScopeComparison;
  monthly: MonthComparison[];
  /** Latest month minus the one before, in points (the legacy definition). */
  trend: { legacy: number; current: number; difference: number };
  /** classifyAttendance (90 / 75 / 60), the same function for both. */
  health: { legacy: AttendanceStatusLabel; current: AttendanceStatusLabel; changed: boolean };
  /** Visit-based on both sides by definition (never derived from canonical statuses): the legacy value. */
  averageDuration: { value: number | null; source: "SESSION_VISITS" };
};

export type GuardianOverviewComparison = AnalyticsComparison & {
  /** The three attendance fields the guardian overview shows, as getGuardianStudentOverview maps them. */
  overview: {
    legacy: { rate: number; trendDelta: number; months: { label: string; percent: number }[] };
    current: { rate: number; trendDelta: number; months: { label: string; percent: number }[] };
  };
};

type LegacyLecture = { id: string; classId: string; date: Date };

/** The student's enrolment rows (any status) with their classes' owner and status: one query. */
async function readEnrolmentScope(studentId: string) {
  const rows = await prisma.classStudent.findMany({
    where: { studentId },
    select: { classId: true, isActive: true, class: { select: { teacherId: true, status: true } } },
  });
  const classStatus = new Map<string, number>();
  for (const row of rows) classStatus.set(row.classId, row.class.status);
  return { rows, classStatus };
}

/** The lectures a legacy scope counts (lecture status 0 in those classes): one query. */
async function readLegacyLectures(classIds: readonly string[]): Promise<LegacyLecture[]> {
  if (classIds.length === 0) return [];
  return prisma.lecture.findMany({ where: { classId: { in: [...classIds] }, status: 0 }, select: { id: true, classId: true, date: true } });
}

/** Per-lecture new outcomes and reasons for a set of legacy lectures (see lectureDifferenceReason). */
function attributeLectures(input: {
  studentId: string;
  lectures: readonly LegacyLecture[];
  details: ReadonlyMap<string, LectureAttendanceDetail>;
  classStatus: ReadonlyMap<string, number>;
  diagnostics: Awaited<ReturnType<typeof readDiagnostics>>;
  evidenceStartedAt: Date | null;
  now: Date;
}) {
  const reasons: Partial<Record<AttendanceDifferenceReason, number>> = {};
  const outcomes: LectureOutcome[] = [];
  let legacyAttended = 0;
  for (const lecture of input.lectures) {
    const key = pairKey(lecture.id, input.studentId);
    const legacyVisit = input.diagnostics.visited.has(key);
    if (legacyVisit) legacyAttended += 1;
    const detail = input.details.get(lecture.id);
    let reason: AttendanceDifferenceReason | null;
    if (!detail) {
      outcomes.push({ outcome: "EXCLUDED", source: null });
      reason = input.classStatus.get(lecture.classId) !== 0 ? "CLASS_DELETED" : "OTHER";
    } else {
      outcomes.push({ outcome: detail.outcome, source: detail.source });
      reason = lectureDifferenceReason({
        detail,
        legacyVisit,
        record: input.diagnostics.records.get(key) ?? null,
        historical: input.evidenceStartedAt !== null && classifyLecture(detail.scheduledStartAt, input.evidenceStartedAt) === "HISTORICAL",
        now: input.now,
      });
    }
    if (reason) reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return { reasons, outcomes, legacyAttended, legacyTotal: input.lectures.length };
}

function kindOf(summary: AttendanceSummary, legacy: { attended: number; total: number; percentage: number }): AttendanceComparisonKind {
  const countsMatch = summary.attended === legacy.attended && summary.countedLectures === legacy.total;
  return !countsMatch ? "COUNTS_DIFFER" : summary.percentage === legacy.percentage ? "IDENTICAL" : "ROUNDING_ONLY";
}

function scopeRow(
  scope: ScopeComparison["scope"],
  studentId: string,
  legacy: { attended: number; total: number; percentage: number },
  attributed: ReturnType<typeof attributeLectures>
): ScopeComparison {
  const reasons = { ...attributed.reasons };
  // The legacy result must be explained by the same lectures; if not, say so rather than guess.
  if (attributed.legacyAttended !== legacy.attended || attributed.legacyTotal !== legacy.total) reasons.OTHER = (reasons.OTHER ?? 0) + 1;
  const s = summarizeAttendance(attributed.outcomes);
  return {
    scope,
    studentId,
    legacy,
    current: {
      attended: s.attended,
      missed: s.missed,
      excused: s.excused,
      pending: s.pending,
      unresolved: s.unresolved,
      eligibleLectures: s.eligibleLectures,
      countedLectures: s.countedLectures,
      percentage: s.percentage,
    },
    percentageDifference: Math.round((s.percentage - legacy.percentage) * 100) / 100,
    kind: kindOf(s, legacy),
    reasons,
  };
}

/** The ownership gate shared by the student-wide comparisons; null when withheld. */
async function studentWideInputs(input: { teacherId: string; studentId: string }, options: Options) {
  const now = nowOf(options);
  const env = options.env ?? process.env;
  const current = await getStudentAttendancePercentages({ studentId: input.studentId, teacherId: input.teacherId, includeLectures: true }, { now, env });
  const scope = await readEnrolmentScope(current.studentId);
  if (scope.rows.some((row) => row.class.teacherId !== input.teacherId)) return null;
  const details = new Map((current.lectures ?? []).map((l) => [l.lectureId, l]));
  return { now, env, current, scope, details, evidenceStartedAt: loadEvidenceConfig(env).evidenceStartedAt };
}

/**
 * Student attendance analytics (P4: the profile Overview and the teacher's
 * student page; months 3–12, default 6): getStudentAttendanceAnalytics as is
 * (every enrolment row, former ones included, every non-deleted lecture of
 * those classes, monthly buckets by the lecture date's Colombo month), next
 * to the new outcomes of exactly those lectures. The legacy function reads
 * the clock itself: the comparison uses the same clock (`now` only for
 * tests that also fix the global clock).
 */
export async function compareStudentAnalyticsForTeacher(
  input: { teacherId: string; studentId: string; months?: number },
  options: Options = {}
): Promise<AnalyticsComparison | WithheldComparison> {
  const base = await studentWideInputs(input, options);
  if (!base) return { studentId: input.studentId, withheld: "OTHER_TEACHER_CLASSES" };
  const legacy = await getStudentAttendanceAnalytics(base.current.studentId, { months: input.months });
  const lectures = await readLegacyLectures([...base.scope.classStatus.keys()]);
  const diagnostics = await readDiagnostics(lectures.map((l) => l.id), [base.current.studentId]);
  const attribute = (subset: readonly LegacyLecture[]) =>
    attributeLectures({
      studentId: base.current.studentId,
      lectures: subset,
      details: base.details,
      classStatus: base.scope.classStatus,
      diagnostics,
      evidenceStartedAt: base.evidenceStartedAt,
      now: base.now,
    });

  const overall = scopeRow("ANALYTICS_ALL_ENROLMENTS", base.current.studentId, { attended: legacy.attended, total: legacy.totalClasses, percentage: legacy.attendanceRate }, attribute(lectures));

  const monthly: MonthComparison[] = legacy.monthly.map((bucket) => {
    const subset = lectures.filter((l) => {
      const d = sriLankaCalendarParts(new Date(l.date));
      return d.year === bucket.year && d.month === bucket.month;
    });
    const attributed = attribute(subset);
    const reasons = { ...attributed.reasons };
    if (attributed.legacyAttended !== bucket.attended || attributed.legacyTotal !== bucket.total) reasons.OTHER = (reasons.OTHER ?? 0) + 1;
    const s = summarizeAttendance(attributed.outcomes);
    return {
      key: bucket.key,
      label: bucket.label,
      legacy: { attended: bucket.attended, total: bucket.total, percent: bucket.percent },
      current: { attended: s.attended, missed: s.missed, excused: s.excused, pending: s.pending, unresolved: s.unresolved, countedLectures: s.countedLectures, percentage: s.percentage },
      kind: kindOf(s, { attended: bucket.attended, total: bucket.total, percentage: bucket.percent }),
      reasons,
    };
  });

  // The legacy trend: latest month minus the previous one (getStudentAttendanceAnalytics).
  const last = monthly[monthly.length - 1];
  const previous = monthly[monthly.length - 2];
  const currentTrend = last && previous ? last.current.percentage - previous.current.percentage : 0;
  const currentHealth = classifyAttendance(overall.current.percentage);

  return {
    studentId: base.current.studentId,
    monthsBack: legacy.monthsBack,
    overall,
    monthly,
    trend: { legacy: legacy.trendDelta, current: currentTrend, difference: currentTrend - legacy.trendDelta },
    health: { legacy: legacy.status, current: currentHealth, changed: legacy.status !== currentHealth },
    averageDuration: { value: legacy.averageDuration, source: "SESSION_VISITS" },
  };
}

/**
 * The guardian Overview's attendance (getGuardianStudentOverview: the
 * analytics with months: 6, shown as rate, trendDelta and the months'
 * label / percent). The same comparison, plus those three fields side by
 * side. (The guardian Attendance tab shows the per-class summary:
 * compareStudentAttendanceForTeacher.)
 */
export async function compareGuardianOverviewAttendanceForTeacher(
  input: { teacherId: string; studentId: string },
  options: Options = {}
): Promise<GuardianOverviewComparison | WithheldComparison> {
  const analytics = await compareStudentAnalyticsForTeacher({ ...input, months: 6 }, options);
  if ("withheld" in analytics) return analytics;
  return {
    ...analytics,
    overview: {
      legacy: {
        rate: analytics.overall.legacy.percentage,
        trendDelta: analytics.trend.legacy,
        months: analytics.monthly.map((m) => ({ label: m.label, percent: m.legacy.percent })),
      },
      current: {
        rate: analytics.overall.current.percentage,
        trendDelta: analytics.trend.current,
        months: analytics.monthly.map((m) => ({ label: m.label, percent: m.current.percentage })),
      },
    },
  };
}

/**
 * LEGACY REPLICA of the student dashboard card (GET
 * /api/student/dashboard/performance, `attendance`): that route computes it
 * inline and needs a student session, so it cannot be called here. The same
 * query and the same expression, copied verbatim; a parity test runs the
 * real route against it. Comparison only: never shown to anyone.
 */
export async function legacyDashboardAttendanceReplica(studentId: string): Promise<{ percent: number; attended: number; total: number }> {
  const lectures = await prisma.lecture.findMany({
    where: { status: 0, class: { status: 0, students: { some: { studentId, isActive: true } } } },
    select: { id: true, sessions: { select: { attendance: { where: { studentId }, select: { id: true }, take: 1 } } } },
  });
  const totalLectures = lectures.length;
  const attendedLectures = lectures.filter((l) => l.sessions.some((s) => s.attendance.length > 0)).length;
  const attendancePercent = totalLectures === 0 ? 0 : Math.round((attendedLectures / totalLectures) * 100);
  return { percent: attendancePercent, attended: attendedLectures, total: totalLectures };
}

/**
 * The student dashboard's overall attendance (P5): active enrolments in
 * non-deleted classes, every non-deleted lecture of those classes (the
 * route's scope), next to the new outcomes of exactly those lectures.
 */
export async function compareDashboardAttendanceForTeacher(
  input: { teacherId: string; studentId: string },
  options: Options = {}
): Promise<ScopeComparison | WithheldComparison> {
  const base = await studentWideInputs(input, options);
  if (!base) return { studentId: input.studentId, withheld: "OTHER_TEACHER_CLASSES" };
  const legacy = await legacyDashboardAttendanceReplica(base.current.studentId);
  const activeClassIds = [...new Set(base.scope.rows.filter((r) => r.isActive && r.class.status === 0).map((r) => r.classId))];
  const lectures = await readLegacyLectures(activeClassIds);
  const diagnostics = await readDiagnostics(lectures.map((l) => l.id), [base.current.studentId]);
  const attributed = attributeLectures({
    studentId: base.current.studentId,
    lectures,
    details: base.details,
    classStatus: base.scope.classStatus,
    diagnostics,
    evidenceStartedAt: base.evidenceStartedAt,
    now: base.now,
  });
  return scopeRow("DASHBOARD_ACTIVE_ENROLMENTS", base.current.studentId, { attended: legacy.attended, total: legacy.total, percentage: legacy.percent }, attributed);
}
