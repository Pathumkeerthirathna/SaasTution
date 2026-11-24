/**
 * Unified lecture attendance, Stage 5.4f-1: online attendance reconciliation.
 * See docs/lecture-attendance.md ("Online reconciliation").
 *
 * Repairs missing canonical online evidence from the committed online visits
 * (Attendance rows): visits whose post-commit dispatch was skipped
 * (serverless, missing settings), dropped (queue full, process restart) or
 * failed. Request-driven only (F2): a teacher action now, the finalization
 * preparation later; no background worker.
 *
 * For one LIVE lecture, per student (ordered by studentId, at most 500 per
 * request, F3), in ONE short attendance transaction each:
 *   Student FOR SHARE -> Lecture FOR SHARE + Class FOR KEY SHARE (re-checked)
 *   -> register FOR KEY SHARE (created when needed; never for a finalized
 *   lecture) -> record FOR NO KEY UPDATE (or its lock-phase insert) -> the
 *   evidence change and its audit row (linked to the chosen visit).
 * The chosen visit is the EARLIEST one that was eligible at its OWN joinedAt
 * (approval and enrolment; ordered by joinedAt, then visit id) across every
 * session of the lecture; leftAt is never used. The existing evidence rules
 * apply unchanged (planEvidence): earliest evidence only, teacher decisions
 * and BACKFILL records never changed, reviews raised only for stronger
 * evidence and never cleared, duplicates write nothing.
 *
 * Finalized registers (F7): only students who already have a record are
 * reconciled (evidence / review only); a student without one is counted, and
 * no record is ever created.
 *
 * Fail closed: both settings required (503); the lecture must be the
 * teacher's (404), not deleted (404) or cancelled (409 LECTURE_CANCELLED),
 * and LIVE (409 ATTENDANCE_LECTURE_HISTORICAL). A student whose transaction
 * hits the lock timeout is counted as busy (its transaction rolled back
 * first); a fresh run picks it up again. The result holds counts only: no
 * names, ids of students, tokens or visit details. Nothing is logged.
 */

import {
  classifyLecture,
  requireApprovalContext,
  requireEvidenceStartedAt,
} from "@/lib/attendance/config";
import { attendanceEligibilityAt } from "@/lib/attendance/eligibility";
import {
  lockRecords,
  lockRegisterKeyShared,
  lockStudentShared,
  runAttendanceTransaction,
  type AttendanceLocks,
} from "@/lib/attendance/locks";
import { attendanceError } from "@/lib/attendance/service-errors";
import { AppError } from "@/lib/error-handler";
import { NORMAL_LECTURE_WHERE } from "@/lib/default-lecture";
import { prisma } from "@/lib/prisma";
import type { ApprovalHistoryContext } from "@/lib/student-confirmation-history";
import {
  applyEvidenceInTransaction,
  later,
  readEligibilityInputs,
  writeEvidenceAudit,
} from "@/services/lecture-attendance-evidence-service";
import { ensureRegister, inspectLectureForAttendance } from "@/services/lecture-attendance-service";

type Env = Record<string, string | undefined>;

export const RECONCILE_MAX_LIMIT = 500;
export const RECONCILE_DEFAULT_LIMIT = RECONCILE_MAX_LIMIT;

export type ReconcileInput = {
  teacherId: string;
  lectureId: string;
  /** The previous result's nextCursor (the last studentId processed); omit for the first page. */
  cursor?: string | null;
  /** Students per request: 1–500 (default 500). */
  limit?: number | null;
};

export type ReconcileResult = {
  lectureId: string;
  /** Students with visits looked at in this request. */
  processed: number;
  /** Evidence recorded (record created or updated, review possibly raised). */
  applied: number;
  /** The earliest eligible visit was already represented: nothing written. */
  duplicates: number;
  /** No visit eligible at its join time (not enrolled / not approved then). */
  ineligible: number;
  /** Approval unknown at every candidate visit (left for the teacher). */
  unknown: number;
  /** Deleted or inactive students. */
  inactive: number;
  /** Finalized register and no existing record: nothing created (F7). */
  finalizedWithoutRecord: number;
  /** Lock timeout / deadlock: rolled back, try again with a fresh run. */
  busy: number;
  /** Not this teacher's student, or the student no longer exists. */
  skipped: number;
  /** Pass as `cursor` to continue; null when every student was looked at. */
  nextCursor: string | null;
  /** Set when the run stopped early because the lecture changed (deleted, cancelled, now historical). */
  stoppedBecause: "LECTURE_CHANGED" | null;
};

