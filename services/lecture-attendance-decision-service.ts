/**
 * Unified lecture attendance, Stage 5.4d: the teacher's manual attendance
 * decisions. See docs/lecture-attendance.md ("Manual decisions").
 *
 * setTeacherAttendanceStatus marks one student PRESENT, LATE, ABSENT or
 * EXCUSED for a lecture. Rules (approved):
 *  - only the lecture's teacher; only their own ACTIVE student (Student.status
 *    0; inactive and deleted students are refused: Stage 5.6a) who has (or had)
 *    an enrolment row in the lecture's class, whatever the student's automatic
 *    eligibility (UNKNOWN or NOT_APPROVED included): no approval history is
 *    read, and nothing about eligibility is changed;
 *  - the first mark needs no reason; replacing an existing status (an
 *    automatic one included) needs a reason, and so does any decision after
 *    finalization (AttendanceAuditLog_reason_check). Reasons are trimmed,
 *    non-blank, at most 500 characters;
 *  - the decision becomes the effective status (source TEACHER) and clears a
 *    pending review; recorded evidence (first online / QR times, evidence
 *    status) is kept. Later conflicting evidence never changes it: it goes
 *    through the existing review rule (planEvidence);
 *  - deciding the status the teacher already decided is a no-op (no write,
 *    no audit); a pending review is answered with accept / dismiss instead;
 *  - optimistic concurrency: `expectedVersion` is the record version the
 *    teacher was looking at (null: "there is no record yet"); anything else
 *    is 409 ATTENDANCE_RECORD_CHANGED.
 *
 * One attendance transaction, in the global lock order: the Student FOR
 * SHARE (Stage 5.6a: the active / ownership check holds until commit), the
 * Lecture FOR SHARE and the Class FOR KEY SHARE (re-checked under the lock: 404 deleted /
 * another teacher's, 409 cancelled), the register FOR KEY SHARE (created when
 * needed), the record FOR NO KEY UPDATE (or its lock-phase insert), then the
 * record change and its TEACHER_SET audit row in the write phase. The register
 * itself is never modified, so a finalized register keeps its frozen
 * schedule. No configuration is needed. Database errors are never caught
 * inside the transaction.
 */

import { randomUUID } from "node:crypto";

import { teacherDecisionRequiresReason } from "@/lib/attendance/evidence";
import {
  insertRecordIfAbsent,
  lockRecords,
  lockStudentShared,
  runAttendanceTransaction,
  type AttendanceLocks,
  type LockedRecord,
} from "@/lib/attendance/locks";
import { attendanceError } from "@/lib/attendance/service-errors";
import { normalizeReason } from "@/services/lecture-attendance-evidence-service";
import { ensureRegister, requireLectureForAttendance } from "@/services/lecture-attendance-service";

export type TeacherAttendanceStatus = "PRESENT" | "LATE" | "ABSENT" | "EXCUSED";

const STATUSES: readonly TeacherAttendanceStatus[] = ["PRESENT", "LATE", "ABSENT", "EXCUSED"];

export type TeacherDecisionInput = {
  teacherId: string;
  lectureId: string;
  studentId: string;
  status: TeacherAttendanceStatus;
  /** The record version the teacher saw; null when there was no record. */
  expectedVersion: number | null;
  reason?: string | null;
};

export type TeacherDecisionResult = {
  lectureId: string;
  studentId: string;
  status: TeacherAttendanceStatus;
  statusSource: "TEACHER";
  teacherStatus: TeacherAttendanceStatus;
  /** Recorded evidence status (kept, never changed by a decision). */
  autoStatus: "PRESENT" | "LATE" | null;
  pendingReview: boolean;
  version: number;
  afterFinalization: boolean;
  /** False when the teacher had already decided this status (nothing written). */
  changed: boolean;
};

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 191) {
    throw attendanceError("VALIDATION_ERROR", { field });
  }
}

/**
 * The teacher's decision for one student (see the module header). Errors: 400
 * VALIDATION_ERROR (status, version, reason length, ids), 400
 * ATTENDANCE_REASON_REQUIRED, 404 LECTURE_NOT_FOUND / STUDENT_NOT_FOUND (also
 * an inactive or deleted student), 409
 * LECTURE_CANCELLED, 409 ATTENDANCE_STUDENT_NOT_ENROLLED (never enrolled in
 * the class), 409 ATTENDANCE_RECORD_CHANGED, 409 ATTENDANCE_BUSY.
 */
export async function setTeacherAttendanceStatus(input: TeacherDecisionInput): Promise<TeacherDecisionResult> {
  assertId(input.teacherId, "teacherId");
  assertId(input.lectureId, "lectureId");
  assertId(input.studentId, "studentId");
  if (!STATUSES.includes(input.status)) throw attendanceError("VALIDATION_ERROR", { field: "status" });
  const expectedVersion = input.expectedVersion;
  if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
    throw attendanceError("VALIDATION_ERROR", { field: "expectedVersion" });
  }
  const reason = normalizeReason(input.reason);

  return runAttendanceTransaction((locks) => decideInTransaction(locks, { ...input, expectedVersion, reason }));
}

