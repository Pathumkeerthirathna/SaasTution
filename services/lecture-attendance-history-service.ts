/**
 * Unified lecture attendance, Stage 5.4c: read-only, paginated audit history.
 * See docs/lecture-attendance.md ("Attendance history").
 *
 *  - getRegisterHistory: the register's own audit log
 *    (LectureAttendanceRegisterAuditLog: created, grace changed, schedule
 *    synced, finalized), plus the QR closure (its own immutable row).
 *  - getStudentAttendanceHistory: one student's record audit log
 *    (AttendanceAuditLog).
 *
 * Read only: plain reads (no transaction, no locks, no writes), so a GET
 * never creates a register or a record and never touches the append-only
 * audit tables. No configuration is needed.
 *
 * Order and pagination: both audit tables carry a gap-free, unique version
 * per register / record, assigned in commit order under the row locks; the
 * history is ordered by that version (ascending: oldest first) and paged by
 * keyset (`version > cursor`), so pages never overlap or skip entries, and the
 * append-only rows cannot move between requests. The cursor is the last
 * version of the previous page (a decimal string); `nextCursor` is null on
 * the last page.
 *
 * Responses are sanitized: no audit row ids, no scan / visit / register-audit
 * row ids (only what caused a change), no token hashes, no student data
 * beyond the requested id. Actors are "SYSTEM" or the lecture's teacher.
 */

import { attendanceError } from "@/lib/attendance/service-errors";
import { prisma } from "@/lib/prisma";

export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 100;

/** A version cursor: a positive decimal integer without leading zeros (at most 9 digits). */
const CURSOR_PATTERN = /^[1-9][0-9]{0,8}$/;

export type HistoryPageInput = {
  /** The previous page's nextCursor; omit (or null) for the first page. */
  cursor?: string | null;
  /** Entries per page: 1–100, default 50. */
  limit?: number | null;
};

type HistoryActor = { role: "SYSTEM"; teacherId: null } | { role: "TEACHER"; teacherId: string };

function parsePage(input: HistoryPageInput | undefined): { afterVersion: number; limit: number } {
  const cursor = input?.cursor ?? null;
  const limit = input?.limit ?? null;

  if (cursor !== null && (typeof cursor !== "string" || !CURSOR_PATTERN.test(cursor))) {
    throw attendanceError("VALIDATION_ERROR", { field: "cursor" });
  }
  if (limit !== null && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > HISTORY_MAX_LIMIT)) {
    throw attendanceError("VALIDATION_ERROR", { field: "limit" });
  }

  return { afterVersion: cursor === null ? 0 : Number(cursor), limit: limit ?? HISTORY_DEFAULT_LIMIT };
}

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 191) {
    throw attendanceError("VALIDATION_ERROR", { field });
  }
}

function actorOf(row: { actorRole: string; actorId: string | null }): HistoryActor {
  return row.actorRole === "TEACHER" && row.actorId
    ? { role: "TEACHER", teacherId: row.actorId }
    : { role: "SYSTEM", teacherId: null };
}

/** The teacher's lecture (status 0), else 404: another teacher's lecture looks the same as a missing one. */
async function requireOwnedLecture(teacherId: string, lectureId: string) {
  const lecture = await prisma.lecture.findFirst({
    where: { id: lectureId, status: 0, class: { teacherId } },
    select: { id: true },
  });
  if (!lecture) throw attendanceError("LECTURE_NOT_FOUND");
  return lecture;
}

function page<T extends { version: number }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit && items.length > 0 ? String(items[items.length - 1].version) : null;
  return { items, nextCursor };
}

// ---- Register history ------------------------------------------------------------------

export type RegisterHistoryEntry = {
  version: number;
  action: "CREATED" | "GRACE_CHANGED" | "SCHEDULE_SYNCED" | "FINALIZED";
  at: Date;
  actor: HistoryActor;
  reason: string | null;
  graceMinutes: { from: number | null; to: number | null } | null;
  scheduledStartAt: { from: Date | null; to: Date | null } | null;
  scheduledEndAt: { from: Date | null; to: Date | null } | null;
  finalization: {
    finalizedAt: Date | null;
    eligibleCount: number | null;
    unknownEligibilityCount: number | null;
    absentCreatedCount: number | null;
  } | null;
  recalculatedCount: number | null;
};

