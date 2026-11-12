/**
 * Unified lecture attendance, Stage 5.5b: the atomic finalization
 * transaction. See docs/lecture-attendance.md ("Finalization (Stage 5.5b)").
 *
 * finalizeLectureAttendance({ teacherId, lectureId, fingerprint }) runs ONE
 * finalization transaction (runFinalizationTransaction: READ COMMITTED,
 * lock_timeout 3 s, 15 s limit, lock errors → 409 ATTENDANCE_BUSY after the
 * rollback). Nothing is written unless every check passes; any failure rolls
 * everything back (no partial finalization).
 *
 *  0. Plain reads: the lecture (ownership; 404) and the register. A register
 *     already finalized → the idempotent path (D5) without student locks.
 *     The candidate ids (the teacher's students with any enrolment row in
 *     the class, plus every record holder), sorted; more than 500 → 409
 *     FINALIZATION_ROSTER_LIMIT_EXCEEDED before any lock.
 *  1. Student FOR SHARE on every candidate, one statement, ascending id, the
 *     FIRST lock (D8). Fewer rows than ids → 409
 *     FINALIZATION_CANDIDATES_CHANGED.
 *  2. Lecture FOR SHARE + Class FOR KEY SHARE (re-checked: 404 deleted /
 *     another teacher's, 409 LECTURE_CANCELLED). Session start takes Lecture
 *     FOR NO KEY UPDATE, so no session can start until this commits.
 *  3. Register FOR UPDATE (waits for every evidence / decision / review /
 *     closure / reconciliation transaction and blocks new ones). Finalized
 *     meanwhile (a concurrent confirmation) → the idempotent path.
 *  4. The candidate ids again: any difference from the locked set → 409
 *     FINALIZATION_CANDIDATES_CHANGED (never a silently skipped student).
 *  5. Records, approval history, enrolments, visits and active sessions,
 *     read under those locks; the register view is rebuilt with the same
 *     pure helpers as getRegister (planFinalizationAbsences at the
 *     register's scheduled start, evidenceRepresentation,
 *     finalizationReadiness) and the preview computed with the Stage 5.5a
 *     buildFinalizationPreview: same summary, blockers and fingerprint.
 *  6. Blockers: readiness → 409 FINALIZATION_NOT_ALLOWED ({ reason });
 *     active session → 409 FINALIZATION_SESSION_ACTIVE (D3); pending or
 *     unknown evidence → 409 FINALIZATION_EVIDENCE_PENDING; roster → 409
 *     FINALIZATION_ROSTER_LIMIT_EXCEEDED. Pending reviews never block (D1);
 *     manual-review (UNKNOWN) students never block and never get ABSENT.
 *  7. The fingerprint must equal the client's → else 409
 *     FINALIZATION_PREVIEW_STALE. No write happens before this point.
 *  8. Writes: the register when there was none (insertRegisterIfAbsent,
 *     TEACHER; a concurrent creator → STALE), beginWrites, the ABSENT
 *     records (createFinalizationAbsences: only the plan's CREATE_ABSENT
 *     students), the register (finalizedAt, finalizedByTeacherId, version +
 *     1; schedule and grace unchanged), its FINALIZED audit (TEACHER, the
 *     plan's counts), one FINALIZE_ABSENT audit per new record (SYSTEM,
 *     version 1, linked to the FINALIZED audit). Lecture.classStatus is
 *     never touched; existing records, decisions and reviews never change.
 *
 * Idempotent duplicate (D5): a finalized register returns success from its
 * FINALIZED audit (counts) and the register, after checking they agree
 * (exactly one FINALIZED audit, its version / time / teacher equal the
 * register's, and as many FINALIZE_ABSENT audits as it counts); otherwise
 * 500 FINALIZATION_INTEGRITY_ERROR. The client's fingerprint is not used
 * there, and nothing is written.
 *
 * Output: counts and the finalization time only. Nothing is logged.
 */

