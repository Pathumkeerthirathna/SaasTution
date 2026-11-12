/**
 * Unified lecture attendance, Stage 5.4f-2: historical attendance backfill.
 * Operator only (scripts/attendance-backfill.ts); never reached from an API
 * route, page or the application runtime. See docs/lecture-attendance.md
 * ("Historical backfill").
 *
 * For one HISTORICAL lecture (start before ATTENDANCE_EVIDENCE_STARTED_AT),
 * each student with an online visit (Attendance row) in any session of the
 * lecture gets ONE canonical BACKFILL record when they have none:
 *   status PRESENT (always: backfill is never a retroactive LATE),
 *   autoStatus = PRESENT / LATE of the chosen visit's join time against the
 *     register's schedule (start + grace), recorded for the teacher only,
 *   firstOnlineAt = the chosen visit's joinedAt (QR, teacher and review
 *     fields empty), version 1, and a BACKFILL v1 audit row (SYSTEM actor,
 *     linked to the chosen visit).
 * The chosen visit is the EARLIEST one that was eligible at its OWN joinedAt
 * (approval from the immutable confirmation history and class enrolment,
 * both at that instant; ordered by joinedAt, then visit id) across every
 * session of the lecture. UNKNOWN and NOT_ELIGIBLE visits are never used;
 * deleted / inactive students are skipped and counted.
 *
 * Existing canonical records (AUTO, TEACHER, BACKFILL, FINALIZATION) are
 * never changed: such students are counted as `existing`, including a lost
 * insert race (insertRecordIfAbsent: ON CONFLICT DO NOTHING). Repeated runs
 * therefore create nothing twice.
 *
 * Refused (before anything is read about students): missing settings (503),
 * missing / deleted lecture (404 LECTURE_NOT_FOUND), cancelled (409
 * LECTURE_CANCELLED), finalized register (409 ATTENDANCE_REGISTER_FINALIZED),
 * LIVE lecture (409 ATTENDANCE_LECTURE_LIVE).
 *
 * Dry run (the default): read-only, no transaction, no locks, no writes; it
 * reports what execute would do now. Execute: ONE short attendance
 * transaction per student, in the standard lock order:
 *   Student FOR SHARE -> Lecture FOR SHARE + Class FOR KEY SHARE (re-checked)
 *   -> register FOR KEY SHARE (created by the SYSTEM when needed) -> the
 *   record (FOR NO KEY UPDATE, or its lock-phase insert) -> the audit row.
 * A student whose transaction hits the lock timeout is counted as busy (its
 * transaction rolled back) and the lecture continues; a later run picks the
 * student up. A lecture that becomes unusable mid-run (deleted, cancelled,
 * finalized, now LIVE) stops the run (`stoppedBecause`).
 *
 * The result holds counts only: no names, student ids, visit ids or times.
 * Nothing is logged here.
 */

import {
  classifyLecture,
  requireApprovalContext,
  requireEvidenceStartedAt,
} from "@/lib/attendance/config";
import { attendanceEligibilityAt, type EligibilityStudent } from "@/lib/attendance/eligibility";
import type { EnrolmentRow } from "@/lib/attendance/enrolment";
import {
  insertRecordIfAbsent,
  lockRecords,
  lockRegisterKeyShared,
  lockStudentShared,
  runAttendanceTransaction,
  type AttendanceLocks,
} from "@/lib/attendance/locks";
import { attendanceError } from "@/lib/attendance/service-errors";
import { evidenceStatusAt, type EvidenceStatus, type LatenessSchedule } from "@/lib/attendance/status";
import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import type { ApprovalHistoryContext, ApprovalHistoryEntry } from "@/lib/student-confirmation-history";
import { later, readEligibilityInputs } from "@/services/lecture-attendance-evidence-service";
import { ensureRegister, inspectLectureForAttendance } from "@/services/lecture-attendance-service";
import { randomUUID } from "node:crypto";

type Env = Record<string, string | undefined>;

/** Students read (and their visits) per batch; the whole lecture is processed. */
export const BACKFILL_STUDENT_BATCH = 500;