export type RegisterHistoryPage = {
  lectureId: string;
  /** False: no register yet (nothing has been recorded for this lecture). */
  registerExists: boolean;
  /** The register's current version (0 without a register): the last entry's version. */
  registerVersion: number;
  /** QR attendance closure (its own immutable row), or null. */
  qrClosure: { closedAt: Date; actor: HistoryActor } | null;
  entries: RegisterHistoryEntry[];
  nextCursor: string | null;
};

const pair = <T>(from: T | null, to: T | null) => (from === null && to === null ? null : { from, to });

/**
 * The register's audit history, oldest first, paged (see the header). 404
 * LECTURE_NOT_FOUND unless the lecture is the teacher's (status 0); 400
 * VALIDATION_ERROR for a bad cursor or limit. Without a register: empty,
 * registerExists false (nothing is created).
 */
export async function getRegisterHistory(
  teacherId: string,
  lectureId: string,
  input?: HistoryPageInput
): Promise<RegisterHistoryPage> {
  assertId(teacherId, "teacherId");
  assertId(lectureId, "lectureId");
  const { afterVersion, limit } = parsePage(input);

  await requireOwnedLecture(teacherId, lectureId);

  const [register, closure] = await Promise.all([
    prisma.lectureAttendanceRegister.findUnique({ where: { lectureId }, select: { version: true } }),
    prisma.lectureQrAttendanceClosure.findUnique({ where: { lectureId }, select: { closedAt: true, closedByTeacherId: true } }),
  ]);

  const qrClosure = closure ? { closedAt: closure.closedAt, actor: { role: "TEACHER" as const, teacherId: closure.closedByTeacherId } } : null;

  if (!register) {
    return { lectureId, registerExists: false, registerVersion: 0, qrClosure, entries: [], nextCursor: null };
  }

  const rows = await prisma.lectureAttendanceRegisterAuditLog.findMany({
    where: { lectureId, version: { gt: afterVersion } },
    orderBy: { version: "asc" },
    take: limit + 1,
    select: {
      version: true,
      action: true,
      createdAt: true,
      actorRole: true,
      actorId: true,
      reason: true,
      fromGraceMinutes: true,
      toGraceMinutes: true,
      fromScheduledStartAt: true,
      toScheduledStartAt: true,
      fromScheduledEndAt: true,
      toScheduledEndAt: true,
      finalizedAt: true,
      eligibleCount: true,
      unknownEligibilityCount: true,
      absentCreatedCount: true,
      recalculatedCount: true,
    },
  });

  const { items, nextCursor } = page(rows, limit);

  return {
    lectureId,
    registerExists: true,
    registerVersion: register.version,
    qrClosure,
    entries: items.map((row) => ({
      version: row.version,
      action: row.action,
      at: row.createdAt,
      actor: actorOf(row),
      reason: row.reason,
      graceMinutes: pair(row.fromGraceMinutes, row.toGraceMinutes),
      scheduledStartAt: pair(row.fromScheduledStartAt, row.toScheduledStartAt),
      scheduledEndAt: pair(row.fromScheduledEndAt, row.toScheduledEndAt),
      finalization:
        row.action === "FINALIZED"
          ? {
              finalizedAt: row.finalizedAt,
              eligibleCount: row.eligibleCount,
              unknownEligibilityCount: row.unknownEligibilityCount,
              absentCreatedCount: row.absentCreatedCount,
            }
          : null,
      recalculatedCount: row.recalculatedCount,
    })),
    nextCursor,
  };
}

// ---- Student record history ------------------------------------------------------------

type Status = "PRESENT" | "LATE" | "ABSENT" | "EXCUSED";