async function decideInTransaction(
  locks: AttendanceLocks,
  input: TeacherDecisionInput & { reason: string | null }
): Promise<TeacherDecisionResult> {
  const now = new Date();

  // 1. The student row FOR SHARE, first (global lock order: Student before
  //    Lecture). A deactivation or deletion cannot commit until this decision
  //    does, and one committed before is seen here. Checked after the lecture
  //    (step 2), so the lecture's own 404 / 409 keep their precedence.
  const lockedStudent = await lockStudentShared(locks, input.studentId);

  // 2. The lecture and class under their locks (ownership, deleted, cancelled).
  const { lecture } = await requireLectureForAttendance(locks, input.lectureId, { teacherId: input.teacherId });

  // 3. The student: this teacher's and active (Student.status 0; 1 inactive and
  //    2 deleted are refused, the same 404 as a missing or another teacher's
  //    student), with an enrolment row (current or removed) in the class.
  if (!lockedStudent || lockedStudent.teacherId !== input.teacherId || lockedStudent.status !== 0) {
    throw attendanceError("STUDENT_NOT_FOUND");
  }
  const enrolments = await locks.db.classStudent.findMany({
    where: { studentId: input.studentId, classId: lecture.classId },
    select: { id: true },
    take: 1,
  });
  if (enrolments.length === 0) throw attendanceError("ATTENDANCE_STUDENT_NOT_ENROLLED");

  // 3. The register (created when needed; never modified) and the record.
  const { register } = await ensureRegister(locks, input.lectureId, {
    mode: "KEY_SHARE",
    now,
    actor: { role: "TEACHER", teacherId: input.teacherId },
    teacherId: input.teacherId,
  });
  const afterFinalization = register.finalizedAt !== null;
  const record: LockedRecord | null = (await lockRecords(locks, input.lectureId, [input.studentId]))[0] ?? null;

  if ((record === null) !== (input.expectedVersion === null) || (record !== null && record.version !== input.expectedVersion)) {
    throw attendanceError("ATTENDANCE_RECORD_CHANGED");
  }

  // 4. Same decision again: nothing to do.
  if (record !== null && record.teacherStatus === input.status) {
    return present(input, record, afterFinalization, false);
  }

  // 5. Reason rule (the database CHECK, enforced here first with a clear error).
  const previousStatus = record?.status ?? null;
  if (teacherDecisionRequiresReason({ action: "TEACHER_SET", previousStatus, afterFinalization }) && input.reason === null) {
    throw attendanceError("ATTENDANCE_REASON_REQUIRED");
  }

  // 6. Write: a new record (lock phase) or the locked one (write phase), and the audit row.
  let recordId: string;
  let version: number;
  if (record === null) {
    recordId = randomUUID();
    const inserted = await insertRecordIfAbsent(locks, {
      id: recordId,
      lectureId: input.lectureId,
      classId: lecture.classId,
      studentId: input.studentId,
      status: input.status,
      statusSource: "TEACHER",
      firstOnlineAt: null,
      firstQrAt: null,
      autoStatus: null,
      teacherStatus: input.status,
      teacherDecidedAt: now,
      teacherDecidedById: input.teacherId,
      pendingReviewSince: null,
      now,
    });
    // Created concurrently (evidence or another decision): the teacher did not see it.
    if (!inserted) throw attendanceError("ATTENDANCE_RECORD_CHANGED");
    version = 1;
    locks.beginWrites();
  } else {
    recordId = record.id;
    version = record.version + 1;
    locks.beginWrites();
    await locks.db.lectureAttendance.update({
      where: { id: record.id, version: record.version },
      data: {
        status: input.status,
        statusSource: "TEACHER",
        teacherStatus: input.status,
        teacherDecidedAt: now,
        teacherDecidedById: input.teacherId,
        pendingReviewSince: null,
        version,
        updatedAt: now,
      },
    });
  }

  await locks.db.attendanceAuditLog.create({
    data: {
      lectureAttendanceId: recordId,
      version,
      lectureId: input.lectureId,
      studentId: input.studentId,
      action: "TEACHER_SET",
      fromStatus: previousStatus,
      toStatus: input.status,
      fromTeacherStatus: record?.teacherStatus ?? null,
      toTeacherStatus: input.status,
      fromAutoStatus: record?.autoStatus ?? null,
      toAutoStatus: record?.autoStatus ?? null,
      actorRole: "TEACHER",
      actorId: input.teacherId,
      reason: input.reason,
      afterFinalization,
      createdAt: now,
    },
  });

  return {
    lectureId: input.lectureId,
    studentId: input.studentId,
    status: input.status,
    statusSource: "TEACHER",
    teacherStatus: input.status,
    autoStatus: record?.autoStatus ?? null, // evidence is kept as it was
    pendingReview: false,
    version,
    afterFinalization,
    changed: true,
  };
}

function present(
  input: TeacherDecisionInput,
  record: LockedRecord,
  afterFinalization: boolean,
  changed: boolean
): TeacherDecisionResult {
  return {
    lectureId: input.lectureId,
    studentId: input.studentId,
    status: input.status,
    statusSource: "TEACHER",
    teacherStatus: input.status,
    autoStatus: record.autoStatus,
    pendingReview: record.pendingReviewSince !== null,
    version: record.version,
    afterFinalization,
    changed,
  };
}