export type BackfillMode = "dry-run" | "execute";

export type BackfillLectureResult = {
  lectureId: string;
  mode: BackfillMode;
  /** Students with at least one visit to the lecture's sessions, looked at in this run. */
  students: number;
  /** Execute: BACKFILL records created. Dry run: records execute would create now. */
  created: number;
  /** Of `created`, how many joined after start + grace (autoStatus LATE; status still PRESENT). */
  createdLateJoin: number;
  /** A canonical record already exists (any source; includes a lost insert race): never changed. */
  existing: number;
  /** No visit eligible at its join time (not approved, or not enrolled, then). */
  ineligible: number;
  /** No eligible visit and approval UNKNOWN at some visit (left for the teacher). */
  unknown: number;
  /** Deleted or inactive students. */
  inactive: number;
  /** The student no longer exists, or is not the class teacher's student. */
  skipped: number;
  /** Execute only: lock timeout / deadlock; rolled back, picked up by a later run. */
  busy: number;
  /** Set when the run stopped because the lecture became unusable (deleted, cancelled, finalized, LIVE). */
  stoppedBecause: "LECTURE_CHANGED" | null;
};

type StudentOutcome =
  | { kind: "CREATED"; autoStatus: EvidenceStatus }
  | { kind: "EXISTING" | "INELIGIBLE" | "UNKNOWN" | "INACTIVE" | "SKIPPED" | "LECTURE_CHANGED" };

type Visit = { id: string; joinedAt: Date };

type ChosenVisit = { kind: "ELIGIBLE"; visit: Visit } | { kind: "INELIGIBLE" | "UNKNOWN" };

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 191) {
    throw attendanceError("VALIDATION_ERROR", { field });
  }
}

/**
 * The earliest visit eligible at its own join time (visits already ordered
 * by joinedAt, then id). Without one: UNKNOWN when approval was unknown at
 * any visit, otherwise INELIGIBLE. Pure.
 */
export function chooseBackfillVisit(input: {
  student: EligibilityStudent;
  history: readonly ApprovalHistoryEntry[];
  enrolments: readonly EnrolmentRow[];
  classId: string;
  visits: readonly Visit[];
  context: ApprovalHistoryContext;
}): ChosenVisit {
  let sawUnknown = false;
  for (const visit of input.visits) {
    const outcome = attendanceEligibilityAt({
      student: input.student,
      history: input.history,
      enrolments: input.enrolments,
      classId: input.classId,
      instant: visit.joinedAt,
      context: input.context,
    }).outcome;
    if (outcome === "ELIGIBLE") return { kind: "ELIGIBLE", visit };
    if (outcome === "UNKNOWN") sawUnknown = true;
  }
  return { kind: sawUnknown ? "UNKNOWN" : "INELIGIBLE" };
}

/** The lecture as the backfill sees it before any student is touched (refusals). */
async function requireHistoricalLecture(lectureId: string, evidenceStartedAt: Date) {
  const lecture = await prisma.lecture.findUnique({
    where: { id: lectureId },
    select: {
      id: true,
      classId: true,
      status: true,
      classStatus: true,
      date: true,
      class: { select: { teacherId: true, attendanceGraceMinutes: true } },
    },
  });
  if (!lecture || lecture.status !== 0) throw attendanceError("LECTURE_NOT_FOUND");
  if (lecture.classStatus === "CANCELLED") throw attendanceError("LECTURE_CANCELLED");

  const register = await prisma.lectureAttendanceRegister.findUnique({
    where: { lectureId },
    select: { scheduledStartAt: true, graceMinutes: true, finalizedAt: true },
  });
  if (register?.finalizedAt) throw attendanceError("ATTENDANCE_REGISTER_FINALIZED");
  if (classifyLecture(register?.scheduledStartAt ?? lecture.date, evidenceStartedAt) === "LIVE") {
    throw attendanceError("ATTENDANCE_LECTURE_LIVE");
  }

  // The schedule PRESENT / LATE is judged against: the register's, or the one
  // ensureRegister would copy (the lecture's start and the class's grace).
  const schedule: LatenessSchedule = register
    ? { scheduledStartAt: register.scheduledStartAt, graceMinutes: register.graceMinutes }
    : { scheduledStartAt: lecture.date, graceMinutes: lecture.class.attendanceGraceMinutes };
  return { lecture, schedule };
}

