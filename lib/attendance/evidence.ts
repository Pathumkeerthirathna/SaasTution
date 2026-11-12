/**
 * What new attendance evidence (an online join or a QR scan) does to a
 * student's canonical LectureAttendance record. Pure: it returns a plan; the
 * service (later stage) writes it under the register and record locks.
 * See docs/lecture-attendance.md.
 *
 * Rules (approved design, Stage 5.1 §6):
 *  - Only ELIGIBLE evidence touches the record. NOT_ELIGIBLE and UNKNOWN
 *    evidence changes nothing (UNKNOWN never creates automatic attendance).
 *  - Each channel keeps its EARLIEST time (firstOnlineAt / firstQrAt). Evidence
 *    that does not move a channel's earliest time is a DUPLICATE: no change,
 *    no review, never a second record.
 *  - autoStatus is the status of the earliest evidence of either channel.
 *  - The status changes automatically only when ALL hold: the register is
 *    open, there is no teacher decision, and the record is (or will be) an
 *    AUTO record. Then status = autoStatus.
 *  - Otherwise (teacher decision, finalized register, FINALIZATION or
 *    BACKFILL record) the status is never changed: the evidence is recorded,
 *    and a review is raised when the evidence is stronger than the current
 *    effective status:
 *        current \ evidence | PRESENT | LATE
 *        ABSENT, EXCUSED    | review  | review
 *        LATE               | review  | -
 *        PRESENT            | -       | -
 *    For a channel that already had evidence (reconciliation moving its
 *    earliest time earlier), the evidence must ALSO be stronger than what that
 *    channel already showed; otherwise the teacher has already seen it (and
 *    may have dismissed the review), so no review is raised again. A new
 *    channel follows the table alone. An open review keeps its original
 *    pendingReviewSince.
 *  - BACKFILL exception: a BACKFILL record stays PRESENT (backfill is
 *    PRESENT-only, never a retroactive LATE), so evidence never changes it
 *    automatically, even on an open register. PRESENT is the strongest
 *    status, so evidence never raises a review on it either.
 *  - Evidence must not be later than the supplied server `now` (a future
 *    time is refused); client times are never used.
 *  - After finalization, no record is ever created by evidence
 *    (RECORDED_ONLY): ABSENT records come only from finalization, and other
 *    records only from the teacher.
 */

import type { AttendanceEligibilityOutcome } from "@/lib/attendance/eligibility";
import {
  attendanceStrength,
  autoStatusFor,
  evidenceStatusAt,
  type AttendanceStatus,
  type EvidenceStatus,
  type LatenessSchedule,
} from "@/lib/attendance/status";

export type EvidenceChannel = "ONLINE" | "QR";

export type AttendanceStatusSource = "AUTO" | "TEACHER" | "FINALIZATION" | "BACKFILL";

export type AttendanceScanEffect =
  | "STATUS_UPDATED"
  | "EVIDENCE_ONLY"
  | "REVIEW_REQUIRED"
  | "DUPLICATE"
  | "RECORDED_ONLY"
  | "NONE";

/** The parts of a LectureAttendance row the evidence rule reads. */
export type AttendanceRecordState = {
  status: AttendanceStatus;
  statusSource: AttendanceStatusSource;
  firstOnlineAt: Date | null;
  firstQrAt: Date | null;
  autoStatus: EvidenceStatus | null;
  teacherStatus: AttendanceStatus | null;
  pendingReviewSince: Date | null;
};

/** The parts of a LectureAttendance row the evidence rule may write. */
export type EvidenceRecordFields = {
  status: AttendanceStatus;
  statusSource: AttendanceStatusSource;
  firstOnlineAt: Date | null;
  firstQrAt: Date | null;
  autoStatus: EvidenceStatus;
  pendingReviewSince: Date | null;
};

export type EvidenceRegisterState = LatenessSchedule & {
  /** LectureAttendanceRegister.finalizedAt; null = open. */
  finalizedAt: Date | null;
};

export type EvidenceInput = {
  register: EvidenceRegisterState;
  /** The student's record for this lecture, or null when there is none. */
  record: AttendanceRecordState | null;
  evidence: {
    channel: EvidenceChannel;
    /** Server-recorded scan / join time (never a client timestamp). */
    serverRecordedAt: Date;
  };
  /** Eligibility at evidence.serverRecordedAt (attendanceEligibilityAt). */
  eligibility: AttendanceEligibilityOutcome;
  /** Server time the plan is applied; becomes pendingReviewSince when a review is raised. */
  now: Date;
};

