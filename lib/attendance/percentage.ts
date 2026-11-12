/**
 * Attendance percentage: the one shared rule (Stage 5.7b-3h; approved in
 * 5.7b-3g). Pure: no database, no clock, no environment. The service
 * (services/attendance-percentage-service.ts) normalizes the data and calls
 * these functions; no consumer uses them yet.
 *
 * 1. Which lectures are considered (lectureScope):
 *    - not deleted, not in a deleted class, not CANCELLED;
 *    - HELD: from the scheduled start, once the scheduled end has passed or
 *      the teacher completed the lecture (COMPLETED) — the same notion of a
 *      finished lecture as finalization readiness (lib/attendance/
 *      finalization.ts): a lecture without an end time that is not COMPLETED
 *      is not held yet;
 *    - the student was enrolled at the lecture's scheduled start (the usable
 *      [assignedAt, removedAt) enrolment periods of lib/attendance/
 *      enrolment.ts; the caller passes the result).
 *    Anything else is EXCLUDED: it counts nowhere.
 *
 * 2. One outcome per considered lecture (lectureOutcome), at most once:
 *    - a canonical LectureAttendance record exists → its status, and nothing
 *      else (no legacy visit or QR scan event is ever added on top; a
 *      pending review does not change the status):
 *        PRESENT, LATE → ATTENDED; ABSENT → MISSED; EXCUSED → EXCUSED;
 *    - no record, register finalized → UNRESOLVED (never inferred);
 *    - no record, register not finalized (or no register) → an eligible
 *      legacy online visit → ATTENDED (compatibility fallback); none →
 *      PENDING.
 *
 * 3. The percentage (summarizeAttendance / attendancePercentage):
 *      attended / (attended + missed) × 100,
 *    rounded half up to a whole number (exact integer arithmetic), 0 when
 *    the denominator is 0. EXCUSED, PENDING, UNRESOLVED and EXCLUDED are in
 *    neither the numerator nor the denominator.
 */

import { scheduledEndPassed } from "@/lib/attendance/finalization";

export type CanonicalAttendanceStatus = "PRESENT" | "LATE" | "ABSENT" | "EXCUSED";

export type LectureScopeReason = "DELETED" | "CANCELLED" | "NOT_HELD" | "NOT_ENROLLED";

export type LectureScope = { considered: true } | { considered: false; reason: LectureScopeReason };

export type LectureScopeInput = {
  /** Lecture.status !== 0, or its class's status !== 0. */
  deleted: boolean;
  /** Lecture.classStatus. */
  classStatus: string;
  /** The register's schedule when a register exists, else the lecture's date / endDate (as ensureRegister copies them). */
  scheduledStartAt: Date;
  scheduledEndAt: Date | null;
  /** Enrolled in the lecture's class at scheduledStartAt (explainEnrolmentAt). */
  enrolledAtStart: boolean;
  now: Date;
};

const isValidDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());

/** Held: started, and the scheduled end has passed or the lecture is COMPLETED (finalization's notion of finished). */
export function lectureHeld(input: { classStatus: string; scheduledStartAt: Date; scheduledEndAt: Date | null; now: Date }): boolean {
  if (!isValidDate(input.now) || !isValidDate(input.scheduledStartAt)) throw new RangeError("Attendance percentage: valid times are required.");
  if (input.now.getTime() < input.scheduledStartAt.getTime()) return false;
  if (scheduledEndPassed({ scheduledStartAt: input.scheduledStartAt, scheduledEndAt: input.scheduledEndAt, finalizedAt: null }, input.now)) return true;
  return input.classStatus === "COMPLETED";
}

/** Whether a lecture is considered for this student (see the header, point 1). Checked in this order. */
export function lectureScope(input: LectureScopeInput): LectureScope {
  if (input.deleted) return { considered: false, reason: "DELETED" };
  if (input.classStatus === "CANCELLED") return { considered: false, reason: "CANCELLED" };
  if (!lectureHeld(input)) return { considered: false, reason: "NOT_HELD" };
  if (!input.enrolledAtStart) return { considered: false, reason: "NOT_ENROLLED" };
  return { considered: true };
}

export type LectureAttendanceOutcome = "ATTENDED" | "MISSED" | "EXCUSED" | "PENDING" | "UNRESOLVED" | "EXCLUDED";
export type LectureOutcomeSource = "CANONICAL" | "LEGACY_VISIT" | null;

export type LectureOutcomeInput = {
  scope: LectureScope;
  /** The canonical record's status, or null when there is no record. */
  canonicalStatus: CanonicalAttendanceStatus | null;
  /** The lecture's register exists and is finalized. */
  registerFinalized: boolean;
  /** At least one legacy online visit of this student to this lecture was eligible at its join time. */
  eligibleLegacyVisit: boolean;
};