/**
 * Backfills one HISTORICAL lecture (see the module header). `mode` defaults
 * to "dry-run"; only "execute" writes. Errors: 400 VALIDATION_ERROR, 404
 * LECTURE_NOT_FOUND, 409 LECTURE_CANCELLED / ATTENDANCE_REGISTER_FINALIZED /
 * ATTENDANCE_LECTURE_LIVE, 503 ATTENDANCE_APPROVAL_NOT_CONFIGURED /
 * ATTENDANCE_EVIDENCE_NOT_CONFIGURED.
 */
export async function backfillLectureAttendance(
  input: { lectureId: string; mode?: BackfillMode },
  options: { env?: Env } = {}
): Promise<BackfillLectureResult> {
  assertId(input.lectureId, "lectureId");
  const mode = input.mode ?? "dry-run";
  if (mode !== "dry-run" && mode !== "execute") throw attendanceError("VALIDATION_ERROR", { field: "mode" });

  const env = options.env ?? process.env;
  const context = requireApprovalContext(env);
  const evidenceStartedAt = requireEvidenceStartedAt(env);
  const lectureId = input.lectureId;
  const { lecture, schedule } = await requireHistoricalLecture(lectureId, evidenceStartedAt);

  const result: BackfillLectureResult = {
    lectureId,
    mode,
    students: 0,
    created: 0,
    createdLateJoin: 0,
    existing: 0,
    ineligible: 0,
    unknown: 0,
    inactive: 0,
    skipped: 0,
    busy: 0,
    stoppedBecause: null,
  };

  let cursor: string | null = null;
  for (;;) {
    const studentRows: { studentId: string }[] = await prisma.attendance.findMany({
      where: { classSession: { lectureId }, ...(cursor !== null ? { studentId: { gt: cursor } } : {}) },
      distinct: ["studentId"],
      orderBy: { studentId: "asc" },
      select: { studentId: true },
      take: BACKFILL_STUDENT_BATCH,
    });
    const studentIds = studentRows.map((row) => row.studentId);
    if (studentIds.length === 0) break;
    cursor = studentIds[studentIds.length - 1];

    const visits = await prisma.attendance.findMany({
      where: { classSession: { lectureId }, studentId: { in: studentIds } },
      orderBy: [{ studentId: "asc" }, { joinedAt: "asc" }, { id: "asc" }],
      select: { id: true, studentId: true, joinedAt: true },
    });
    const visitsBy = new Map<string, Visit[]>();
    for (const visit of visits) {
      const list = visitsBy.get(visit.studentId) ?? [];
      list.push({ id: visit.id, joinedAt: visit.joinedAt });
      visitsBy.set(visit.studentId, list);
    }

    if (mode === "dry-run") {
      await dryRunBatch(result, { lectureId, classId: lecture.classId, teacherId: lecture.class.teacherId, studentIds, visitsBy, context, schedule });
    } else {
      for (const studentId of studentIds) {
        let outcome: StudentOutcome;
        try {
          outcome = await runAttendanceTransaction((locks) =>
            backfillStudentInTransaction(locks, { lectureId, studentId, visits: visitsBy.get(studentId) ?? [], context, evidenceStartedAt })
          );
        } catch (error) {
          // Already rolled back; only a lock timeout / deadlock is absorbed.
          if (error instanceof AppError && error.code === "ATTENDANCE_BUSY") {
            result.students += 1;
            result.busy += 1;
            continue;
          }
          throw error;
        }
        if (outcome.kind === "LECTURE_CHANGED") {
          result.stoppedBecause = "LECTURE_CHANGED";
          return result;
        }
        count(result, outcome);
      }
    }

    if (studentIds.length < BACKFILL_STUDENT_BATCH) break;
  }

  return result;
}

