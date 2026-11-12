/**
 * Unified lecture attendance, Stage 5.7b-2b-2: the teacher's per-lecture
 * grace period. See docs/lecture-attendance.md.
 *
 * setRegisterGraceMinutes changes the grace period stored in one lecture's
 * attendance register (the value every PRESENT / LATE classification of that
 * lecture uses). Rules (approved):
 *  - only the lecture's teacher (404 another teacher's, missing or deleted
 *    lecture); 409 LECTURE_CANCELLED for a cancelled lecture; HISTORICAL
 *    lectures are allowed; no attendance configuration is needed;
 *  - 0–240 whole minutes (isValidGraceMinutes, the database CHECK's range);
 *  - expectedVersion is the register version the teacher saw: 0 = no register
 *    (the register API's convention); anything else is 409
 *    ATTENDANCE_REGISTER_CHANGED, never retried;
 *  - a finalized register is 409 ATTENDANCE_REGISTER_FINALIZED (the database
 *    also freezes it);
 *  - unchanged value: a no-op (no write, no audit, no version change); no
 *    register yet and the class's default requested: a no-op that creates
 *    nothing;
 *  - no register yet and another value: the register is created from the
 *    class default (version 1, CREATED audit) and then changed (version 2);
 *  - an effective change: the register's grace and version + 1 (exactly
 *    once), one GRACE_CHANGED register audit (the teacher, from / to, the
 *    reason, recalculatedCount), and the recalculation of every record with
 *    evidence (the schedule sync's helpers, unchanged: AUTO statuses follow
 *    the new evidence status; TEACHER, BACKFILL and FINALIZATION statuses
 *    stay and only autoStatus changes; reviews untouched; one
 *    AUTO_RECALCULATED audit per changed record, linked to the GRACE_CHANGED
 *    audit). No evidence event is created; online visits are never touched;
 *  - a reason (trimmed, at most 500 characters) is required when the change
 *    recalculates existing records (400 ATTENDANCE_REASON_REQUIRED); optional
 *    otherwise.
 *
 * One attendance transaction, in the global lock order: the Lecture FOR
 * SHARE and the Class FOR KEY SHARE (re-checked under the lock), the register
 * FOR UPDATE (waits for every evidence, decision, review, reconciliation and
 * closure transaction holding it FOR KEY SHARE and blocks new ones; created
 * when needed), the records with evidence FOR NO KEY UPDATE in ascending
 * studentId, then the writes. Any failure rolls everything back.
 */

import { isValidGraceMinutes } from "@/lib/attendance/status";
import { lockRegisterForUpdate, runAttendanceTransaction, type AttendanceLocks } from "@/lib/attendance/locks";
import { attendanceError } from "@/lib/attendance/service-errors";
import { normalizeReason } from "@/services/lecture-attendance-evidence-service";
import {
  ensureRegister,
  lockRecordsWithEvidence,
  planAutoStatusRecalculation,
  recalculateAutoStatusesInTransaction,
  requireLectureForAttendance,
} from "@/services/lecture-attendance-service";

export type RegisterGraceInput = {
  teacherId: string;
  lectureId: string;
  graceMinutes: number;
  /** The register version the teacher saw; 0 when there was no register. */
  expectedVersion: number;
  reason?: string | null;
};

export type RegisterGraceResult = {
  lectureId: string;
  /** The register's grace after the call (the requested value). */
  graceMinutes: number;
  /** The register's version after the call (0: still no register). */
  registerVersion: number;
  /** False: nothing was written (the value was already in effect). */
  changed: boolean;
  /** True when this call created the register. */
  registerCreated: boolean;
  /** Records whose evidence status was recalculated. */
  recalculatedCount: number;
};

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 191) {
    throw attendanceError("VALIDATION_ERROR", { field });
  }
}

