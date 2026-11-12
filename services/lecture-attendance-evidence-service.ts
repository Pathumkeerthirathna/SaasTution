/**
 * Unified lecture attendance, Stage 5.4b: evidence processing and review.
 * See docs/lecture-attendance.md ("Evidence processing").
 *
 *  - QR scans: services/lecture-attendance-qr-service.ts (kept separate so the
 *    online-join path never loads the QR token module, which is server-only);
 *  - recordOnlineEvidence: the canonical evidence of one committed online
 *    visit (Attendance row), in its OWN transaction, after the visit's
 *    transaction committed (dispatched by services/attendance-evidence-dispatcher.ts).
 *  - acceptEvidence / dismissEvidence: the teacher's answer to a review (only
 *    for the teacher's own active student, Student FOR SHARE first: Stage 5.6a).
 *
 * Every write runs in runAttendanceTransaction, in the global lock order
 * (Student -> Lecture -> Class -> Register -> record -> writes), re-checks
 * the lecture under its lock, and never catches a database error inside the
 * transaction: errors propagate, the transaction rolls back, and only then
 * are they mapped (lock errors -> 409 ATTENDANCE_BUSY; a scan's unique-key
 * clash -> the stored outcome).
 *
 * Eligibility (approval AND enrolment) is evaluated at the exact
 * server-recorded evidence time: the scan's receivedAt, the visit's joinedAt.
 * Client times are never used (clientScannedAt is not stored here).
 *
 * Configuration: QR scans and online evidence need BOTH settings (fail
 * closed); accept / dismiss need neither (they act on evidence already stored).
 */

import { randomUUID } from "node:crypto";

import {
  classifyLecture,
  loadApprovalConfig,
  loadEvidenceConfig,
  warnConfigurationOnce,
  ATTENDANCE_EVIDENCE_STARTED_AT_SETTING,
} from "@/lib/attendance/config";
import { attendanceEligibilityAt } from "@/lib/attendance/eligibility";
import { planEvidence, teacherDecisionRequiresReason, type EvidenceChannel, type EvidencePlan } from "@/lib/attendance/evidence";
import {
  insertRecordIfAbsent,
  lockRecords,
  lockRegisterKeyShared,
  lockStudentShared,
  runAttendanceTransaction,
  type AttendanceLocks,
  type LockedRecord,
  type LockedRegister,
} from "@/lib/attendance/locks";
import { attendanceError } from "@/lib/attendance/service-errors";
import { prisma } from "@/lib/prisma";
import {
  APPROVAL_FEATURE_STARTED_AT_SETTING,
  type ApprovalHistoryContext,
} from "@/lib/student-confirmation-history";
import { ensureRegister, inspectLectureForAttendance, requireLectureForAttendance } from "@/services/lecture-attendance-service";

type Env = Record<string, string | undefined>;

/** Effects that link a scan event to the record (AttendanceScanEvent_record_link_check). */
export const LINKED_EFFECTS = new Set(["STATUS_UPDATED", "EVIDENCE_ONLY", "REVIEW_REQUIRED", "DUPLICATE"]);

/** Same value as services/student-qr-service.ts: Student.status 2 = deleted. */
export const DELETED_STUDENT_STATUS = 2;

export const MAX_REASON_LENGTH = 500;

const isValidDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());
export const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

// =========================================================================================
// Shared: apply one piece of eligible evidence to the locked record
// =========================================================================================

export type AppliedEvidence = {
  plan: EvidencePlan;
  before: LockedRecord | null;
  recordId: string | null;
  /** The record's version after this change (null when nothing was written). */
  version: number | null;
};

function recordState(record: LockedRecord | null) {
  return record
    ? {
        status: record.status,
        statusSource: record.statusSource,
        firstOnlineAt: record.firstOnlineAt,
        firstQrAt: record.firstQrAt,
        autoStatus: record.autoStatus,
        teacherStatus: record.teacherStatus,
        pendingReviewSince: record.pendingReviewSince,
      }
    : null;
}