type StudentOutcome =
  | "APPLIED"
  | "DUPLICATE"
  | "INELIGIBLE"
  | "UNKNOWN"
  | "INACTIVE"
  | "FINALIZED_WITHOUT_RECORD"
  | "SKIPPED"
  | "LECTURE_CHANGED";

type Visit = { id: string; joinedAt: Date };

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 191) {
    throw attendanceError("VALIDATION_ERROR", { field });
  }
}

/**
 * Reconciles the online evidence of up to `limit` students of one lecture
 * (see the module header). Errors: 400 VALIDATION_ERROR, 404
 * LECTURE_NOT_FOUND, 409 LECTURE_CANCELLED, 409 ATTENDANCE_LECTURE_HISTORICAL,
 * 503 ATTENDANCE_APPROVAL_NOT_CONFIGURED / ATTENDANCE_EVIDENCE_NOT_CONFIGURED.
 */
export async function reconcileLectureOnlineEvidence(
  input: ReconcileInput,
  options: { env?: Env } = {}
): Promise<ReconcileResult> {
  assertId(input.teacherId, "teacherId");
  assertId(input.lectureId, "lectureId");
  const cursor = input.cursor ?? null;
  if (cursor !== null) assertId(cursor, "cursor");
  const limit = input.limit ?? RECONCILE_DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > RECONCILE_MAX_LIMIT) {
    throw attendanceError("VALIDATION_ERROR", { field: "limit" });
  }

  const env = options.env ?? process.env;
  const context = requireApprovalContext(env);
  const evidenceStartedAt = requireEvidenceStartedAt(env);
  const lectureId = input.lectureId;

  // Request-level checks (each student's transaction re-checks under the lock).
  const lecture = await prisma.lecture.findFirst({
    where: { id: lectureId, ...NORMAL_LECTURE_WHERE, class: { teacherId: input.teacherId } },
    select: { id: true, status: true, classStatus: true, date: true },
  });
  if (!lecture || lecture.status !== 0) throw attendanceError("LECTURE_NOT_FOUND");
  if (lecture.classStatus === "CANCELLED") throw attendanceError("LECTURE_CANCELLED");
  const register = await prisma.lectureAttendanceRegister.findUnique({ where: { lectureId }, select: { scheduledStartAt: true } });
  if (classifyLecture(register?.scheduledStartAt ?? lecture.date, evidenceStartedAt) === "HISTORICAL") {
    throw attendanceError("ATTENDANCE_LECTURE_HISTORICAL");
  }

  // Visit discovery: students with a visit in any session of this lecture.
  const studentRows = await prisma.attendance.findMany({
    where: { classSession: { lectureId }, ...(cursor !== null ? { studentId: { gt: cursor } } : {}) },
    distinct: ["studentId"],
    orderBy: { studentId: "asc" },
    select: { studentId: true },
    take: limit + 1,
  });
  const studentIds = studentRows.slice(0, limit).map((row) => row.studentId);
  const hasMore = studentRows.length > limit;

  const visits = studentIds.length
    ? await prisma.attendance.findMany({
        where: { classSession: { lectureId }, studentId: { in: studentIds } },
        orderBy: [{ studentId: "asc" }, { joinedAt: "asc" }, { id: "asc" }],
        select: { id: true, studentId: true, joinedAt: true },
      })
    : [];
  const visitsBy = new Map<string, Visit[]>();
  for (const visit of visits) {
    const list = visitsBy.get(visit.studentId) ?? [];
    list.push({ id: visit.id, joinedAt: visit.joinedAt });
    visitsBy.set(visit.studentId, list);
  }

  const result: ReconcileResult = {
    lectureId,
    processed: 0,
    applied: 0,
    duplicates: 0,
    ineligible: 0,
    unknown: 0,
    inactive: 0,
    finalizedWithoutRecord: 0,
    busy: 0,
    skipped: 0,
    nextCursor: hasMore && studentIds.length ? studentIds[studentIds.length - 1] : null,
    stoppedBecause: null,
  };

  for (let i = 0; i < studentIds.length; i += 1) {
    const studentId = studentIds[i];
    let outcome: StudentOutcome;
    try {
      outcome = await runAttendanceTransaction((locks) =>
        reconcileStudentInTransaction(locks, {
          lectureId,
          studentId,
          visits: visitsBy.get(studentId) ?? [],
          context,
          evidenceStartedAt,
        })
      );
    } catch (error) {
      // The transaction has already rolled back; only a lock timeout or a
      // deadlock is absorbed (counted), anything else is a real failure.
      if (error instanceof AppError && error.code === "ATTENDANCE_BUSY") {
        result.processed += 1;
        result.busy += 1;
        continue;
      }
      throw error;
    }

    if (outcome === "LECTURE_CHANGED") {
      // Stop: continue from just before this student once the lecture is usable again.
      result.stoppedBecause = "LECTURE_CHANGED";
      result.nextCursor = i > 0 ? studentIds[i - 1] : cursor;
      return result;
    }

    result.processed += 1;
    if (outcome === "APPLIED") result.applied += 1;
    else if (outcome === "DUPLICATE") result.duplicates += 1;
    else if (outcome === "INELIGIBLE") result.ineligible += 1;
    else if (outcome === "UNKNOWN") result.unknown += 1;
    else if (outcome === "INACTIVE") result.inactive += 1;
    else if (outcome === "FINALIZED_WITHOUT_RECORD") result.finalizedWithoutRecord += 1;
    else result.skipped += 1;
  }

  return result;
}

