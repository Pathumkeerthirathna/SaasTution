/**
 * Register finalization: when it may happen, and which students get an
 * automatic ABSENT. Pure: no database, no clock, no Jitsi. The service (later
 * stage) must ALSO refuse while any session of the lecture is active (stale
 * or not); that check is deliberately not here.
 * See docs/lecture-attendance.md.
 *
 * Time: the register's scheduled period is half-open [start, end), so the
 * scheduled end has passed from the end instant itself.
 *
 * Start boundary: finalization is refused before the register's scheduled
 * start (LECTURE_NOT_STARTED), even for a COMPLETED lecture: eligibility is
 * judged at the scheduled start, which must not lie in the future. From the
 * start instant itself it is allowed (if everything else allows it).
 *
 * Explicit completion: the teacher completed the lecture (Lecture.classStatus
 * COMPLETED). From the scheduled start, it allows finalization before the
 * scheduled end, and is the only way to finalize a lecture without an end
 * time. Finalization never changes Lecture.classStatus.
 *
 * Service-facing absence planning goes through planFinalizationAbsences only:
 * it always evaluates eligibility at the scheduled start, so an ABSENT can
 * never come from eligibility computed at another instant.
 *
 * Automatic ABSENT: only for students who have no record AND are ELIGIBLE
 * (active, known approved, enrolled) at the register's scheduled start.
 * UNKNOWN students are listed for manual review and never become ABSENT
 * automatically.
 */

import {
  assertApprovalContext,
  attendanceEligibilityAt,
  type AttendanceEligibility,
  type EligibilityStudent,
} from "@/lib/attendance/eligibility";
import type { EnrolmentRow } from "@/lib/attendance/enrolment";
import type { ApprovalHistoryContext, ApprovalHistoryEntry } from "@/lib/student-confirmation-history";

export type LectureClassStatus = "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";

export type FinalizationRegisterState = {
  scheduledStartAt: Date;
  scheduledEndAt: Date | null;
  finalizedAt: Date | null;
};

export type FinalizationBasis =
  /** The scheduled end time has passed. */
  | "SCHEDULED_END_PASSED"
  /** Before the scheduled end, or with no end time: the teacher completed the lecture. */
  | "LECTURE_COMPLETED";

export type FinalizationBlockedReason =
  | "ALREADY_FINALIZED"
  /** A cancelled lecture has no attendance to finalize. */
  | "LECTURE_CANCELLED"
  /** Before the scheduled start (COMPLETED does not bypass this). */
  | "LECTURE_NOT_STARTED"
  /** There is an end time, it has not passed, and the lecture is not completed. */
  | "SCHEDULED_END_NOT_PASSED"
  /** No end time, and the lecture is not completed. */
  | "COMPLETION_REQUIRED";

export type FinalizationReadiness =
  | { allowed: true; basis: FinalizationBasis }
  | { allowed: false; reason: FinalizationBlockedReason };

const isValidDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());

function assertValidRegister(register: FinalizationRegisterState) {
  if (!isValidDate(register.scheduledStartAt)) {
    throw new RangeError("Finalization: a valid scheduled start is required.");
  }

  if (register.scheduledEndAt !== null && !isValidDate(register.scheduledEndAt)) {
    throw new RangeError("Finalization: the scheduled end is invalid.");
  }
}

/** Whether the scheduled end has passed at `now` (from the end instant itself); false with no end time. */
export function scheduledEndPassed(register: FinalizationRegisterState, now: Date): boolean {
  assertValidRegister(register);
  if (!isValidDate(now)) throw new RangeError("Finalization: a valid server time is required.");
  return register.scheduledEndAt !== null && now.getTime() >= register.scheduledEndAt.getTime();
}

/** A lecture without an end time can only be finalized after the teacher completes it. */
export function requiresExplicitCompletion(register: FinalizationRegisterState): boolean {
  assertValidRegister(register);
  return register.scheduledEndAt === null;
}

/**
 * May the register be finalized at `now` (server time)? Checks, in order:
 * already finalized; cancelled lecture; not started yet (now before the
 * scheduled start); scheduled end passed; teacher completion. Does NOT check
 * for active sessions (the service must).
 */