/**
 * Locks the student's record, plans the evidence (planEvidence: teacher
 * decisions stay authoritative; finalized registers never change status),
 * creates the record when the plan says so (lock phase; a concurrent creator
 * makes it re-lock and re-plan), then starts the write phase and updates an
 * existing record. The caller holds the Student (evidence paths), the Lecture,
 * the Class and the register; it writes the scan event and the audit row.
 */
export async function applyEvidenceInTransaction(
  locks: AttendanceLocks,
  input: {
    register: LockedRegister;
    lectureId: string;
    classId: string;
    studentId: string;
    channel: EvidenceChannel;
    serverRecordedAt: Date;
    now: Date;
  }
): Promise<AppliedEvidence> {
  const schedule = {
    scheduledStartAt: input.register.scheduledStartAt,
    graceMinutes: input.register.graceMinutes,
    finalizedAt: input.register.finalizedAt,
  };
  const plan = (record: LockedRecord | null) =>
    planEvidence({
      register: schedule,
      record: recordState(record),
      evidence: { channel: input.channel, serverRecordedAt: input.serverRecordedAt },
      eligibility: "ELIGIBLE",
      now: input.now,
    });

  let before = (await lockRecords(locks, input.lectureId, [input.studentId]))[0] ?? null;
  let planned = plan(before);
  let recordId = before?.id ?? null;

  if (planned.write === "CREATE" && planned.fields) {
    const id = randomUUID();
    const inserted = await insertRecordIfAbsent(locks, {
      id,
      lectureId: input.lectureId,
      classId: input.classId,
      studentId: input.studentId,
      ...planned.fields,
      teacherStatus: null,
      teacherDecidedAt: null,
      teacherDecidedById: null,
      now: input.now,
    });

    if (inserted) {
      recordId = id;
    } else {
      // A concurrent transaction created it first: lock the committed row and plan again.
      before = (await lockRecords(locks, input.lectureId, [input.studentId]))[0] ?? null;
      if (!before) throw new Error("Attendance: the record is missing after a conflicting insert.");
      planned = plan(before);
      recordId = before.id;
      if (planned.write === "CREATE") throw new Error("Attendance: an existing record was planned as new.");
    }
  }

  locks.beginWrites();

  if (planned.write === "UPDATE" && planned.fields && before) {
    await locks.db.lectureAttendance.update({
      where: { id: before.id, version: before.version },
      data: { ...planned.fields, version: before.version + 1, updatedAt: input.now },
    });
  }

  const version = planned.write === "CREATE" ? 1 : planned.write === "UPDATE" && before ? before.version + 1 : null;
  return { plan: planned, before, recordId, version };
}

/** The AttendanceAuditLog row of an evidence change (SYSTEM actor). */
export async function writeEvidenceAudit(
  locks: AttendanceLocks,
  applied: AppliedEvidence,
  input: { lectureId: string; studentId: string; now: Date; scanEventId?: string; attendanceVisitId?: string }
) {
  const { plan, before, recordId, version } = applied;
  if (plan.write === "NONE" || !plan.fields || !plan.auditAction || !recordId || version === null) return;

  await locks.db.attendanceAuditLog.create({
    data: {
      lectureAttendanceId: recordId,
      version,
      lectureId: input.lectureId,
      studentId: input.studentId,
      action: plan.auditAction,
      fromStatus: before?.status ?? null,
      toStatus: plan.fields.status,
      // Evidence never changes a teacher decision.
      fromTeacherStatus: before?.teacherStatus ?? null,
      toTeacherStatus: before?.teacherStatus ?? null,
      fromAutoStatus: before?.autoStatus ?? null,
      toAutoStatus: plan.fields.autoStatus,
      actorRole: "SYSTEM",
      actorId: null,
      reason: null,
      afterFinalization: plan.afterFinalization,
      scanEventId: input.scanEventId ?? null,
      attendanceVisitId: input.attendanceVisitId ?? null,
      createdAt: input.now,
    },
  });
}