/** The per-lecture grace period (see the module header). */
export async function setRegisterGraceMinutes(input: RegisterGraceInput): Promise<RegisterGraceResult> {
  assertId(input.teacherId, "teacherId");
  assertId(input.lectureId, "lectureId");
  if (!isValidGraceMinutes(input.graceMinutes)) throw attendanceError("VALIDATION_ERROR", { field: "graceMinutes" });
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw attendanceError("VALIDATION_ERROR", { field: "expectedVersion" });
  }
  const reason = normalizeReason(input.reason);

  return runAttendanceTransaction((locks) => changeGraceInTransaction(locks, { ...input, reason }));
}

async function changeGraceInTransaction(
  locks: AttendanceLocks,
  input: RegisterGraceInput & { reason: string | null }
): Promise<RegisterGraceResult> {
  const now = new Date();
  const noop = (registerVersion: number, registerCreated = false): RegisterGraceResult => ({
    lectureId: input.lectureId,
    graceMinutes: input.graceMinutes,
    registerVersion,
    changed: false,
    registerCreated,
    recalculatedCount: 0,
  });

  // 1. Lecture FOR SHARE, Class FOR KEY SHARE (ownership, deleted, cancelled).
  const { cls } = await requireLectureForAttendance(locks, input.lectureId, { teacherId: input.teacherId });

  // 2. The register FOR UPDATE; created only for an effective change.
  let register = await lockRegisterForUpdate(locks, input.lectureId);
  let created = false;
  if (register === null) {
    if (input.expectedVersion !== 0) throw attendanceError("ATTENDANCE_REGISTER_CHANGED");
    // The class default is what a new register would get: nothing to change, nothing created.
    if (input.graceMinutes === cls.attendanceGraceMinutes) return noop(0);
    const ensured = await ensureRegister(locks, input.lectureId, {
      mode: "UPDATE",
      now,
      actor: { role: "TEACHER", teacherId: input.teacherId },
      teacherId: input.teacherId,
    });
    // Created concurrently by another transaction: the teacher did not see it.
    if (!ensured.created) throw attendanceError("ATTENDANCE_REGISTER_CHANGED");
    register = ensured.register;
    created = true;
  } else {
    if (register.finalizedAt !== null) throw attendanceError("ATTENDANCE_REGISTER_FINALIZED");
    if (register.version !== input.expectedVersion) throw attendanceError("ATTENDANCE_REGISTER_CHANGED");
  }

  // Already in effect: nothing to write (a just-created register keeps its CREATED audit).
  if (register.graceMinutes === input.graceMinutes) return noop(register.version, created);

  // 3. The records with evidence, then the recalculation plan under the NEW grace.
  const records = await lockRecordsWithEvidence(locks, input.lectureId);
  const changes = planAutoStatusRecalculation(records, { scheduledStartAt: register.scheduledStartAt, graceMinutes: input.graceMinutes });

  // 4. A reason is required when existing records are recalculated.
  if (changes.length > 0 && input.reason === null) throw attendanceError("ATTENDANCE_REASON_REQUIRED");

  // 5. Write phase: the register (version + 1, once), its GRACE_CHANGED audit, the recalculated records.
  locks.beginWrites();
  const version = register.version + 1;
  await locks.db.lectureAttendanceRegister.update({
    where: { lectureId: register.lectureId, version: register.version },
    data: { graceMinutes: input.graceMinutes, version, updatedAt: now },
  });
  const audit = await locks.db.lectureAttendanceRegisterAuditLog.create({
    data: {
      lectureId: register.lectureId,
      version,
      action: "GRACE_CHANGED",
      fromGraceMinutes: register.graceMinutes,
      toGraceMinutes: input.graceMinutes,
      recalculatedCount: changes.length,
      actorRole: "TEACHER",
      actorId: input.teacherId,
      reason: input.reason,
      createdAt: now,
    },
    select: { id: true },
  });
  const recalculatedCount = await recalculateAutoStatusesInTransaction(locks, { changes, registerAuditId: audit.id, now });

  return {
    lectureId: input.lectureId,
    graceMinutes: input.graceMinutes,
    registerVersion: version,
    changed: true,
    registerCreated: created,
    recalculatedCount,
  };
}