export function finalizationReadiness(input: {
  register: FinalizationRegisterState;
  lectureStatus: LectureClassStatus;
  now: Date;
}): FinalizationReadiness {
  const { register, lectureStatus, now } = input;

  if (register.finalizedAt !== null) return { allowed: false, reason: "ALREADY_FINALIZED" };
  if (lectureStatus === "CANCELLED") return { allowed: false, reason: "LECTURE_CANCELLED" };
  if (!isValidDate(now)) throw new RangeError("Finalization: a valid server time is required.");
  assertValidRegister(register);
  if (now.getTime() < register.scheduledStartAt.getTime()) return { allowed: false, reason: "LECTURE_NOT_STARTED" };
  if (scheduledEndPassed(register, now)) return { allowed: true, basis: "SCHEDULED_END_PASSED" };
  if (lectureStatus === "COMPLETED") return { allowed: true, basis: "LECTURE_COMPLETED" };

  return {
    allowed: false,
    reason: requiresExplicitCompletion(register) ? "COMPLETION_REQUIRED" : "SCHEDULED_END_NOT_PASSED",
  };
}

export type FinalizationCandidate = {
  studentId: string;
  student: EligibilityStudent;
  /** ALL of the student's StudentConfirmationHistory rows. */
  history: readonly ApprovalHistoryEntry[];
  /** ALL of the student's ClassStudent rows for the class. */
  enrolments: readonly EnrolmentRow[];
  /** The student already has a LectureAttendance record for this lecture. */
  hasRecord: boolean;
};

export type AbsenceDecision =
  /** Eligible at the scheduled start and no record: finalization creates ABSENT. */
  | "CREATE_ABSENT"
  /** Already has a record (any status): never touched by finalization. */
  | "HAS_RECORD"
  /** Not eligible at the scheduled start: nothing. */
  | "NOT_ELIGIBLE"
  /** Eligibility unknown at the scheduled start: manual review, never automatic ABSENT. */
  | "MANUAL_REVIEW";

export type FinalizationRosterEntry = {
  studentId: string;
  decision: AbsenceDecision;
  /** Eligibility at the register's scheduled start. */
  eligibility: AttendanceEligibility;
};

export type FinalizationPlan = {
  /** Every candidate, in input order. */
  roster: FinalizationRosterEntry[];
  /** Students who get an ABSENT record. */
  absentStudentIds: string[];
  /** Students left for manual review (eligibility UNKNOWN, no record). */
  manualReviewStudentIds: string[];
  /** LectureAttendanceRegisterAuditLog counts. */
  eligibleCount: number;
  unknownEligibilityCount: number;
  absentCreatedCount: number;
};

/**
 * The absence decision for one student, from eligibility at the scheduled
 * start. Internal: callers use planFinalizationAbsences, which fixes the
 * instant.
 */
function absenceDecision(eligibility: AttendanceEligibility, hasRecord: boolean): AbsenceDecision {
  if (hasRecord) return "HAS_RECORD";
  if (eligibility.outcome === "ELIGIBLE") return "CREATE_ABSENT";
  if (eligibility.outcome === "UNKNOWN") return "MANUAL_REVIEW";
  return "NOT_ELIGIBLE";
}

/**
 * The finalization roster: eligibility of every candidate at the register's
 * scheduled start (always that instant), and who becomes ABSENT.
 * eligibleCount / unknownEligibilityCount count candidates by eligibility,
 * with or without a record. Throws for a duplicate student, an invalid
 * register, or a missing / invalid approval context.
 */
export function planFinalizationAbsences(input: {
  register: FinalizationRegisterState;
  classId: string;
  candidates: readonly FinalizationCandidate[];
  context: ApprovalHistoryContext;
}): FinalizationPlan {
  const { register, classId, candidates, context } = input;

  assertValidRegister(register);
  assertApprovalContext(context);

  const seen = new Set<string>();
  const roster: FinalizationRosterEntry[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.studentId)) {
      throw new Error("Finalization: a student appears more than once in the roster.");
    }
    seen.add(candidate.studentId);

    const eligibility = attendanceEligibilityAt({
      student: candidate.student,
      history: candidate.history,
      enrolments: candidate.enrolments,
      classId,
      instant: register.scheduledStartAt,
      context,
    });

    roster.push({
      studentId: candidate.studentId,
      decision: absenceDecision(eligibility, candidate.hasRecord),
      eligibility,
    });
  }

  const absentStudentIds = roster.filter((r) => r.decision === "CREATE_ABSENT").map((r) => r.studentId);

  return {
    roster,
    absentStudentIds,
    manualReviewStudentIds: roster.filter((r) => r.decision === "MANUAL_REVIEW").map((r) => r.studentId),
    eligibleCount: roster.filter((r) => r.eligibility.outcome === "ELIGIBLE").length,
    unknownEligibilityCount: roster.filter((r) => r.eligibility.outcome === "UNKNOWN").length,
    absentCreatedCount: absentStudentIds.length,
  };
}