export async function readEligibilityInputs(locks: AttendanceLocks, studentId: string, classId: string) {
  const [history, enrolments] = await Promise.all([
    locks.db.studentConfirmationHistory.findMany({
      where: { studentId },
      select: { id: true, fromStatus: true, toStatus: true, decidedAt: true, previousConfirmedAt: true },
    }),
    locks.db.classStudent.findMany({
      where: { studentId, classId },
      select: { id: true, classId: true, assignedAt: true, removedAt: true, isActive: true },
    }),
  ]);
  return { history, enrolments };
}

// =========================================================================================
// Online evidence (after the visit's own transaction committed)
// =========================================================================================

export type OnlineEvidenceSkipReason =
  | "APPROVAL_NOT_CONFIGURED"
  | "EVIDENCE_NOT_CONFIGURED"
  | "VISIT_NOT_FOUND"
  | "NO_LECTURE"
  | "STUDENT_NOT_FOUND"
  | "LECTURE_UNAVAILABLE"
  | "NOT_TEACHERS_STUDENT"
  | "HISTORICAL_LECTURE";

export type OnlineEvidenceResult =
  | { status: "APPLIED"; effect: string }
  | { status: "NOT_ELIGIBLE"; outcome: "NOT_ELIGIBLE" | "UNKNOWN" }
  | { status: "SKIPPED"; reason: OnlineEvidenceSkipReason };

/**
 * The canonical evidence of one committed visit. Reads the visit (its
 * student, its joinedAt, its session's lecture), then in one transaction:
 * the Student FOR SHARE, the lecture re-checked under its lock (U8: deleted /
 * cancelled lectures are skipped), HISTORICAL lectures skipped (R5),
 * eligibility at joinedAt (UNKNOWN / NOT_ELIGIBLE: nothing written), the
 * register (created when needed) and the record (planEvidence), and the
 * audit row linked to the visit. Missing configuration: skipped, nothing
 * read or written. Never touches the Attendance row itself.
 */
export async function recordOnlineEvidence(visitId: string, options: { env?: Env } = {}): Promise<OnlineEvidenceResult> {
  const env = options.env ?? process.env;
  const approval = loadApprovalConfig(env);
  const evidence = loadEvidenceConfig(env);

  if (approval.status !== "OK") {
    warnConfigurationOnce(APPROVAL_FEATURE_STARTED_AT_SETTING, approval.status);
    return { status: "SKIPPED", reason: "APPROVAL_NOT_CONFIGURED" };
  }
  if (evidence.status !== "OK") {
    warnConfigurationOnce(ATTENDANCE_EVIDENCE_STARTED_AT_SETTING, evidence.status);
    return { status: "SKIPPED", reason: "EVIDENCE_NOT_CONFIGURED" };
  }

  const visit = await prisma.attendance.findUnique({
    where: { id: visitId },
    select: { id: true, studentId: true, joinedAt: true, classSession: { select: { lectureId: true } } },
  });
  if (!visit || !isValidDate(visit.joinedAt)) return { status: "SKIPPED", reason: "VISIT_NOT_FOUND" };
  const lectureId = visit.classSession.lectureId;
  if (!lectureId) return { status: "SKIPPED", reason: "NO_LECTURE" };

  return runAttendanceTransaction((locks) =>
    onlineEvidenceInTransaction(locks, {
      visitId: visit.id,
      studentId: visit.studentId,
      joinedAt: visit.joinedAt,
      lectureId,
      context: approval.context,
      evidenceStartedAt: evidence.evidenceStartedAt,
    })
  );
}

