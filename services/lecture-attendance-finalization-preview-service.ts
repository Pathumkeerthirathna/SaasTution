/**
 * Unified lecture attendance, Stage 5.5a: read-only finalization preview and
 * fingerprint. See docs/lecture-attendance.md ("Finalization preview and
 * fingerprint").
 *
 * READ ONLY. Every read goes through the existing read-only register view
 * (getRegister: plain autocommit reads, no transaction, no locks, never
 * creates a register), so the schedule, classification, candidate roster,
 * absence plan (planFinalizationAbsences at the register's scheduled start),
 * online-evidence check (evidenceRepresentation), review queue, active
 * sessions and readiness (finalizationReadiness) are exactly the register
 * view's. This module adds no eligibility, classification or absence rule:
 * it requires the configuration, counts, adds the finalization blockers and
 * computes the fingerprint (lib/attendance/finalization-fingerprint.ts).
 *
 * Without a register, the effective schedule is the one ensureRegister would
 * copy (the lecture's start / end, the class's grace); with one, the
 * register's own (frozen once finalized).
 *
 * Blockers (ready only when there are none): the readiness reason
 * (ALREADY_FINALIZED, LECTURE_CANCELLED, LECTURE_NOT_STARTED,
 * SCHEDULED_END_NOT_PASSED, COMPLETION_REQUIRED), SESSION_ACTIVE (D3),
 * EVIDENCE_PENDING and UNKNOWN_EVIDENCE (the online-evidence check;
 * FINALIZATION_EVIDENCE_PENDING at confirmation), ROSTER_LIMIT_EXCEEDED
 * (more than 500 candidates, D6). Pending teacher reviews are counted and
 * never block (D1); QR closure is not read at all (D7).
 *
 * NOT authoritative (D8): these are separate autocommit reads, so the
 * student rows, approval history, enrolments and records can come from
 * different snapshots. The confirmation (Stage 5.5b) must re-read everything
 * under its locks and recompute the fingerprint; a mismatch is
 * FINALIZATION_PREVIEW_STALE.
 *
 * Output: counts, the lecture / register schedule, readiness and the
 * fingerprint. No names, student ids, session ids or visit details. Nothing
 * is logged.
 */

import { requireApprovalContext, requireEvidenceStartedAt, type LectureClassification } from "@/lib/attendance/config";
import type { FinalizationBlockedReason, FinalizationReadiness, LectureClassStatus } from "@/lib/attendance/finalization";
import {
  computeFinalizationFingerprint,
  FINALIZATION_FINGERPRINT_VERSION,
  type FinalizationFingerprintInput,
} from "@/lib/attendance/finalization-fingerprint";
import { attendanceError } from "@/lib/attendance/service-errors";
import { getRegister, type RegisterView } from "@/services/lecture-attendance-service";

type Env = Record<string, string | undefined>;

/** D6: the initial maximum finalization roster. */
export const FINALIZATION_ROSTER_LIMIT = 500;

export type FinalizationBlocker =
  | FinalizationBlockedReason
  | "SESSION_ACTIVE"
  | "EVIDENCE_PENDING"
  | "UNKNOWN_EVIDENCE"
  | "ROSTER_LIMIT_EXCEEDED";