export type EvidenceAuditAction = "CREATED_AUTO" | "AUTO_UPDATED" | "EVIDENCE_RECORDED";

export type EvidencePlan = {
  effect: AttendanceScanEffect;
  /** NONE: write nothing to the record. CREATE / UPDATE: write `fields`. */
  write: "NONE" | "CREATE" | "UPDATE";
  /** The record's fields after the change; null when write is NONE. */
  fields: EvidenceRecordFields | null;
  /** The audit row's action; null when write is NONE. */
  auditAction: EvidenceAuditAction | null;
  /** PRESENT / LATE of this piece of evidence; null when not evaluated (not eligible). */
  evidenceStatus: EvidenceStatus | null;
  /** The register was finalized (AttendanceScanEvent / AttendanceAuditLog.afterFinalization). */
  afterFinalization: boolean;
};

const isValidDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());

/**
 * The approved review matrix: does evidence of status `evidence` need the
 * teacher's attention against the effective status `current`? Only when it is
 * stronger (PRESENT > LATE > ABSENT = EXCUSED).
 */
export function evidenceRequiresReview(current: AttendanceStatus, evidence: EvidenceStatus): boolean {
  return attendanceStrength(evidence) > attendanceStrength(current);
}

function assertConsistentRecord(record: AttendanceRecordState) {
  if (record.teacherStatus !== null && record.status !== record.teacherStatus) {
    throw new Error("Attendance record is inconsistent: a teacher decision must be the effective status.");
  }

  if ((record.statusSource === "TEACHER") !== (record.teacherStatus !== null)) {
    throw new Error("Attendance record is inconsistent: TEACHER source exactly when there is a teacher decision.");
  }
}

/** Plan the effect of one piece of evidence (see the module comment for the rules). */
export function planEvidence(input: EvidenceInput): EvidencePlan {
  const { register, record, evidence, eligibility, now } = input;
  const afterFinalization = register.finalizedAt !== null;

  if (!isValidDate(now)) throw new RangeError("Attendance: a valid server time is required.");
  if (!isValidDate(evidence.serverRecordedAt)) {
    throw new RangeError("Attendance: a valid server-recorded evidence time is required.");
  }
  if (evidence.serverRecordedAt.getTime() > now.getTime()) {
    throw new RangeError("Attendance: evidence cannot be recorded later than the server time.");
  }
  if (register.finalizedAt !== null && !isValidDate(register.finalizedAt)) {
    throw new RangeError("Attendance: the register's finalization time is invalid.");
  }

  const nothing = (effect: AttendanceScanEffect, evidenceStatus: EvidenceStatus | null): EvidencePlan => ({
    effect,
    write: "NONE",
    fields: null,
    auditAction: null,
    evidenceStatus,
    afterFinalization,
  });

  // Not eligible / unknown: never touches the record, never creates one.
  if (eligibility !== "ELIGIBLE") return nothing("NONE", null);

  // Also validates the time and the schedule.
  const evidenceStatus = evidenceStatusAt(evidence.serverRecordedAt, register);
  const at = evidence.serverRecordedAt;

  if (record === null) {
    // ABSENT and every post-finalization record come from finalization or the teacher.
    if (afterFinalization) return nothing("RECORDED_ONLY", evidenceStatus);

    return {
      effect: "STATUS_UPDATED",
      write: "CREATE",
      fields: {
        status: evidenceStatus,
        statusSource: "AUTO",
        firstOnlineAt: evidence.channel === "ONLINE" ? at : null,
        firstQrAt: evidence.channel === "QR" ? at : null,
        autoStatus: evidenceStatus,
        pendingReviewSince: null,
      },
      auditAction: "CREATED_AUTO",
      evidenceStatus,
      afterFinalization,
    };
  }

  assertConsistentRecord(record);

  const previousFirst = evidence.channel === "ONLINE" ? record.firstOnlineAt : record.firstQrAt;

  // Not earlier than what this channel already has: a duplicate.
  if (previousFirst !== null && previousFirst.getTime() <= at.getTime()) {
    return nothing("DUPLICATE", evidenceStatus);
  }

  const firstOnlineAt = evidence.channel === "ONLINE" ? at : record.firstOnlineAt;
  const firstQrAt = evidence.channel === "QR" ? at : record.firstQrAt;
  const autoStatus = autoStatusFor({ firstOnlineAt, firstQrAt }, register) as EvidenceStatus;

  const automatic = !afterFinalization && record.teacherStatus === null && record.statusSource === "AUTO";

  if (automatic) {
    const statusChanged = record.status !== autoStatus;

    return {
      effect: statusChanged ? "STATUS_UPDATED" : "EVIDENCE_ONLY",
      write: "UPDATE",
      fields: {
        status: autoStatus,
        statusSource: "AUTO",
        firstOnlineAt,
        firstQrAt,
        autoStatus,
        pendingReviewSince: record.pendingReviewSince,
      },
      auditAction: statusChanged ? "AUTO_UPDATED" : "EVIDENCE_RECORDED",
      evidenceStatus,
      afterFinalization,
    };
  }

  // The effective status stays; the evidence is recorded and may need review.
  // Same-channel reconciliation must bring genuinely stronger evidence than
  // that channel already showed (a dismissed review is not recreated).
  const strongerThanChannel =
    previousFirst === null || evidenceRequiresReview(evidenceStatusAt(previousFirst, register), evidenceStatus);
  const review = strongerThanChannel && evidenceRequiresReview(record.status, evidenceStatus);

  return {
    effect: review ? "REVIEW_REQUIRED" : "EVIDENCE_ONLY",
    write: "UPDATE",
    fields: {
      status: record.status,
      statusSource: record.statusSource,
      firstOnlineAt,
      firstQrAt,
      autoStatus,
      // An open review keeps its original time.
      pendingReviewSince: review ? (record.pendingReviewSince ?? now) : record.pendingReviewSince,
    },
    auditAction: "EVIDENCE_RECORDED",
    evidenceStatus,
    afterFinalization,
  };
}