async function onlineEvidenceInTransaction(
  locks: AttendanceLocks,
  ctx: { visitId: string; studentId: string; joinedAt: Date; lectureId: string; context: ApprovalHistoryContext; evidenceStartedAt: Date }
): Promise<OnlineEvidenceResult> {
  const student = await lockStudentShared(locks, ctx.studentId);
  if (!student) return { status: "SKIPPED", reason: "STUDENT_NOT_FOUND" };

  const found = await inspectLectureForAttendance(locks, ctx.lectureId);
  if (found.state !== "OK") return { status: "SKIPPED", reason: "LECTURE_UNAVAILABLE" };
  if (student.teacherId !== found.cls.teacherId) return { status: "SKIPPED", reason: "NOT_TEACHERS_STUDENT" };

  const existing = await lockRegisterKeyShared(locks, ctx.lectureId);
  const start = existing?.scheduledStartAt ?? found.lecture.date;
  if (classifyLecture(start, ctx.evidenceStartedAt) === "HISTORICAL") return { status: "SKIPPED", reason: "HISTORICAL_LECTURE" };

  const { history, enrolments } = await readEligibilityInputs(locks, student.id, found.lecture.classId);
  const eligibility = attendanceEligibilityAt({
    student,
    history,
    enrolments,
    classId: found.lecture.classId,
    instant: ctx.joinedAt,
    context: ctx.context,
  });
  if (eligibility.outcome !== "ELIGIBLE") return { status: "NOT_ELIGIBLE", outcome: eligibility.outcome };

  const now = later(new Date(), ctx.joinedAt);
  const ensured = await ensureRegister(locks, ctx.lectureId, { mode: "KEY_SHARE", now, actor: { role: "SYSTEM" } });
  const applied = await applyEvidenceInTransaction(locks, {
    register: ensured.register,
    lectureId: ctx.lectureId,
    classId: found.lecture.classId,
    studentId: student.id,
    channel: "ONLINE",
    serverRecordedAt: ctx.joinedAt,
    now,
  });
  await writeEvidenceAudit(locks, applied, { lectureId: ctx.lectureId, studentId: student.id, now, attendanceVisitId: ctx.visitId });
  return { status: "APPLIED", effect: applied.plan.effect };
}

// =========================================================================================
// Review: accept / dismiss (the teacher answers pending evidence)
// =========================================================================================

export type ReviewedRecord = {
  id: string;
  studentId: string;
  status: string;
  statusSource: string;
  autoStatus: string | null;
  teacherStatus: string | null;
  pendingReviewSince: Date | null;
  version: number;
};

/** Trimmed reason, or null; 400 VALIDATION_ERROR when too long or not text. Shared with manual decisions. */
export function normalizeReason(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw attendanceError("VALIDATION_ERROR", { field: "reason" });
  const reason = raw.trim();
  if (reason.length > MAX_REASON_LENGTH) throw attendanceError("VALIDATION_ERROR", { field: "reason" });
  return reason === "" ? null : reason;
}

function assertExpectedVersion(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1) throw attendanceError("VALIDATION_ERROR", { field: "expectedVersion" });
}

type ReviewInput = { teacherId: string; lectureId: string; studentId: string; expectedVersion: number; reason?: string | null };

/**
 * Accepts the pending evidence as the teacher's decision: teacherStatus and
 * status become the evidence status (autoStatus), source TEACHER, the review
 * is cleared. A reason is always required (it replaces an existing status:
 * AttendanceAuditLog_reason_check). 409 ATTENDANCE_RECORD_CHANGED when the
 * record moved past expectedVersion; 409 ATTENDANCE_NO_PENDING_REVIEW when
 * there is nothing to accept; 404 STUDENT_NOT_FOUND unless the student is
 * the teacher's own active student (Stage 5.6a; locked FOR SHARE first).
 * Needs no configuration.
 */
export async function acceptEvidence(input: ReviewInput): Promise<ReviewedRecord> {
  return reviewEvidence("EVIDENCE_ACCEPTED", input);
}

/** Dismisses the pending evidence: the status stays; the review is cleared. Reason optional. */
export async function dismissEvidence(input: ReviewInput): Promise<ReviewedRecord> {
  return reviewEvidence("EVIDENCE_DISMISSED", input);
}