function count(result: BackfillLectureResult, outcome: Exclude<StudentOutcome, { kind: "LECTURE_CHANGED" }>) {
  result.students += 1;
  if (outcome.kind === "CREATED") {
    result.created += 1;
    if (outcome.autoStatus === "LATE") result.createdLateJoin += 1;
  } else if (outcome.kind === "EXISTING") result.existing += 1;
  else if (outcome.kind === "INELIGIBLE") result.ineligible += 1;
  else if (outcome.kind === "UNKNOWN") result.unknown += 1;
  else if (outcome.kind === "INACTIVE") result.inactive += 1;
  else result.skipped += 1;
}

/** Dry run: the same decisions from plain reads (no transaction, no locks, no writes). */
async function dryRunBatch(
  result: BackfillLectureResult,
  ctx: {
    lectureId: string;
    classId: string;
    teacherId: string;
    studentIds: string[];
    visitsBy: Map<string, Visit[]>;
    context: ApprovalHistoryContext;
    schedule: LatenessSchedule;
  }
) {
  const [students, records] = await Promise.all([
    prisma.student.findMany({
      where: { id: { in: ctx.studentIds } },
      select: { id: true, teacherId: true, status: true, confirmationStatus: true, confirmedAt: true, approvedAt: true },
    }),
    prisma.lectureAttendance.findMany({
      where: { lectureId: ctx.lectureId, studentId: { in: ctx.studentIds } },
      select: { studentId: true },
    }),
  ]);
  const studentBy = new Map(students.map((s) => [s.id, s]));
  const recorded = new Set(records.map((r) => r.studentId));

  for (const studentId of ctx.studentIds) {
    const student = studentBy.get(studentId);
    if (!student || student.teacherId !== ctx.teacherId) {
      count(result, { kind: "SKIPPED" });
      continue;
    }
    if (student.status !== 0) {
      count(result, { kind: "INACTIVE" });
      continue;
    }
    const [history, enrolments] = await Promise.all([
      prisma.studentConfirmationHistory.findMany({
        where: { studentId },
        select: { id: true, fromStatus: true, toStatus: true, decidedAt: true, previousConfirmedAt: true },
      }),
      prisma.classStudent.findMany({
        where: { studentId, classId: ctx.classId },
        select: { id: true, classId: true, assignedAt: true, removedAt: true, isActive: true },
      }),
    ]);
    const chosen = chooseBackfillVisit({
      student,
      history,
      enrolments,
      classId: ctx.classId,
      visits: ctx.visitsBy.get(studentId) ?? [],
      context: ctx.context,
    });
    if (chosen.kind !== "ELIGIBLE") {
      count(result, { kind: chosen.kind });
      continue;
    }
    if (recorded.has(studentId)) {
      count(result, { kind: "EXISTING" });
      continue;
    }
    count(result, { kind: "CREATED", autoStatus: evidenceStatusAt(chosen.visit.joinedAt, ctx.schedule) });
  }
}