import {
  classifyLecture,
  requireApprovalContext,
  requireEvidenceStartedAt,
} from "@/lib/attendance/config";
import { finalizationReadiness, planFinalizationAbsences } from "@/lib/attendance/finalization";
import {
  createFinalizationAbsences,
  FINALIZATION_MAX_STUDENTS,
  insertRegisterIfAbsent,
  lockRegisterForUpdate,
  lockRegisterKeyShared,
  lockStudentSetForFinalization,
  runFinalizationTransaction,
  type AttendanceLocks,
  type LockedRegister,
} from "@/lib/attendance/locks";
import { attendanceError } from "@/lib/attendance/service-errors";
import type { ApprovalHistoryContext } from "@/lib/student-confirmation-history";
import {
  buildFinalizationPreview,
  type FinalizationPreview,
  type FinalizationView,
} from "@/services/lecture-attendance-finalization-preview-service";
import { evidenceRepresentation, requireLectureForAttendance } from "@/services/lecture-attendance-service";

type Env = Record<string, string | undefined>;

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export type FinalizationResult = {
  lectureId: string;
  /** True when the register was already finalized (D5: nothing written by this call). */
  alreadyFinalized: boolean;
  finalizedAt: Date;
  registerVersion: number;
  /** From the FINALIZED register audit (both for a new and a repeated confirmation). */
  eligibleStudents: number;
  unknownEligibilityStudents: number;
  absentCreated: number;
  /**
   * Of this finalization (null on a repeated confirmation: these are not
   * stored by the schema, only the three counts above are).
   */
  details: {
    rosterSize: number;
    studentsWithRecord: number;
    manualReview: number;
    notEligibleWithoutRecord: number;
    /** Existing records by status before finalization (the new ABSENT records are in absentCreated). */
    recordStatusBefore: { PRESENT: number; LATE: number; ABSENT: number; EXCUSED: number };
    pendingReviews: number;
  } | null;
};

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 191) {
    throw attendanceError("VALIDATION_ERROR", { field });
  }
}

/**
 * Finalizes a lecture's attendance (see the module header). Errors: 400
 * VALIDATION_ERROR; 404 LECTURE_NOT_FOUND; 409 LECTURE_CANCELLED,
 * FINALIZATION_NOT_ALLOWED, FINALIZATION_SESSION_ACTIVE,
 * FINALIZATION_EVIDENCE_PENDING, FINALIZATION_ROSTER_LIMIT_EXCEEDED,
 * FINALIZATION_CANDIDATES_CHANGED, FINALIZATION_PREVIEW_STALE,
 * ATTENDANCE_BUSY; 500 FINALIZATION_INTEGRITY_ERROR; 503 configuration.
 */
export async function finalizeLectureAttendance(
  input: { teacherId: string; lectureId: string; fingerprint: string },
  options: { env?: Env; now?: Date } = {}
): Promise<FinalizationResult> {
  assertId(input.teacherId, "teacherId");
  assertId(input.lectureId, "lectureId");
  if (typeof input.fingerprint !== "string" || !FINGERPRINT_PATTERN.test(input.fingerprint)) {
    throw attendanceError("VALIDATION_ERROR", { field: "fingerprint" });
  }
  const env = options.env ?? process.env;
  const context = requireApprovalContext(env);
  const evidenceStartedAt = requireEvidenceStartedAt(env);

  return runFinalizationTransaction((locks) =>
    finalizeInTransaction(locks, {
      teacherId: input.teacherId,
      lectureId: input.lectureId,
      fingerprint: input.fingerprint,
      context,
      evidenceStartedAt,
      fixedNow: options.now ?? null,
    })
  );
}

type Ctx = {
  teacherId: string;
  lectureId: string;
  fingerprint: string;
  context: ApprovalHistoryContext;
  evidenceStartedAt: Date;
  fixedNow: Date | null;
};