/**
 * A teacher's TEACHER_SET / EVIDENCE_ACCEPTED needs a written reason when it
 * replaces an existing effective status or happens after finalization (the
 * AttendanceAuditLog_reason_check rule); a first manual mark on an open
 * register needs none. EVIDENCE_DISMISSED never needs one (the status does not change).
 */
export function teacherDecisionRequiresReason(input: {
  action: "TEACHER_SET" | "EVIDENCE_ACCEPTED" | "EVIDENCE_DISMISSED";
  previousStatus: AttendanceStatus | null;
  afterFinalization: boolean;
}): boolean {
  if (input.action === "EVIDENCE_DISMISSED") return false;
  return input.previousStatus !== null || input.afterFinalization;
}

// ---- QR scanning window ---------------------------------------------------------------

/** QR scanning opens this long before the scheduled start (exactly). */
export const QR_SCAN_OPENS_MINUTES_BEFORE_START = 30;

export type QrScanWindowState = "NOT_OPEN" | "OPEN" | "CLOSED";

/** The first instant a QR scan is accepted: scheduled start minus exactly 30 minutes. */
export function qrScanOpensAt(scheduledStartAt: Date): Date {
  if (!(scheduledStartAt instanceof Date) || Number.isNaN(scheduledStartAt.getTime())) {
    throw new RangeError("Attendance: a valid scheduled start is required.");
  }
  return new Date(scheduledStartAt.getTime() - QR_SCAN_OPENS_MINUTES_BEFORE_START * 60_000);
}

/**
 * Whether a QR scan received (server time) at `receivedAt` may be accepted:
 * CLOSED once the teacher closed QR attendance (whatever the time; the
 * scheduled end never closes it), NOT_OPEN before scheduledStart - 30 minutes,
 * OPEN from that instant on. PRESENT / LATE is decided separately (grace).
 */
export function qrScanWindowState(input: { scheduledStartAt: Date; closed: boolean; receivedAt: Date }): QrScanWindowState {
  if (!(input.receivedAt instanceof Date) || Number.isNaN(input.receivedAt.getTime())) {
    throw new RangeError("Attendance: a valid server-recorded scan time is required.");
  }
  if (input.closed) return "CLOSED";
  return input.receivedAt.getTime() < qrScanOpensAt(input.scheduledStartAt).getTime() ? "NOT_OPEN" : "OPEN";
}

