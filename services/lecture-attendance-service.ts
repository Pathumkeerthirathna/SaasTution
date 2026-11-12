/**
 * Unified lecture attendance: core services (Stage 5.4).
 * See docs/lecture-attendance.md.
 *
 * Stage 5.4a: register initialization (ensureRegister, inside a locked
 * attendance transaction) and the read-only register view (getRegister).
 * Stage 5.4b: lecture revalidation under the lock for every write
 * (inspect/requireLectureForAttendance). Evidence processing and review
 * actions are in services/lecture-attendance-evidence-service.ts.
 *
 * getRegister never writes: with no register row it returns a COMPUTED
 * register (the lecture's schedule and the class's grace, version 0). The
 * register row is created only by a write that needs it, through
 * ensureRegister.
 *
 * Configuration (lib/attendance/config.ts) degrades the view instead of
 * failing it:
 *  - APPROVAL_FEATURE_STARTED_AT unavailable: roster eligibility, the ABSENT
 *    preview and the online-evidence check are null ("unavailable"); nothing
 *    is guessed;
 *  - ATTENDANCE_EVIDENCE_STARTED_AT unavailable: the LIVE / HISTORICAL
 *    classification and the online-evidence check are null.
 * The response reports each setting as OK / MISSING / INVALID, never a value.
 *
 * Clock: the application clock (new Date()), the same clock as visits and
 * student decisions. Client times are never used.
 */

import { attendanceEligibilityAt, type AttendanceEligibility } from "@/lib/attendance/eligibility";
import type { EnrolmentRow } from "@/lib/attendance/enrolment";
import {
  finalizationReadiness,
  planFinalizationAbsences,
  type AbsenceDecision,
  type FinalizationReadiness,
  type LectureClassStatus,
} from "@/lib/attendance/finalization";
import { autoStatusFor, isValidGraceMinutes } from "@/lib/attendance/status";
import {
  attendanceConfigurationStatus,
  classifyLecture,
  loadApprovalConfig,
  loadEvidenceConfig,
  type AttendanceConfigurationStatus,
  type LectureClassification,
} from "@/lib/attendance/config";
import {
  insertRegisterIfAbsent,
  lockClassKeyShared,
  lockRecords,
  lockLectureShared,
  lockRegisterForUpdate,
  lockRegisterKeyShared,
  type AttendanceLocks,
  type LockedClass,
  type LockedLecture,
  type LockedRecord,
  type LockedRegister,
} from "@/lib/attendance/locks";
import { attendanceError } from "@/lib/attendance/service-errors";
import { prisma } from "@/lib/prisma";
import type {
  ApprovalHistoryContext,
  ApprovalHistoryEntry,
  ConfirmationStatus,
} from "@/lib/student-confirmation-history";

type Env = Record<string, string | undefined>;

export type AttendanceActor = { role: "SYSTEM" } | { role: "TEACHER"; teacherId: string };

// ---- Lecture revalidation under the lock (every write) --------------------------------

export type LectureForAttendance =
  | { state: "OK"; lecture: LockedLecture; cls: LockedClass }
  | { state: "DELETED" | "CANCELLED"; lecture: LockedLecture; cls: LockedClass }
  | { state: "NOT_FOUND"; lecture: null; cls: null };

/**
 * Locks the Lecture FOR SHARE and its Class FOR KEY SHARE and reports what
 * the LOCKED rows say. FOR SHARE conflicts with the FOR NO KEY UPDATE that
 * cancelling, deleting or editing a lecture takes, so the state cannot change
 * until this transaction ends: an earlier, unlocked read is never trusted for
 * a write. Re-entrant when the caller already holds these locks.
 */
export async function inspectLectureForAttendance(locks: AttendanceLocks, lectureId: string): Promise<LectureForAttendance> {
  const lecture = await lockLectureShared(locks, lectureId);
  if (!lecture) return { state: "NOT_FOUND", lecture: null, cls: null };

  const cls = await lockClassKeyShared(locks, lecture.classId);
  if (!cls) return { state: "NOT_FOUND", lecture: null, cls: null };

  if (lecture.status !== 0) return { state: "DELETED", lecture, cls };
  if (lecture.classStatus === "CANCELLED") return { state: "CANCELLED", lecture, cls };
  return { state: "OK", lecture, cls };
}