async function reviewEvidence(action: "EVIDENCE_ACCEPTED" | "EVIDENCE_DISMISSED", input: ReviewInput): Promise<ReviewedRecord> {
  if (typeof input.teacherId !== "string" || typeof input.lectureId !== "string" || typeof input.studentId !== "string") {
    throw attendanceError("VALIDATION_ERROR");
  }
  assertExpectedVersion(input.expectedVersion);
  const reason = normalizeReason(input.reason);

  return runAttendanceTransaction((locks) => reviewInTransaction(locks, action, { ...input, reason }));
}

async function reviewInTransaction(
  locks: AttendanceLocks,
  action: "EVIDENCE_ACCEPTED" | "EVIDENCE_DISMISSED",
  input: ReviewInput & { reason: string | null }
): Promise<ReviewedRecord> {
  // Stage 5.6a: the student row FOR SHARE, first (global lock order: Student
  // before Lecture), so the ownership / active check below holds until commit
  // (a deactivation, deletion or transfer cannot commit in between).
  const student = await lockStudentShared(locks, input.studentId);

  await requireLectureForAttendance(locks, input.lectureId, { teacherId: input.teacherId });

  // Only the teacher's own active student (Student.status 0): another teacher's,
  // an inactive (1) or a deleted (2) student is the same 404 as a missing one,
  // even on the teacher's own lecture. Checked after the lecture, whose 404 /
  // 409 keep their precedence.
  if (!student || student.teacherId !== input.teacherId || student.status !== 0) throw attendanceError("STUDENT_NOT_FOUND");

  const register = await lockRegisterKeyShared(locks, input.lectureId);
  if (!register) throw attendanceError("ATTENDANCE_NO_PENDING_REVIEW");

  const record = (await lockRecords(locks, input.lectureId, [input.studentId]))[0] ?? null;
  if (!record) throw attendanceError("ATTENDANCE_NO_PENDING_REVIEW");
  if (record.version !== input.expectedVersion) throw attendanceError("ATTENDANCE_RECORD_CHANGED");
  if (record.pendingReviewSince === null) throw attendanceError("ATTENDANCE_NO_PENDING_REVIEW");
  if (action === "EVIDENCE_ACCEPTED" && record.autoStatus === null) throw attendanceError("ATTENDANCE_NO_PENDING_REVIEW");

  const afterFinalization = register.finalizedAt !== null;
  if (teacherDecisionRequiresReason({ action, previousStatus: record.status, afterFinalization }) && input.reason === null) {
    throw attendanceError("ATTENDANCE_REASON_REQUIRED");
  }

  const now = new Date();
  const version = record.version + 1;
  const accepted = action === "EVIDENCE_ACCEPTED" ? record.autoStatus! : null;

  locks.beginWrites();

  const updated = await locks.db.lectureAttendance.update({
    where: { id: record.id, version: record.version },
    data:
      accepted !== null
        ? {
            status: accepted,
            statusSource: "TEACHER",
            teacherStatus: accepted,
            teacherDecidedAt: now,
            teacherDecidedById: input.teacherId,
            pendingReviewSince: null,
            version,
            updatedAt: now,
          }
        : { pendingReviewSince: null, version, updatedAt: now },
    select: {
      id: true,
      studentId: true,
      status: true,
      statusSource: true,
      autoStatus: true,
      teacherStatus: true,
      pendingReviewSince: true,
      version: true,
    },
  });

  await locks.db.attendanceAuditLog.create({
    data: {
      lectureAttendanceId: record.id,
      version,
      lectureId: input.lectureId,
      studentId: input.studentId,
      action,
      fromStatus: record.status,
      toStatus: accepted ?? record.status,
      fromTeacherStatus: record.teacherStatus,
      toTeacherStatus: accepted ?? record.teacherStatus,
      fromAutoStatus: record.autoStatus,
      toAutoStatus: record.autoStatus,
      actorRole: "TEACHER",
      actorId: input.teacherId,
      reason: input.reason,
      afterFinalization,
      createdAt: now,
    },
  });

  return updated;
}