export type FinalizationPreview = {
  lecture: {
    lectureId: string;
    /** Always 0 (active): deleted lectures are 404. */
    status: number;
    classStatus: LectureClassStatus;
    date: Date;
    endDate: Date | null;
  };
  register: {
    exists: boolean;
    /** 0 when the register does not exist yet. */
    version: number;
    /** The schedule and grace attendance is judged against (the register's, or the one it would be created with). */
    scheduledStartAt: Date;
    scheduledEndAt: Date | null;
    graceMinutes: number;
    finalized: boolean;
    finalizedAt: Date | null;
  };
  classification: LectureClassification;
  summary: {
    /** Candidates: the teacher's students with any enrolment row in the class (removed ones included) plus every student with a record. */
    rosterSize: number;
    /** Candidates ELIGIBLE at the scheduled start (with or without a record). */
    eligibleStudents: number;
    /** Candidates whose eligibility at the scheduled start is UNKNOWN (with or without a record). */
    unknownEligibilityStudents: number;
    /**
     * Partition of the roster (each student exactly once):
     * withRecord + automaticAbsent + manualReview + notEligibleWithoutRecord = rosterSize
     * (before finalization; afterwards the last three are 0).
     */
    studentsWithRecord: number;
    /** No record, ELIGIBLE at the start: finalization would create ABSENT. */
    automaticAbsent: number;
    /** No record, eligibility UNKNOWN at the start: left for the teacher, never ABSENT automatically. */
    manualReview: number;
    /** No record, not eligible at the start (not approved, not enrolled, inactive / deleted): nothing. */
    notEligibleWithoutRecord: number;
    /** Existing records by current status (existing ABSENT records are counted here, never in automaticAbsent). */
    recordStatus: { PRESENT: number; LATE: number; ABSENT: number; EXCUSED: number };
  };
  evidence: {
    /** Students with an eligible online visit the record does not represent. */
    pendingOnlineEvidence: number;
    /** Students without a record and a visit whose approval was UNKNOWN at its join time. */
    unknownApprovalEvidence: number;
    /** Records waiting for a teacher review (shown; never blocks, D1). */
    pendingReviews: number;
    /** Both evidence counts are 0 (evidenceRepresentation reports nothing). */
    complete: boolean;
  };
  readiness: {
    /** True only when there is no blocker. */
    ready: boolean;
    /** The lecture / schedule readiness alone (finalizationReadiness). */
    schedule: FinalizationReadiness;
    blockers: FinalizationBlocker[];
    activeSessions: { active: boolean; count: number };
    rosterLimit: number;
    rosterLimitExceeded: boolean;
    evidenceComplete: boolean;
  };
  fingerprint: string;
  fingerprintVersion: number;
};

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 191) {
    throw attendanceError("VALIDATION_ERROR", { field });
  }
}

/**
 * The teacher's finalization preview for one lecture (see the module
 * header). Errors: 400 VALIDATION_ERROR, 404 LECTURE_NOT_FOUND (missing,
 * deleted or another teacher's), 503 ATTENDANCE_APPROVAL_NOT_CONFIGURED /
 * ATTENDANCE_EVIDENCE_NOT_CONFIGURED (fail closed: nothing is read).
 * A cancelled or finalized lecture is previewed with its blocker.
 */
export async function getLectureAttendanceFinalizationPreview(
  input: { teacherId: string; lectureId: string },
  options: { env?: Env; now?: Date } = {}
): Promise<FinalizationPreview> {
  assertId(input.teacherId, "teacherId");
  assertId(input.lectureId, "lectureId");
  const env = options.env ?? process.env;
  // Fail closed before any read (the register view itself would only degrade).
  requireApprovalContext(env);
  requireEvidenceStartedAt(env);

  const view = await getRegister(input.teacherId, input.lectureId, { env, now: options.now ?? new Date() });
  return buildFinalizationPreview(view);
}

/**
 * The parts of the register view the preview uses. RegisterView (getRegister)
 * satisfies it; the finalization transaction (Stage 5.5b) builds the same
 * shape from its locked reads with the same pure helpers, so both compute
 * the summary, blockers and fingerprint with this one function.
 */
export type FinalizationView = {
  lecture: Pick<RegisterView["lecture"], "id" | "classStatus" | "date" | "endDate">;
  register: Pick<RegisterView["register"], "exists" | "version" | "scheduledStartAt" | "scheduledEndAt" | "graceMinutes" | "finalizedAt">;
  classification: RegisterView["classification"];
  roster: readonly Pick<RegisterView["roster"][number], "studentId" | "hasRecord" | "eligibility" | "absenceDecision">[];
  records: readonly Pick<RegisterView["records"][number], "id" | "studentId" | "status" | "statusSource" | "version">[];
  reviewQueue: readonly unknown[];
  onlineEvidence: RegisterView["onlineEvidence"];
  activeSessions: readonly unknown[];
  finalization: { readiness: FinalizationReadiness };
};