export type StudentHistoryEntry = {
  version: number;
  action:
    | "CREATED_AUTO"
    | "AUTO_UPDATED"
    | "AUTO_RECALCULATED"
    | "EVIDENCE_RECORDED"
    | "TEACHER_SET"
    | "EVIDENCE_ACCEPTED"
    | "EVIDENCE_DISMISSED"
    | "FINALIZE_ABSENT"
    | "BACKFILL";
  at: Date;
  actor: HistoryActor;
  reason: string | null;
  afterFinalization: boolean;
  status: { from: Status | null; to: Status };
  teacherStatus: { from: Status | null; to: Status | null };
  autoStatus: { from: Status | null; to: Status | null };
  /** What caused the change: a QR scan, an online visit, a register change (grace / schedule), or none (teacher, finalization). */
  cause: "QR_SCAN" | "ONLINE_VISIT" | "REGISTER_CHANGE" | null;
};

export type StudentHistoryPage = {
  lectureId: string;
  studentId: string;
  /** False: the student has no attendance record for this lecture (nothing is created). */
  recordExists: boolean;
  /** The record's current state, or null. */
  record: { status: Status; statusSource: "AUTO" | "TEACHER" | "FINALIZATION" | "BACKFILL"; version: number; pendingReview: boolean } | null;
  entries: StudentHistoryEntry[];
  nextCursor: string | null;
};

/**
 * One student's attendance-record audit history for a lecture, oldest first,
 * paged (see the header). 404 LECTURE_NOT_FOUND unless the lecture is the
 * teacher's (status 0); 404 STUDENT_NOT_FOUND unless the student is the
 * teacher's; 400 VALIDATION_ERROR for a bad cursor or limit. Without a
 * record: empty, recordExists false (nothing is created).
 */
export async function getStudentAttendanceHistory(
  teacherId: string,
  lectureId: string,
  studentId: string,
  input?: HistoryPageInput
): Promise<StudentHistoryPage> {
  assertId(teacherId, "teacherId");
  assertId(lectureId, "lectureId");
  assertId(studentId, "studentId");
  const { afterVersion, limit } = parsePage(input);

  await requireOwnedLecture(teacherId, lectureId);

  const student = await prisma.student.findFirst({ where: { id: studentId, teacherId }, select: { id: true } });
  if (!student) throw attendanceError("STUDENT_NOT_FOUND");

  const record = await prisma.lectureAttendance.findUnique({
    where: { lectureId_studentId: { lectureId, studentId } },
    select: { id: true, status: true, statusSource: true, version: true, pendingReviewSince: true },
  });

  if (!record) {
    return { lectureId, studentId, recordExists: false, record: null, entries: [], nextCursor: null };
  }

  const rows = await prisma.attendanceAuditLog.findMany({
    where: { lectureAttendanceId: record.id, version: { gt: afterVersion } },
    orderBy: { version: "asc" },
    take: limit + 1,
    select: {
      version: true,
      action: true,
      createdAt: true,
      actorRole: true,
      actorId: true,
      reason: true,
      afterFinalization: true,
      fromStatus: true,
      toStatus: true,
      fromTeacherStatus: true,
      toTeacherStatus: true,
      fromAutoStatus: true,
      toAutoStatus: true,
      scanEventId: true,
      attendanceVisitId: true,
      registerAuditId: true,
    },
  });

  const { items, nextCursor } = page(rows, limit);

  return {
    lectureId,
    studentId,
    recordExists: true,
    record: {
      status: record.status,
      statusSource: record.statusSource,
      version: record.version,
      pendingReview: record.pendingReviewSince !== null,
    },
    entries: items.map((row) => ({
      version: row.version,
      action: row.action,
      at: row.createdAt,
      actor: actorOf(row),
      reason: row.reason,
      afterFinalization: row.afterFinalization,
      status: { from: row.fromStatus, to: row.toStatus },
      teacherStatus: { from: row.fromTeacherStatus, to: row.toTeacherStatus },
      autoStatus: { from: row.fromAutoStatus, to: row.toAutoStatus },
      cause: row.scanEventId ? "QR_SCAN" : row.attendanceVisitId ? "ONLINE_VISIT" : row.registerAuditId ? "REGISTER_CHANGE" : null,
    })),
    nextCursor,
  };
}