export type LectureOutcome = { outcome: LectureAttendanceOutcome; source: LectureOutcomeSource };

const CANONICAL_OUTCOME: Record<CanonicalAttendanceStatus, LectureAttendanceOutcome> = {
  PRESENT: "ATTENDED",
  LATE: "ATTENDED",
  ABSENT: "MISSED",
  EXCUSED: "EXCUSED",
};

/** The single outcome of one student for one lecture (see the header, point 2). */
export function lectureOutcome(input: LectureOutcomeInput): LectureOutcome {
  if (!input.scope.considered) return { outcome: "EXCLUDED", source: null };
  if (input.canonicalStatus !== null) {
    const outcome = CANONICAL_OUTCOME[input.canonicalStatus];
    if (!outcome) throw new RangeError("Attendance percentage: unknown canonical status.");
    return { outcome, source: "CANONICAL" };
  }
  if (input.registerFinalized) return { outcome: "UNRESOLVED", source: null };
  return input.eligibleLegacyVisit ? { outcome: "ATTENDED", source: "LEGACY_VISIT" } : { outcome: "PENDING", source: null };
}

/** attended / (attended + missed) × 100, rounded half up to a whole number; 0 when nothing is counted. */
export function attendancePercentage(attended: number, missed: number): number {
  if (!Number.isSafeInteger(attended) || !Number.isSafeInteger(missed) || attended < 0 || missed < 0) {
    throw new RangeError("Attendance percentage: counts must be non-negative integers.");
  }
  const denominator = attended + missed;
  if (denominator === 0) return 0;
  // floor(attended × 100 / denominator + 1/2) without floating point.
  return Math.floor((attended * 200 + denominator) / (2 * denominator));
}

export type AttendanceSummary = {
  /** Considered lectures (every outcome except EXCLUDED). */
  eligibleLectures: number;
  /** attended + missed: the percentage's denominator. */
  countedLectures: number;
  attended: number;
  missed: number;
  excused: number;
  pending: number;
  unresolved: number;
  excluded: number;
  /** Of `attended`: from the legacy online fallback (diagnostic). */
  attendedFromLegacy: number;
  /** Whole-number percentage (attendancePercentage). */
  percentage: number;
};

export const EMPTY_ATTENDANCE_SUMMARY: AttendanceSummary = Object.freeze({
  eligibleLectures: 0,
  countedLectures: 0,
  attended: 0,
  missed: 0,
  excused: 0,
  pending: 0,
  unresolved: 0,
  excluded: 0,
  attendedFromLegacy: 0,
  percentage: 0,
});

/** Counts the outcomes (one per student per lecture) and computes the percentage. */
export function summarizeAttendance(outcomes: readonly LectureOutcome[]): AttendanceSummary {
  const s = { attended: 0, missed: 0, excused: 0, pending: 0, unresolved: 0, excluded: 0, attendedFromLegacy: 0 };
  for (const { outcome, source } of outcomes) {
    if (outcome === "ATTENDED") {
      s.attended += 1;
      if (source === "LEGACY_VISIT") s.attendedFromLegacy += 1;
    } else if (outcome === "MISSED") s.missed += 1;
    else if (outcome === "EXCUSED") s.excused += 1;
    else if (outcome === "PENDING") s.pending += 1;
    else if (outcome === "UNRESOLVED") s.unresolved += 1;
    else s.excluded += 1;
  }
  return {
    eligibleLectures: s.attended + s.missed + s.excused + s.pending + s.unresolved,
    countedLectures: s.attended + s.missed,
    ...s,
    percentage: attendancePercentage(s.attended, s.missed),
  };
}

/** Adds summaries (e.g. per class → overall); the percentage is recomputed from the summed counts, never averaged. */
export function combineAttendanceSummaries(summaries: readonly AttendanceSummary[]): AttendanceSummary {
  const t = { attended: 0, missed: 0, excused: 0, pending: 0, unresolved: 0, excluded: 0, attendedFromLegacy: 0 };
  for (const s of summaries) {
    t.attended += s.attended;
    t.missed += s.missed;
    t.excused += s.excused;
    t.pending += s.pending;
    t.unresolved += s.unresolved;
    t.excluded += s.excluded;
    t.attendedFromLegacy += s.attendedFromLegacy;
  }
  return {
    eligibleLectures: t.attended + t.missed + t.excused + t.pending + t.unresolved,
    countedLectures: t.attended + t.missed,
    ...t,
    percentage: attendancePercentage(t.attended, t.missed),
  };
}
