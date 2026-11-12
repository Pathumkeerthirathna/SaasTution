/**
 * Automatic attendance eligibility at one instant: approval (from the
 * confirmation history, lib/student-confirmation-history.ts) and class
 * enrolment (./enrolment.ts). Pure: no database, no clock, no environment.
 *
 * The instant depends on the use (docs/student-confirmation-history.md):
 *  - roster and automatic ABSENT at finalization: the register's scheduled start;
 *  - QR and online evidence: the server-recorded scan / join time;
 *  - backfill: the recorded join time.
 *
 * ELIGIBLE only when the student is active, KNOWN to be approved at the
 * instant and enrolled at the instant. UNKNOWN approval is never eligible: it
 * goes to the teacher for manual review and never produces automatic
 * attendance or an automatic ABSENT.
 */

import {
  APPROVAL_FEATURE_STARTED_AT_SETTING,
  explainApprovalAt,
  type ApprovalDuringExplanation,
  type ApprovalHistoryContext,
  type ApprovalHistoryEntry,
  type ApprovalStudent,
} from "@/lib/student-confirmation-history";
import { explainEnrolmentAt, type EnrolmentExplanation, type EnrolmentRow } from "@/lib/attendance/enrolment";

export type AttendanceEligibilityOutcome = "ELIGIBLE" | "NOT_ELIGIBLE" | "UNKNOWN";

export type AttendanceEligibilityReason =
  /** Active, approved and enrolled at the instant. */
  | "ELIGIBLE"
  /** The student is soft-deleted (Student.status is not 0). */
  | "STUDENT_INACTIVE"
  /** Not enrolled in the class at the instant. */
  | "NOT_ENROLLED"
  /** Known not to be approved at the instant (pending or declined). */
  | "NOT_APPROVED"
  /** Enrolled, but approval at the instant is unknown: manual review. */
  | "APPROVAL_UNKNOWN";

export type AttendanceEligibility = {
  outcome: AttendanceEligibilityOutcome;
  reason: AttendanceEligibilityReason;
  /**
   * The approvalAt explanation; null only when the student is inactive (not
   * evaluated). `approval.reason` is what AttendanceScanEvent.eligibilityReason
   * stores.
   */
  approval: ApprovalDuringExplanation | null;
  enrolment: EnrolmentExplanation | null;
};

export type EligibilityStudent = ApprovalStudent & {
  /** Student.status: 0 = active, anything else = soft-deleted. */
  status: number;
};

export type AttendanceEligibilityInput = {
  student: EligibilityStudent;
  /** ALL of the student's StudentConfirmationHistory rows. */
  history: readonly ApprovalHistoryEntry[];
  /** ALL of the student's ClassStudent rows for the class (removed ones included). */
  enrolments: readonly EnrolmentRow[];
  classId: string;
  /** A real UTC instant chosen by the server (never a client timestamp). */
  instant: Date;
  /** Required: from approvalHistoryContextFromSetting (APPROVAL_FEATURE_STARTED_AT). No fallback. */
  context: ApprovalHistoryContext;
};

/**
 * Fail closed: attendance never runs without a valid approval context
 * (APPROVAL_FEATURE_STARTED_AT). There is no fallback instant.
 */
export function assertApprovalContext(context: ApprovalHistoryContext | null | undefined): void {
  const start = context?.approvalFeatureStartedAt;

  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    throw new TypeError(
      "Attendance eligibility needs a valid approvalFeatureStartedAt (" + APPROVAL_FEATURE_STARTED_AT_SETTING + ")."
    );
  }
}

/**
 * Eligibility at `instant`. Order of the checks, each one final:
 *  1. inactive student            -> NOT_ELIGIBLE (STUDENT_INACTIVE);
 *  2. not enrolled                -> NOT_ELIGIBLE (NOT_ENROLLED), whatever the approval;
 *  3. approval NOT_APPROVED       -> NOT_ELIGIBLE (NOT_APPROVED);
 *  4. approval UNKNOWN            -> UNKNOWN (APPROVAL_UNKNOWN);
 *  5. otherwise (APPROVED)        -> ELIGIBLE.
 * So UNKNOWN always comes from approval, with an unknown approvalAt reason,
 * and ELIGIBLE always with an approved one (what the scan-event CHECK
 * constraints require; see scanResultForEligibility).
 *
 * Throws (from explainApprovalAt) when the context is missing or invalid, and
 * when the instant is invalid.
 */
export function attendanceEligibilityAt(input: AttendanceEligibilityInput): AttendanceEligibility {
  const { student, history, enrolments, classId, instant, context } = input;

  assertApprovalContext(context);

  // Validates the context and the instant even for inactive students: a
  // misconfigured environment must fail loudly, not look "not eligible".
  const approval = explainApprovalAt(student, history, instant, context);

  if (student.status !== 0) {
    return { outcome: "NOT_ELIGIBLE", reason: "STUDENT_INACTIVE", approval: null, enrolment: null };
  }

  const enrolment = explainEnrolmentAt(enrolments, classId, instant);

  if (!enrolment.enrolled) {
    return { outcome: "NOT_ELIGIBLE", reason: "NOT_ENROLLED", approval, enrolment };
  }

  if (approval.result === "NOT_APPROVED") {
    return { outcome: "NOT_ELIGIBLE", reason: "NOT_APPROVED", approval, enrolment };
  }

  if (approval.result === "UNKNOWN") {
    return { outcome: "UNKNOWN", reason: "APPROVAL_UNKNOWN", approval, enrolment };
  }

  return { outcome: "ELIGIBLE", reason: "ELIGIBLE", approval, enrolment };
}

/** Only ELIGIBLE may produce automatic attendance or an automatic ABSENT. */
export function isAutomaticAttendanceAllowed(eligibility: AttendanceEligibility): boolean {
  return eligibility.outcome === "ELIGIBLE";
}

export type EligibilityScanResult = "VALID" | "NOT_ELIGIBLE" | "ELIGIBILITY_UNKNOWN";

/**
 * The AttendanceScanEvent result and eligibilityReason for an identified
 * student of the scanning teacher. eligibilityReason is the approvalAt
 * reason (null for an inactive student, whose approval is not evaluated).
 */
export function scanResultForEligibility(eligibility: AttendanceEligibility): {
  result: EligibilityScanResult;
  eligibilityReason: ApprovalDuringExplanation["reason"] | null;
} {
  const result: EligibilityScanResult =
    eligibility.outcome === "ELIGIBLE"
      ? "VALID"
      : eligibility.outcome === "UNKNOWN"
        ? "ELIGIBILITY_UNKNOWN"
        : "NOT_ELIGIBLE";

  return { result, eligibilityReason: eligibility.approval?.reason ?? null };
}