async function backfillStudentInTransaction(
  locks: AttendanceLocks,
  ctx: { lectureId: string; studentId: string; visits: readonly Visit[]; context: ApprovalHistoryContext; evidenceStartedAt: Date }
): Promise<StudentOutcome> {
  // 1. Student FOR SHARE (serializes with approval decisions).
  const student = await lockStudentShared(locks, ctx.studentId);
  if (!student) return { kind: "SKIPPED" };

  // 2. Lecture FOR SHARE + Class FOR KEY SHARE, re-checked under the lock.
  const found = await inspectLectureForAttendance(locks, ctx.lectureId);
  if (found.state !== "OK") return { kind: "LECTURE_CHANGED" };
  if (student.teacherId !== found.cls.teacherId) return { kind: "SKIPPED" };

  // 3. The register (if any): still open and still HISTORICAL, under the locks.
  const existingRegister = await lockRegisterKeyShared(locks, ctx.lectureId);
  if (existingRegister?.finalizedAt) return { kind: "LECTURE_CHANGED" };
  if (classifyLecture(existingRegister?.scheduledStartAt ?? found.lecture.date, ctx.evidenceStartedAt) === "LIVE") {
    return { kind: "LECTURE_CHANGED" };
  }

  if (student.status !== 0) return { kind: "INACTIVE" };

  // 4. The earliest visit eligible at its own join time.
  const { history, enrolments } = await readEligibilityInputs(locks, student.id, found.lecture.classId);
  const chosen = chooseBackfillVisit({
    student,
    history,
    enrolments,
    classId: found.lecture.classId,
    visits: ctx.visits,
    context: ctx.context,
  });
  if (chosen.kind !== "ELIGIBLE") return { kind: chosen.kind };

  // 5. An existing record (any source) is never changed. Without a register
  //    there can be no record (foreign key).
  if (existingRegister) {
    const record = (await lockRecords(locks, ctx.lectureId, [student.id]))[0] ?? null;
    if (record) return { kind: "EXISTING" };
  }

  // 6. The register (created by the SYSTEM when needed), re-checked.
  const now = later(new Date(), chosen.visit.joinedAt);
  const { register } = await ensureRegister(locks, ctx.lectureId, { mode: "KEY_SHARE", now, actor: { role: "SYSTEM" } });
  if (register.finalizedAt || classifyLecture(register.scheduledStartAt, ctx.evidenceStartedAt) === "LIVE") {
    return { kind: "LECTURE_CHANGED" };
  }

  // 7. The record (lock phase): a concurrent creator wins; ours inserts nothing.
  const autoStatus = evidenceStatusAt(chosen.visit.joinedAt, register);
  const id = randomUUID();
  const inserted = await insertRecordIfAbsent(locks, {
    id,
    lectureId: ctx.lectureId,
    classId: found.lecture.classId,
    studentId: student.id,
    status: "PRESENT",
    statusSource: "BACKFILL",
    firstOnlineAt: chosen.visit.joinedAt,
    firstQrAt: null,
    autoStatus,
    teacherStatus: null,
    teacherDecidedAt: null,
    teacherDecidedById: null,
    pendingReviewSince: null,
    now,
  });
  if (!inserted) return { kind: "EXISTING" };

  // 8. Write phase: the BACKFILL v1 audit row, linked to the chosen visit.
  locks.beginWrites();
  await locks.db.attendanceAuditLog.create({
    data: {
      lectureAttendanceId: id,
      version: 1,
      lectureId: ctx.lectureId,
      studentId: student.id,
      action: "BACKFILL",
      fromStatus: null,
      toStatus: "PRESENT",
      fromTeacherStatus: null,
      toTeacherStatus: null,
      fromAutoStatus: null,
      toAutoStatus: autoStatus,
      actorRole: "SYSTEM",
      actorId: null,
      reason: null,
      afterFinalization: false,
      scanEventId: null,
      attendanceVisitId: chosen.visit.id,
      createdAt: now,
    },
  });
  return { kind: "CREATED", autoStatus };
}

// ---- Operator scopes (scripts/attendance-backfill.ts) ------------------------------------

export type BackfillScope = { kind: "lecture"; lectureId: string } | { kind: "class"; classId: string } | { kind: "before"; before: Date };

/**
 * The lectures of a scope, in (date, id) order: the one lecture, or every
 * non-deleted, non-cancelled lecture of the class / starting before the
 * instant. Each is then refused or processed on its own (LIVE and finalized
 * lectures are refused per lecture, never silently skipped).
 */
export async function listBackfillLectures(scope: BackfillScope): Promise<string[]> {
  if (scope.kind === "lecture") {
    assertId(scope.lectureId, "lectureId");
    return [scope.lectureId];
  }
  if (scope.kind === "class") assertId(scope.classId, "classId");
  else if (!(scope.before instanceof Date) || Number.isNaN(scope.before.getTime())) {
    throw attendanceError("VALIDATION_ERROR", { field: "before" });
  }
  const rows = await prisma.lecture.findMany({
    where: {
      status: 0,
      classStatus: { not: "CANCELLED" },
      ...(scope.kind === "class" ? { classId: scope.classId } : { date: { lt: scope.before } }),
    },
    orderBy: [{ date: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