async function readCandidateIds(locks: AttendanceLocks, lectureId: string, classId: string, teacherId: string): Promise<string[]> {
  const [enrolled, recorded] = await Promise.all([
    locks.db.classStudent.findMany({ where: { classId, student: { teacherId } }, select: { studentId: true } }),
    locks.db.lectureAttendance.findMany({ where: { lectureId }, select: { studentId: true } }),
  ]);
  return [...new Set([...enrolled.map((e) => e.studentId), ...recorded.map((r) => r.studentId)])].sort();
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

async function finalizeInTransaction(locks: AttendanceLocks, ctx: Ctx): Promise<FinalizationResult> {
  // 0. Plain reads (no lock yet).
  const owned = await locks.db.lecture.findFirst({
    where: { id: ctx.lectureId, status: 0, class: { teacherId: ctx.teacherId } },
    select: { id: true, classId: true },
  });
  if (!owned) throw attendanceError("LECTURE_NOT_FOUND");

  const current = await locks.db.lectureAttendanceRegister.findUnique({ where: { lectureId: ctx.lectureId }, select: { finalizedAt: true } });
  if (current?.finalizedAt) return alreadyFinalizedInTransaction(locks, ctx);

  const candidateIds = await readCandidateIds(locks, ctx.lectureId, owned.classId, ctx.teacherId);
  if (candidateIds.length > FINALIZATION_MAX_STUDENTS) {
    throw attendanceError("FINALIZATION_ROSTER_LIMIT_EXCEEDED", { limit: FINALIZATION_MAX_STUDENTS, rosterSize: candidateIds.length });
  }

  // 1. Every candidate Student FOR SHARE, first (D8).
  const lockedStudents = await lockStudentSetForFinalization(locks, candidateIds);
  if (!sameIds(lockedStudents.map((s) => s.id), candidateIds)) throw attendanceError("FINALIZATION_CANDIDATES_CHANGED");

  // 2. Lecture FOR SHARE + Class FOR KEY SHARE, re-checked.
  const { lecture, cls } = await requireLectureForAttendance(locks, ctx.lectureId, { teacherId: ctx.teacherId });

  // 3. Register FOR UPDATE.
  const register = await lockRegisterForUpdate(locks, ctx.lectureId);
  if (register?.finalizedAt) return alreadyFinalizedInTransaction(locks, ctx);

  // 4. The candidate set again, under the locks.
  if (!sameIds(await readCandidateIds(locks, ctx.lectureId, lecture.classId, ctx.teacherId), candidateIds)) {
    throw attendanceError("FINALIZATION_CANDIDATES_CHANGED");
  }

  // 5. Everything else, under the locks; the register view rebuilt as getRegister builds it.
  const now = ctx.fixedNow ?? new Date();
  const students = lockedStudents.filter((s) => s.teacherId === ctx.teacherId);
  const studentIds = students.map((s) => s.id);
  const [records, enrolments, history, visits, activeSessions] = await Promise.all([
    locks.db.lectureAttendance.findMany({ where: { lectureId: ctx.lectureId }, orderBy: { studentId: "asc" } }),
    locks.db.classStudent.findMany({
      where: { classId: lecture.classId, student: { teacherId: ctx.teacherId } },
      select: { id: true, classId: true, studentId: true, assignedAt: true, removedAt: true, isActive: true },
    }),
    studentIds.length
      ? locks.db.studentConfirmationHistory.findMany({
          where: { studentId: { in: studentIds } },
          select: { id: true, studentId: true, fromStatus: true, toStatus: true, decidedAt: true, previousConfirmedAt: true },
        })
      : Promise.resolve([]),
    studentIds.length
      ? locks.db.attendance.findMany({
          where: { classSession: { lectureId: ctx.lectureId }, studentId: { in: studentIds } },
          select: { studentId: true, joinedAt: true },
        })
      : Promise.resolve([]),
    locks.db.classSession.findMany({ where: { lectureId: ctx.lectureId, isActive: true }, select: { id: true } }),
  ]);

  const schedule = register
    ? { scheduledStartAt: register.scheduledStartAt, scheduledEndAt: register.scheduledEndAt, graceMinutes: register.graceMinutes }
    : { scheduledStartAt: lecture.date, scheduledEndAt: lecture.endDate, graceMinutes: cls.attendanceGraceMinutes };
  const classification = classifyLecture(schedule.scheduledStartAt, ctx.evidenceStartedAt);
  const historyBy = groupBy(history, (h) => h.studentId);
  const enrolmentsBy = groupBy(enrolments, (e) => e.studentId);
  const visitsBy = groupBy(visits, (v) => v.studentId);
  const recordBy = new Map(records.map((r) => [r.studentId, r]));

  const plan = planFinalizationAbsences({
    register: { ...schedule, finalizedAt: null },
    classId: lecture.classId,
    context: ctx.context,
    candidates: students.map((s) => ({
      studentId: s.id,
      student: s,
      history: historyBy.get(s.id) ?? [],
      enrolments: enrolmentsBy.get(s.id) ?? [],
      hasRecord: recordBy.has(s.id),
    })),
  });
  const planBy = new Map(plan.roster.map((entry) => [entry.studentId, entry]));

  const onlineEvidence = evidenceRepresentation({
    classification,
    classId: lecture.classId,
    context: ctx.context,
    students: students.map((s) => {
      const record = recordBy.get(s.id);
      return {
        studentId: s.id,
        student: s,
        history: historyBy.get(s.id) ?? [],
        enrolments: enrolmentsBy.get(s.id) ?? [],
        record: record ? { statusSource: record.statusSource, firstOnlineAt: record.firstOnlineAt } : null,
        visitTimes: (visitsBy.get(s.id) ?? []).map((v) => v.joinedAt),
      };
    }),
  });

  const view: FinalizationView = {
    lecture: { id: lecture.id, classStatus: lecture.classStatus, date: lecture.date, endDate: lecture.endDate },
    register: {
      exists: register !== null,
      version: register?.version ?? 0,
      ...schedule,
      finalizedAt: null,
    },
    classification,
    roster: students.map((s) => {
      const entry = planBy.get(s.id)!;
      return {
        studentId: s.id,
        hasRecord: recordBy.has(s.id),
        eligibility: {
          outcome: entry.eligibility.outcome,
          reason: entry.eligibility.reason,
          approvalReason: entry.eligibility.approval?.reason ?? null,
        },
        absenceDecision: entry.decision,
      };
    }),
    records: records.map((r) => ({ id: r.id, studentId: r.studentId, status: r.status, statusSource: r.statusSource, version: r.version })),
    reviewQueue: records.filter((r) => r.pendingReviewSince !== null),
    onlineEvidence,
    activeSessions,
    finalization: { readiness: finalizationReadiness({ register: { ...schedule, finalizedAt: null }, lectureStatus: lecture.classStatus, now }) },
  };
  const preview = buildFinalizationPreview(view);

  // 6. Blockers, then 7. the fingerprint. No write before this point.
  throwForBlockers(preview);
  if (preview.fingerprint !== ctx.fingerprint) throw attendanceError("FINALIZATION_PREVIEW_STALE");

  // 8. Writes.
  let target: Pick<LockedRegister, "version">;
  if (register) {
    target = register;
  } else {
    const inserted = await insertRegisterIfAbsent(locks, {
      lectureId: ctx.lectureId,
      classId: lecture.classId,
      scheduledStartAt: schedule.scheduledStartAt,
      scheduledEndAt: schedule.scheduledEndAt,
      graceMinutes: schedule.graceMinutes,
      now,
      actor: { role: "TEACHER", teacherId: ctx.teacherId },
    });
    if (!inserted) {
      // Another transaction created it meanwhile (our insert waited for it):
      // a concurrent confirmation that finalized it (D5: the idempotent
      // result), or anything else (what we planned is stale).
      const created = await lockRegisterForUpdate(locks, ctx.lectureId);
      if (created?.finalizedAt) return alreadyFinalizedInTransaction(locks, ctx);
      throw attendanceError("FINALIZATION_PREVIEW_STALE");
    }
    target = { version: 1 };
  }

  locks.beginWrites();

  const absentIds = plan.absentStudentIds.filter((id) => !recordBy.has(id)).sort();
  if (absentIds.length !== plan.absentCreatedCount) throw new Error("Finalization: the ABSENT plan includes a student with a record.");
  const created = absentIds.length
    ? await createFinalizationAbsences(locks, { lectureId: ctx.lectureId, classId: lecture.classId, studentIds: absentIds, now })
    : [];

  const finalVersion = target.version + 1;
  await locks.db.lectureAttendanceRegister.update({
    where: { lectureId: ctx.lectureId, version: target.version },
    data: { finalizedAt: now, finalizedByTeacherId: ctx.teacherId, version: finalVersion, updatedAt: now },
  });

  const registerAudit = await locks.db.lectureAttendanceRegisterAuditLog.create({
    data: {
      lectureId: ctx.lectureId,
      version: finalVersion,
      action: "FINALIZED",
      finalizedAt: now,
      eligibleCount: plan.eligibleCount,
      unknownEligibilityCount: plan.unknownEligibilityCount,
      absentCreatedCount: created.length,
      actorRole: "TEACHER",
      actorId: ctx.teacherId,
      createdAt: now,
    },
    select: { id: true },
  });

  if (created.length) {
    const audits = await locks.db.attendanceAuditLog.createMany({
      data: created.map((row) => ({
        lectureAttendanceId: row.id,
        version: 1,
        lectureId: ctx.lectureId,
        studentId: row.studentId,
        action: "FINALIZE_ABSENT" as const,
        fromStatus: null,
        toStatus: "ABSENT" as const,
        fromTeacherStatus: null,
        toTeacherStatus: null,
        fromAutoStatus: null,
        toAutoStatus: null,
        actorRole: "SYSTEM",
        actorId: null,
        reason: null,
        afterFinalization: false,
        registerAuditId: registerAudit.id,
        createdAt: now,
      })),
    });
    if (audits.count !== created.length) throw new Error(`Finalization: ${audits.count} of ${created.length} ABSENT audits were created.`);
  }

  return {
    lectureId: ctx.lectureId,
    alreadyFinalized: false,
    finalizedAt: now,
    registerVersion: finalVersion,
    eligibleStudents: plan.eligibleCount,
    unknownEligibilityStudents: plan.unknownEligibilityCount,
    absentCreated: created.length,
    details: {
      rosterSize: preview.summary.rosterSize,
      studentsWithRecord: preview.summary.studentsWithRecord,
      manualReview: preview.summary.manualReview,
      notEligibleWithoutRecord: preview.summary.notEligibleWithoutRecord,
      recordStatusBefore: preview.summary.recordStatus,
      pendingReviews: preview.evidence.pendingReviews,
    },
  };
}

function throwForBlockers(preview: FinalizationPreview) {
  const { schedule, blockers } = preview.readiness;
  if (!schedule.allowed) throw attendanceError("FINALIZATION_NOT_ALLOWED", { reason: schedule.reason });
  if (blockers.includes("SESSION_ACTIVE")) throw attendanceError("FINALIZATION_SESSION_ACTIVE");
  if (blockers.includes("ROSTER_LIMIT_EXCEEDED")) {
    throw attendanceError("FINALIZATION_ROSTER_LIMIT_EXCEEDED", { limit: FINALIZATION_MAX_STUDENTS, rosterSize: preview.summary.rosterSize });
  }
  if (blockers.includes("EVIDENCE_PENDING") || blockers.includes("UNKNOWN_EVIDENCE")) {
    throw attendanceError("FINALIZATION_EVIDENCE_PENDING", {
      pendingOnlineEvidence: preview.evidence.pendingOnlineEvidence,
      unknownApprovalEvidence: preview.evidence.unknownApprovalEvidence,
    });
  }
  // Any other blocker would be a new one this function does not know: refuse.
  if (blockers.length > 0) throw attendanceError("FINALIZATION_NOT_ALLOWED", { reason: blockers[0] });
}

/** D5: the stored result of an earlier finalization, after an integrity check. No write. */
async function alreadyFinalizedInTransaction(locks: AttendanceLocks, ctx: Ctx): Promise<FinalizationResult> {
  await requireLectureForAttendance(locks, ctx.lectureId, { teacherId: ctx.teacherId });
  const register = await lockRegisterKeyShared(locks, ctx.lectureId);
  if (!register?.finalizedAt || !register.finalizedByTeacherId) throw attendanceError("FINALIZATION_INTEGRITY_ERROR");

  const audits = await locks.db.lectureAttendanceRegisterAuditLog.findMany({
    where: { lectureId: ctx.lectureId, action: "FINALIZED" },
    select: { version: true, finalizedAt: true, actorId: true, eligibleCount: true, unknownEligibilityCount: true, absentCreatedCount: true },
  });
  const audit = audits.length === 1 ? audits[0] : null;
  if (
    !audit ||
    audit.version !== register.version ||
    audit.finalizedAt?.getTime() !== register.finalizedAt.getTime() ||
    audit.actorId !== register.finalizedByTeacherId ||
    audit.eligibleCount === null ||
    audit.unknownEligibilityCount === null ||
    audit.absentCreatedCount === null
  ) {
    throw attendanceError("FINALIZATION_INTEGRITY_ERROR");
  }
  const absentAudits = await locks.db.attendanceAuditLog.count({ where: { lectureId: ctx.lectureId, action: "FINALIZE_ABSENT" } });
  if (absentAudits !== audit.absentCreatedCount) throw attendanceError("FINALIZATION_INTEGRITY_ERROR");

  return {
    lectureId: ctx.lectureId,
    alreadyFinalized: true,
    finalizedAt: register.finalizedAt,
    registerVersion: register.version,
    eligibleStudents: audit.eligibleCount,
    unknownEligibilityStudents: audit.unknownEligibilityCount,
    absentCreated: audit.absentCreatedCount,
    details: null,
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}