/** Pure: the preview of a register view (summary, blockers, fingerprint). */
export function buildFinalizationPreview(view: FinalizationView): FinalizationPreview {
  const { onlineEvidence, classification } = view;
  // Both settings were required above, so the view computed these.
  if (!onlineEvidence || !classification || view.roster.some((entry) => entry.eligibility === null)) {
    throw new Error("Finalization preview: the register view is missing configured data.");
  }

  const finalized = view.register.finalizedAt !== null;
  const roster = view.roster;
  const withRecord = roster.filter((e) => e.hasRecord).length;
  const decided = (decision: string) => roster.filter((e) => !e.hasRecord && e.absenceDecision === decision).length;

  const recordStatus = { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 };
  for (const record of view.records) {
    if (record.status in recordStatus) recordStatus[record.status as keyof typeof recordStatus] += 1;
  }

  const activeCount = view.activeSessions.length;
  const rosterLimitExceeded = roster.length > FINALIZATION_ROSTER_LIMIT;
  const evidenceComplete = onlineEvidence.pending.length === 0 && onlineEvidence.unknownVisits.length === 0;
  const schedule = view.finalization.readiness;

  const blockers: FinalizationBlocker[] = [];
  if (!schedule.allowed) blockers.push(schedule.reason);
  if (!finalized) {
    if (activeCount > 0) blockers.push("SESSION_ACTIVE");
    if (onlineEvidence.pending.length > 0) blockers.push("EVIDENCE_PENDING");
    if (onlineEvidence.unknownVisits.length > 0) blockers.push("UNKNOWN_EVIDENCE");
    if (rosterLimitExceeded) blockers.push("ROSTER_LIMIT_EXCEEDED");
  }

  const fingerprintInput: FinalizationFingerprintInput = {
    lecture: { id: view.lecture.id, status: 0, classStatus: view.lecture.classStatus, date: view.lecture.date, endDate: view.lecture.endDate },
    register: {
      exists: view.register.exists,
      version: view.register.version,
      scheduledStartAt: view.register.scheduledStartAt,
      scheduledEndAt: view.register.scheduledEndAt,
      graceMinutes: view.register.graceMinutes,
      finalizedAt: view.register.finalizedAt,
    },
    records: view.records.map((r) => ({ studentId: r.studentId, id: r.id, version: r.version, status: r.status, statusSource: r.statusSource })),
    candidates: roster.map((e) => ({
      studentId: e.studentId,
      decision: e.absenceDecision,
      eligibilityOutcome: e.eligibility!.outcome,
      eligibilityReason: e.eligibility!.reason,
      approvalReason: e.eligibility!.approvalReason,
    })),
    evidence: {
      pending: onlineEvidence.pending.map((p) => ({ studentId: p.studentId, earliestEligibleVisitAt: p.earliestEligibleVisitAt })),
      unknown: onlineEvidence.unknownVisits.map((u) => ({ studentId: u.studentId, earliestUnknownVisitAt: u.earliestUnknownVisitAt })),
    },
    classification,
    readiness: schedule,
    activeSession: activeCount > 0,
  };

  return {
    lecture: {
      lectureId: view.lecture.id,
      status: 0,
      classStatus: view.lecture.classStatus,
      date: view.lecture.date,
      endDate: view.lecture.endDate,
    },
    register: {
      exists: view.register.exists,
      version: view.register.version,
      scheduledStartAt: view.register.scheduledStartAt,
      scheduledEndAt: view.register.scheduledEndAt,
      graceMinutes: view.register.graceMinutes,
      finalized,
      finalizedAt: view.register.finalizedAt,
    },
    classification,
    summary: {
      rosterSize: roster.length,
      eligibleStudents: roster.filter((e) => e.eligibility!.outcome === "ELIGIBLE").length,
      unknownEligibilityStudents: roster.filter((e) => e.eligibility!.outcome === "UNKNOWN").length,
      studentsWithRecord: withRecord,
      automaticAbsent: decided("CREATE_ABSENT"),
      manualReview: decided("MANUAL_REVIEW"),
      notEligibleWithoutRecord: decided("NOT_ELIGIBLE"),
      recordStatus,
    },
    evidence: {
      pendingOnlineEvidence: onlineEvidence.pending.length,
      unknownApprovalEvidence: onlineEvidence.unknownVisits.length,
      pendingReviews: view.reviewQueue.length,
      complete: evidenceComplete,
    },
    readiness: {
      ready: blockers.length === 0,
      schedule,
      blockers,
      activeSessions: { active: activeCount > 0, count: activeCount },
      rosterLimit: FINALIZATION_ROSTER_LIMIT,
      rosterLimitExceeded,
      evidenceComplete,
    },
    fingerprint: computeFinalizationFingerprint(fingerprintInput),
    fingerprintVersion: FINALIZATION_FINGERPRINT_VERSION,
  };
}