async function reconcileStudentInTransaction(
  locks: AttendanceLocks,
  ctx: { lectureId: string; studentId: string; visits: readonly Visit[]; context: ApprovalHistoryContext; evidenceStartedAt: Date }
): Promise<StudentOutcome> {
  // 1. Student FOR SHARE (serializes with approval decisions).
  const student = await lockStudentShared(locks, ctx.studentId);
  if (!student) return "SKIPPED";

  // 2. Lecture FOR SHARE + Class FOR KEY SHARE, re-checked under the lock.
  const found = await inspectLectureForAttendance(locks, ctx.lectureId);
  if (found.state !== "OK") return "LECTURE_CHANGED";
  if (student.teacherId !== found.cls.teacherId) return "SKIPPED";

  // 3. The register (if any), and the LIVE / HISTORICAL boundary under the locks.
  const existing = await lockRegisterKeyShared(locks, ctx.lectureId);
  if (classifyLecture(existing?.scheduledStartAt ?? found.lecture.date, ctx.evidenceStartedAt) === "HISTORICAL") {
    return "LECTURE_CHANGED";
  }

  if (student.status !== 0) return "INACTIVE";

  // 4. The earliest visit eligible at its OWN join time (visits are ordered).
  const { history, enrolments } = await readEligibilityInputs(locks, student.id, found.lecture.classId);
  let chosen: Visit | null = null;
  let sawUnknown = false;
  for (const visit of ctx.visits) {
    const outcome = attendanceEligibilityAt({
      student,
      history,
      enrolments,
      classId: found.lecture.classId,
      instant: visit.joinedAt,
      context: ctx.context,
    }).outcome;
    if (outcome === "ELIGIBLE") {
      chosen = visit;
      break;
    }
    if (outcome === "UNKNOWN") sawUnknown = true;
  }
  if (!chosen) return sawUnknown ? "UNKNOWN" : "INELIGIBLE";

  // 5. Finalized register: existing records only, never a new one (F7).
  if (existing?.finalizedAt) {
    const record = (await lockRecords(locks, ctx.lectureId, [student.id]))[0] ?? null;
    if (!record) return "FINALIZED_WITHOUT_RECORD";
  }

  // 6. The existing evidence rules (planEvidence), then the audit row linked to the visit.
  const now = later(new Date(), chosen.joinedAt);
  const ensured = await ensureRegister(locks, ctx.lectureId, { mode: "KEY_SHARE", now, actor: { role: "SYSTEM" } });
  const applied = await applyEvidenceInTransaction(locks, {
    register: ensured.register,
    lectureId: ctx.lectureId,
    classId: found.lecture.classId,
    studentId: student.id,
    channel: "ONLINE",
    serverRecordedAt: chosen.joinedAt,
    now,
  });
  await writeEvidenceAudit(locks, applied, { lectureId: ctx.lectureId, studentId: student.id, now, attendanceVisitId: chosen.id });

  if (applied.plan.effect === "DUPLICATE") return "DUPLICATE";
  if (applied.plan.effect === "RECORDED_ONLY") return "FINALIZED_WITHOUT_RECORD";
  return "APPLIED";
}