/**
 * inspectLectureForAttendance for a write that needs a usable lecture:
 * 404 LECTURE_NOT_FOUND when it is missing, soft-deleted or (with
 * `teacherId`) belongs to another teacher's class; 409 LECTURE_CANCELLED when
 * it is cancelled.
 */
export async function requireLectureForAttendance(
  locks: AttendanceLocks,
  lectureId: string,
  options: { teacherId?: string } = {}
): Promise<{ lecture: LockedLecture; cls: LockedClass }> {
  const found = await inspectLectureForAttendance(locks, lectureId);
  if (found.state === "NOT_FOUND" || found.state === "DELETED") throw attendanceError("LECTURE_NOT_FOUND");
  if (options.teacherId !== undefined && found.cls.teacherId !== options.teacherId) {
    throw attendanceError("LECTURE_NOT_FOUND");
  }
  if (found.state === "CANCELLED") throw attendanceError("LECTURE_CANCELLED");
  return { lecture: found.lecture, cls: found.cls };
}

// ---- Register initialization ---------------------------------------------------------

export type EnsuredRegister = { register: LockedRegister; created: boolean; lecture: LockedLecture; cls: LockedClass };

/**
 * The lecture's register, locked in `mode`, created first when there is none.
 * Must run inside runAttendanceTransaction.
 *
 *  1. ALWAYS (fast path included) the Lecture FOR SHARE and the Class FOR KEY
 *     SHARE, re-checked under the lock: 404 when missing, soft-deleted or
 *     (with `teacherId`) not this teacher's; 409 LECTURE_CANCELLED when
 *     cancelled. FOR SHARE also stops a date edit from committing between
 *     the schedule read and the insert;
 *  2. the register FOR `mode`; when there is none: insertRegisterIfAbsent
 *     (version 1, the lecture's start / end, the class's grace, and its
 *     CREATED audit in the same transaction), then the register FOR `mode`.
 * A concurrent creator waits on the unique key, inserts nothing, and locks
 * the committed row: exactly one register and one CREATED audit.
 */
export async function ensureRegister(
  locks: AttendanceLocks,
  lectureId: string,
  options: { mode: "KEY_SHARE" | "UPDATE"; now: Date; actor: AttendanceActor; teacherId?: string }
): Promise<EnsuredRegister> {
  const { mode, now, actor } = options;

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError("Attendance: a valid server time is required.");
  }

  const { lecture, cls } = await requireLectureForAttendance(locks, lectureId, { teacherId: options.teacherId });

  const lockRegister = mode === "UPDATE" ? lockRegisterForUpdate : lockRegisterKeyShared;
  const existing = await lockRegister(locks, lectureId);
  if (existing) return { register: existing, created: false, lecture, cls };

  // Guaranteed by the database (CHECK constraints); checked again so a bad
  // copy can never be written.
  if (!isValidGraceMinutes(cls.attendanceGraceMinutes)) {
    throw new Error("Attendance: the class grace period is out of range.");
  }
  if (lecture.endDate && lecture.endDate.getTime() <= lecture.date.getTime()) {
    throw new Error("Attendance: the lecture ends before it starts.");
  }

  const inserted = await insertRegisterIfAbsent(locks, {
    lectureId,
    classId: lecture.classId,
    scheduledStartAt: lecture.date,
    scheduledEndAt: lecture.endDate,
    graceMinutes: cls.attendanceGraceMinutes,
    now,
    actor,
  });

  const register = await lockRegister(locks, lectureId);
  if (!register) throw new Error("Attendance: the register is missing after its creation.");

  return { register, created: inserted, lecture, cls };
}

// ---- Online evidence representation (pure) ------------------------------------------

export type RepresentationStudent = {
  studentId: string;
  student: { confirmationStatus: ConfirmationStatus; confirmedAt: Date | null; approvedAt: Date | null; status: number };
  history: readonly ApprovalHistoryEntry[];
  enrolments: readonly EnrolmentRow[];
  record: { statusSource: "AUTO" | "TEACHER" | "FINALIZATION" | "BACKFILL"; firstOnlineAt: Date | null } | null;
  /** This student's visits to the lecture's sessions (Attendance.joinedAt), any order. */
  visitTimes: readonly Date[];
};

export type EvidenceRepresentation = {
  /** An eligible visit that the canonical record does not represent (blocks finalization). */
  pending: { studentId: string; earliestEligibleVisitAt: Date }[];
  /** No record, and a visit whose eligibility was UNKNOWN at its join time (blocks finalization; teacher review). */
  unknownVisits: { studentId: string; earliestUnknownVisitAt: Date }[];
};

/**
 * Whether each student's online visits are represented in canonical
 * attendance (approved D2 rule and the UNKNOWN-visit refinement):
 *  - V = the earliest visit eligible at its own join time;
 *  - LIVE: represented when a record exists and record.firstOnlineAt <= V;
 *  - HISTORICAL: represented when a record exists and its source is TEACHER
 *    or BACKFILL, or record.firstOnlineAt <= V;
 *  - no record and a visit UNKNOWN at its join time: reported for review.
 * Visits NOT_ELIGIBLE at their join time are not evidence and are ignored.
 */
export function evidenceRepresentation(input: {
  classification: LectureClassification;
  classId: string;
  context: ApprovalHistoryContext;
  students: readonly RepresentationStudent[];
}): EvidenceRepresentation {
  const pending: EvidenceRepresentation["pending"] = [];
  const unknownVisits: EvidenceRepresentation["unknownVisits"] = [];

  for (const s of input.students) {
    const visits = [...s.visitTimes].sort((a, b) => a.getTime() - b.getTime());
    let eligibleAt: Date | null = null;
    let unknownAt: Date | null = null;

    for (const joinedAt of visits) {
      const outcome = attendanceEligibilityAt({
        student: s.student,
        history: s.history,
        enrolments: s.enrolments,
        classId: input.classId,
        instant: joinedAt,
        context: input.context,
      }).outcome;

      if (outcome === "ELIGIBLE" && eligibleAt === null) eligibleAt = joinedAt;
      if (outcome === "UNKNOWN" && unknownAt === null) unknownAt = joinedAt;
    }

    if (eligibleAt !== null) {
      const record = s.record;
      const covers = record?.firstOnlineAt != null && record.firstOnlineAt.getTime() <= eligibleAt.getTime();
      const represented =
        record !== null &&
        (covers ||
          (input.classification === "HISTORICAL" && (record.statusSource === "TEACHER" || record.statusSource === "BACKFILL")));

      if (!represented) pending.push({ studentId: s.studentId, earliestEligibleVisitAt: eligibleAt });
    }

    if (s.record === null && unknownAt !== null) {
      unknownVisits.push({ studentId: s.studentId, earliestUnknownVisitAt: unknownAt });
    }
  }

  return { pending, unknownVisits };
}

// ---- Read-only register view ---------------------------------------------------------

export type RegisterView = {
  configuration: AttendanceConfigurationStatus;
  lecture: {
    id: string;
    title: string;
    classId: string;
    date: Date;
    endDate: Date | null;
    classStatus: LectureClassStatus;
  };
  register: {
    /** False: computed from the lecture and the class; nothing is stored yet. */
    exists: boolean;
    scheduledStartAt: Date;
    scheduledEndAt: Date | null;
    graceMinutes: number;
    finalizedAt: Date | null;
    finalizedByTeacherId: string | null;
    /** 0 for a computed register. */
    version: number;
  };
  /** Null when ATTENDANCE_EVIDENCE_STARTED_AT is unavailable. */
  classification: LectureClassification | null;
  roster: {
    studentId: string;
    name: string;
    registrationNumber: string | null;
    hasRecord: boolean;
    /** At the scheduled start; null when APPROVAL_FEATURE_STARTED_AT is unavailable. */
    eligibility: { outcome: AttendanceEligibility["outcome"]; reason: AttendanceEligibility["reason"]; approvalReason: string | null } | null;
    /** What finalization would do now; null when unavailable or the register is finalized. */
    absenceDecision: AbsenceDecision | null;
  }[];
  records: {
    id: string;
    studentId: string;
    status: string;
    statusSource: string;
    autoStatus: string | null;
    teacherStatus: string | null;
    firstOnlineAt: Date | null;
    firstQrAt: Date | null;
    teacherDecidedAt: Date | null;
    pendingReviewSince: Date | null;
    version: number;
  }[];
  /** Records with evidence waiting for the teacher, oldest first. */
  reviewQueue: { studentId: string; pendingReviewSince: Date }[];
  /**
   * What finalization would mark ABSENT now (informational: confirming also
   * needs the online-evidence check). Null when APPROVAL_FEATURE_STARTED_AT is
   * unavailable or the register is finalized.
   */
  absencePreview: {
    absentStudentIds: string[];
    manualReviewStudentIds: string[];
    eligibleCount: number;
    unknownEligibilityCount: number;
    absentCreatedCount: number;
  } | null;
  /** Null when either setting is unavailable. */
  onlineEvidence: EvidenceRepresentation | null;
  activeSessions: { id: string; startedAt: Date }[];
  finalization: {
    readiness: FinalizationReadiness;
    /** Finalization needs both settings. */
    configured: boolean;
  };
};

/**
 * The teacher's attendance register for a lecture. Read only: no
 * transaction, no locks, no writes, whatever the configuration. 404
 * LECTURE_NOT_FOUND unless the lecture exists (status 0) and belongs to one
 * of the teacher's classes.
 *
 * Candidates: every student of this teacher with ANY enrolment row in the
 * class (removed ones included), plus every student with a record.
 */
export async function getRegister(
  teacherId: string,
  lectureId: string,
  options: { now?: Date; env?: Env } = {}
): Promise<RegisterView> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;

  const lecture = await prisma.lecture.findFirst({
    where: { id: lectureId, status: 0, class: { teacherId } },
    select: {
      id: true,
      title: true,
      classId: true,
      date: true,
      endDate: true,
      classStatus: true,
      class: { select: { attendanceGraceMinutes: true } },
    },
  });

  if (!lecture) throw attendanceError("LECTURE_NOT_FOUND");

  const [register, records, activeSessions, enrolments] = await Promise.all([
    prisma.lectureAttendanceRegister.findUnique({ where: { lectureId } }),
    prisma.lectureAttendance.findMany({ where: { lectureId }, orderBy: { studentId: "asc" } }),
    prisma.classSession.findMany({
      where: { lectureId, isActive: true },
      select: { id: true, startedAt: true },
      orderBy: { startedAt: "asc" },
    }),
    prisma.classStudent.findMany({
      where: { classId: lecture.classId, student: { teacherId } },
      select: { id: true, classId: true, studentId: true, assignedAt: true, removedAt: true, isActive: true },
    }),
  ]);

  const candidateIds = [...new Set([...enrolments.map((e) => e.studentId), ...records.map((r) => r.studentId)])].sort();

  const students = candidateIds.length
    ? await prisma.student.findMany({
        where: { id: { in: candidateIds }, teacherId },
        select: {
          id: true,
          name: true,
          registrationNumber: true,
          status: true,
          confirmationStatus: true,
          confirmedAt: true,
          approvedAt: true,
        },
      })
    : [];

  const approval = loadApprovalConfig(env);
  const evidence = loadEvidenceConfig(env);

  const schedule = register
    ? { scheduledStartAt: register.scheduledStartAt, scheduledEndAt: register.scheduledEndAt, graceMinutes: register.graceMinutes }
    : { scheduledStartAt: lecture.date, scheduledEndAt: lecture.endDate, graceMinutes: lecture.class.attendanceGraceMinutes };
  const finalizedAt = register?.finalizedAt ?? null;

  const classification = evidence.status === "OK" ? classifyLecture(schedule.scheduledStartAt, evidence.evidenceStartedAt) : null;

  const studentIds = students.map((s) => s.id);
  const recordByStudent = new Map(records.map((r) => [r.studentId, r]));

  // Approval history and visits are only needed (and only read) when the
  // settings that use them are available.
  const history =
    approval.status === "OK" && studentIds.length
      ? await prisma.studentConfirmationHistory.findMany({
          where: { studentId: { in: studentIds } },
          select: { id: true, studentId: true, fromStatus: true, toStatus: true, decidedAt: true, previousConfirmedAt: true },
        })
      : [];

  const visits =
    approval.status === "OK" && classification !== null && studentIds.length
      ? await prisma.attendance.findMany({
          where: { classSession: { lectureId }, studentId: { in: studentIds } },
          select: { studentId: true, joinedAt: true },
        })
      : [];

  const historyBy = groupBy(history, (h) => h.studentId);
  const enrolmentsBy = groupBy(enrolments, (e) => e.studentId);
  const visitsBy = groupBy(visits, (v) => v.studentId);

  const plan =
    approval.status === "OK"
      ? planFinalizationAbsences({
          register: { ...schedule, finalizedAt },
          classId: lecture.classId,
          context: approval.context,
          candidates: students.map((s) => ({
            studentId: s.id,
            student: s,
            history: historyBy.get(s.id) ?? [],
            enrolments: enrolmentsBy.get(s.id) ?? [],
            hasRecord: recordByStudent.has(s.id),
          })),
        })
      : null;
  const planBy = new Map(plan?.roster.map((entry) => [entry.studentId, entry]) ?? []);

  const onlineEvidence =
    approval.status === "OK" && classification !== null
      ? evidenceRepresentation({
          classification,
          classId: lecture.classId,
          context: approval.context,
          students: students.map((s) => {
            const record = recordByStudent.get(s.id);
            return {
              studentId: s.id,
              student: s,
              history: historyBy.get(s.id) ?? [],
              enrolments: enrolmentsBy.get(s.id) ?? [],
              record: record ? { statusSource: record.statusSource, firstOnlineAt: record.firstOnlineAt } : null,
              visitTimes: (visitsBy.get(s.id) ?? []).map((v) => v.joinedAt),
            };
          }),
        })
      : null;

  const roster = [...students]
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((s) => {
      const entry = planBy.get(s.id);
      return {
        studentId: s.id,
        name: s.name,
        registrationNumber: s.registrationNumber,
        hasRecord: recordByStudent.has(s.id),
        eligibility: entry
          ? {
              outcome: entry.eligibility.outcome,
              reason: entry.eligibility.reason,
              approvalReason: entry.eligibility.approval?.reason ?? null,
            }
          : null,
        absenceDecision: entry && finalizedAt === null ? entry.decision : null,
      };
    });

  return {
    configuration: attendanceConfigurationStatus(env),
    lecture: {
      id: lecture.id,
      title: lecture.title,
      classId: lecture.classId,
      date: lecture.date,
      endDate: lecture.endDate,
      classStatus: lecture.classStatus,
    },
    register: {
      exists: register !== null,
      ...schedule,
      finalizedAt,
      finalizedByTeacherId: register?.finalizedByTeacherId ?? null,
      version: register?.version ?? 0,
    },
    classification,
    roster,
    records: records.map((r) => ({
      id: r.id,
      studentId: r.studentId,
      status: r.status,
      statusSource: r.statusSource,
      autoStatus: r.autoStatus,
      teacherStatus: r.teacherStatus,
      firstOnlineAt: r.firstOnlineAt,
      firstQrAt: r.firstQrAt,
      teacherDecidedAt: r.teacherDecidedAt,
      pendingReviewSince: r.pendingReviewSince,
      version: r.version,
    })),
    reviewQueue: records
      .filter((r): r is typeof r & { pendingReviewSince: Date } => r.pendingReviewSince !== null)
      .sort((a, b) => a.pendingReviewSince.getTime() - b.pendingReviewSince.getTime())
      .map((r) => ({ studentId: r.studentId, pendingReviewSince: r.pendingReviewSince })),
    absencePreview:
      plan && finalizedAt === null
        ? {
            absentStudentIds: plan.absentStudentIds,
            manualReviewStudentIds: plan.manualReviewStudentIds,
            eligibleCount: plan.eligibleCount,
            unknownEligibilityCount: plan.unknownEligibilityCount,
            absentCreatedCount: plan.absentCreatedCount,
          }
        : null,
    onlineEvidence,
    activeSessions,
    finalization: {
      readiness: finalizationReadiness({
        register: { ...schedule, finalizedAt },
        lectureStatus: lecture.classStatus,
        now,
      }),
      configured: approval.status === "OK" && evidence.status === "OK",
    },
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

// ---- Schedule synchronization (Stage 5.4e) --------------------------------------------
//
// A lecture schedule edit (services/lecture-service.ts) runs in one attendance
// transaction: the Lecture FOR NO KEY UPDATE, then prepareRegisterScheduleSync
// (the register FOR UPDATE and, when the start moves, the records with
// evidence), then the write phase: the Lecture update and
// applyRegisterScheduleSync. Only an existing OPEN register follows the
// lecture; a finalized register keeps its frozen schedule; no register is
// ever created by an edit; the register's grace is never changed.

export type ScheduleSyncPlan =
  | { kind: "NO_REGISTER" }
  | { kind: "FINALIZED" }
  | { kind: "UNCHANGED" }
  | {
      kind: "SYNC";
      register: LockedRegister;
      start: Date;
      end: Date | null;
      /** The records whose evidence status must be re-derived (start moved; otherwise empty). */
      records: LockedRecord[];
    };

const sameInstant = (a: Date | null, b: Date | null) => (a === null || b === null ? a === b : a.getTime() === b.getTime());

/**
 * Lock phase of a schedule sync. The caller holds the Lecture FOR NO KEY
 * UPDATE. Locks the register FOR UPDATE (waits for every evidence, decision
 * or closure transaction holding it, and blocks new ones until commit); when
 * it is open and the start changes, also locks every record with evidence, in
 * studentId order (found by a read made under the register lock, so no new
 * record or evidence can appear).
 */
export async function prepareRegisterScheduleSync(
  locks: AttendanceLocks,
  input: { lectureId: string; start: Date; end: Date | null }
): Promise<ScheduleSyncPlan> {
  const register = await lockRegisterForUpdate(locks, input.lectureId);
  if (!register) return { kind: "NO_REGISTER" };
  if (register.finalizedAt !== null) return { kind: "FINALIZED" };

  const startChanged = !sameInstant(register.scheduledStartAt, input.start);
  const endChanged = !sameInstant(register.scheduledEndAt, input.end);
  if (!startChanged && !endChanged) return { kind: "UNCHANGED" };

  const records: LockedRecord[] = startChanged ? await lockRecordsWithEvidence(locks, input.lectureId) : [];

  return { kind: "SYNC", register, start: input.start, end: input.end, records };
}

/**
 * Lock phase, shared by schedule sync and grace changes (Stage 5.7b-2b-2):
 * every record of the lecture with evidence (a first online or QR time),
 * FOR NO KEY UPDATE in ascending studentId. The caller must hold the register
 * FOR UPDATE, so the read cannot miss a record or evidence written meanwhile.
 */
export async function lockRecordsWithEvidence(locks: AttendanceLocks, lectureId: string): Promise<LockedRecord[]> {
  const withEvidence = await locks.db.lectureAttendance.findMany({
    where: { lectureId, OR: [{ firstOnlineAt: { not: null } }, { firstQrAt: { not: null } }] },
    select: { studentId: true },
  });
  return (await lockRecords(locks, lectureId, withEvidence.map((r) => r.studentId))).filter(
    (r) => r.firstOnlineAt !== null || r.firstQrAt !== null
  );
}

/**
 * Write phase of a schedule sync (after locks.beginWrites()): the register's
 * new start / end (grace unchanged), version + 1, its SCHEDULE_SYNCED audit
 * (actor: the editing teacher; before / after; recalculatedCount), then the
 * recalculated records with their AUTO_RECALCULATED audits linked to it.
 * Nothing for NO_REGISTER, FINALIZED or UNCHANGED.
 */
export async function applyRegisterScheduleSync(
  locks: AttendanceLocks,
  plan: ScheduleSyncPlan,
  input: { actor: AttendanceActor; now: Date }
): Promise<{ synced: boolean; recalculatedCount: number }> {
  if (plan.kind !== "SYNC") return { synced: false, recalculatedCount: 0 };
  if (!locks.writing) throw new Error("Attendance: applyRegisterScheduleSync runs in the write phase.");

  const { register, start, end, records } = plan;
  const version = register.version + 1;
  const changes = planAutoStatusRecalculation(records, { scheduledStartAt: start, graceMinutes: register.graceMinutes });

  await locks.db.lectureAttendanceRegister.update({
    where: { lectureId: register.lectureId, version: register.version },
    data: { scheduledStartAt: start, scheduledEndAt: end, version, updatedAt: input.now },
  });

  const audit = await locks.db.lectureAttendanceRegisterAuditLog.create({
    data: {
      lectureId: register.lectureId,
      version,
      action: "SCHEDULE_SYNCED",
      fromScheduledStartAt: register.scheduledStartAt,
      toScheduledStartAt: start,
      fromScheduledEndAt: register.scheduledEndAt,
      toScheduledEndAt: end,
      recalculatedCount: changes.length,
      actorRole: input.actor.role,
      actorId: input.actor.role === "TEACHER" ? input.actor.teacherId : null,
      createdAt: input.now,
    },
    select: { id: true },
  });

  await recalculateAutoStatusesInTransaction(locks, { changes, registerAuditId: audit.id, now: input.now });
  return { synced: true, recalculatedCount: changes.length };
}

// ---- Recalculation of evidence statuses (schedule sync; grace changes: lecture-attendance-grace-service.ts) ------

export type AutoStatusChange = {
  record: LockedRecord;
  /** The evidence status under the new schedule / grace. */
  autoStatus: "PRESENT" | "LATE";
  /** The effective status after the change (only AUTO records follow the evidence). */
  status: LockedRecord["status"];
};

/**
 * Pure: which records change when their stored evidence (first online / QR
 * times) is judged against `schedule` (start and grace). Only records whose
 * evidence status changes are returned:
 *  - AUTO: the status follows the new evidence status;
 *  - TEACHER, BACKFILL (and FINALIZATION): the status and any teacher
 *    decision stay; only the evidence status changes.
 * Pending reviews are left as they are; no review is raised (reviews come
 * only from new evidence).
 */
export function planAutoStatusRecalculation(
  records: readonly LockedRecord[],
  schedule: { scheduledStartAt: Date; graceMinutes: number }
): AutoStatusChange[] {
  const changes: AutoStatusChange[] = [];
  for (const record of records) {
    const autoStatus = autoStatusFor({ firstOnlineAt: record.firstOnlineAt, firstQrAt: record.firstQrAt }, schedule);
    if (autoStatus === null || autoStatus === record.autoStatus) continue;
    changes.push({ record, autoStatus, status: record.statusSource === "AUTO" ? autoStatus : record.status });
  }
  return changes;
}

/**
 * Write phase: applies planned changes to records the transaction holds
 * (version-conditional, version + 1) and writes one AUTO_RECALCULATED audit
 * per record (actor SYSTEM, linked to the register audit that caused it).
 * Returns how many records changed.
 */
export async function recalculateAutoStatusesInTransaction(
  locks: AttendanceLocks,
  input: { changes: readonly AutoStatusChange[]; registerAuditId: string; now: Date }
): Promise<number> {
  if (!locks.writing) throw new Error("Attendance: recalculateAutoStatusesInTransaction runs in the write phase.");

  for (const { record, autoStatus, status } of input.changes) {
    const version = record.version + 1;
    await locks.db.lectureAttendance.update({
      where: { id: record.id, version: record.version },
      data: { autoStatus, status, version, updatedAt: input.now },
    });
    await locks.db.attendanceAuditLog.create({
      data: {
        lectureAttendanceId: record.id,
        version,
        lectureId: record.lectureId,
        studentId: record.studentId,
        action: "AUTO_RECALCULATED",
        fromStatus: record.status,
        toStatus: status,
        fromTeacherStatus: record.teacherStatus,
        toTeacherStatus: record.teacherStatus,
        fromAutoStatus: record.autoStatus,
        toAutoStatus: autoStatus,
        actorRole: "SYSTEM",
        actorId: null,
        reason: null,
        afterFinalization: false,
        registerAuditId: input.registerAuditId,
        createdAt: input.now,
      },
    });
  }
  return input.changes.length;
}
