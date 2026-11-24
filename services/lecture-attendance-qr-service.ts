/**
 * Unified lecture attendance, Stage 5.4b: QR scans (physical evidence).
 * See docs/lecture-attendance.md ("Evidence processing").
 *
 * Separate from services/lecture-attendance-evidence-service.ts (whose shared
 * evidence code it uses) so that the online-join path, which dispatches
 * online evidence, never loads lib/student-qr-token.ts (server-only).
 *
 * Same rules as the evidence service: one runAttendanceTransaction in the
 * global lock order, the lecture re-checked under its lock, no database error
 * caught inside the transaction (a scan's unique-key clash is answered only
 * after the rollback), eligibility at the server-recorded receivedAt, and no
 * client time stored. Needs both settings and the QR secret (fail closed).
 */

import {
  classifyLecture,
  requireApprovalContext,
  requireEvidenceStartedAt,
} from "@/lib/attendance/config";
import { attendanceEligibilityAt, scanResultForEligibility } from "@/lib/attendance/eligibility";
import { qrScanOpensAt, qrScanWindowState } from "@/lib/attendance/evidence";
import {
  insertQrClosure,
  lockRegisterKeyShared,
  lockStudentShared,
  readQrClosure,
  runAttendanceTransaction,
  type AttendanceLocks,
} from "@/lib/attendance/locks";
import { attendanceError } from "@/lib/attendance/service-errors";
import { NORMAL_LECTURE_WHERE } from "@/lib/default-lecture";
import { prisma } from "@/lib/prisma";
import type { ApprovalHistoryContext } from "@/lib/student-confirmation-history";
import {
  deriveStudentQrToken,
  hashStudentQrToken,
  loadStudentQrSecret,
  parseStudentQrPayload,
  StudentQrConfigError,
  studentQrTokenHashesEqual,
} from "@/lib/student-qr-token";
import {
  applyEvidenceInTransaction,
  DELETED_STUDENT_STATUS,
  later,
  LINKED_EFFECTS,
  readEligibilityInputs,
  writeEvidenceAudit,
} from "@/services/lecture-attendance-evidence-service";
import { ensureRegister, inspectLectureForAttendance } from "@/services/lecture-attendance-service";

type Env = Record<string, string | undefined>;

export const CLIENT_SCAN_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export type QrScanInput = {
  teacherId: string;
  lectureId: string;
  /** The scanner's retry key: the same id is the same scan. */
  clientScanId: string;
  /** The scanned QR text. */
  payload: unknown;
};

export type QrScanOutcome = {
  scanEventId: string;
  result: string;
  effect: string;
  afterFinalization: boolean;
  receivedAt: Date;
  /** Only for this teacher's own students. */
  student: { id: string; name: string; registrationNumber: string | null } | null;
  attendance: { status: string; statusSource: string; pendingReview: boolean; version: number } | null;
  /** True when this request repeated an already stored scan (same clientScanId). */
  replayed: boolean;
};

type ScanIdentity =
  | { kind: "STUDENT"; studentId: string; qrTokenId: string; hash: string }
  | { kind: "INVALID_QR"; studentId: string | null; qrTokenId: string | null; hash: string | null }
  | { kind: "QR_UNVERIFIABLE"; qrTokenId: string; hash: string }
  | { kind: "WRONG_TEACHER" };

/** The hash a scan event stores for this identity (never another teacher's). */
function storedHashOf(identity: ScanIdentity): string | null {
  return identity.kind === "WRONG_TEACHER" ? null : identity.hash;
}

/**
 * Who a payload identifies, for THIS teacher (read only, before the
 * transaction; the student and the token are re-checked under the Student
 * lock). Another teacher's token (revoked, deleted or not) keeps no identity
 * and no hash: storing either would identify that teacher's student.
 */
async function resolveScanIdentity(payload: unknown, teacherId: string, secret: Buffer): Promise<ScanIdentity> {
  const token = parseStudentQrPayload(payload);
  if (!token) return { kind: "INVALID_QR", studentId: null, qrTokenId: null, hash: null };

  const hash = hashStudentQrToken(token);
  const row = await prisma.studentQrToken.findUnique({
    where: { tokenHash: hash },
    select: { id: true, nonce: true, tokenHash: true, revokedAt: true, studentId: true, student: { select: { teacherId: true, status: true } } },
  });

  if (!row) return { kind: "INVALID_QR", studentId: null, qrTokenId: null, hash };
  if (row.student.teacherId !== teacherId) return { kind: "WRONG_TEACHER" };
  if (row.revokedAt !== null || row.student.status === DELETED_STUDENT_STATUS) {
    return { kind: "INVALID_QR", studentId: row.studentId, qrTokenId: row.id, hash };
  }

  let expected: string | null = null;
  try {
    expected = hashStudentQrToken(deriveStudentQrToken(secret, row.id, row.nonce));
  } catch {
    expected = null; // a stored row that cannot be derived does not verify
  }
  if (!expected || !studentQrTokenHashesEqual(expected, row.tokenHash) || !studentQrTokenHashesEqual(expected, hash)) {
    return { kind: "QR_UNVERIFIABLE", qrTokenId: row.id, hash };
  }

  return { kind: "STUDENT", studentId: row.studentId, qrTokenId: row.id, hash };
}

function loadQrSecret(env: Env): Buffer {
  try {
    return loadStudentQrSecret(env as NodeJS.ProcessEnv);
  } catch (error) {
    if (error instanceof StudentQrConfigError) throw attendanceError("STUDENT_QR_NOT_CONFIGURED");
    throw error;
  }
}

/**
 * Records one QR scan by the lecture's teacher and applies it as evidence.
 *
 * Before any transaction: input checks; both settings and the QR secret
 * (503, nothing recorded); the teacher owns the lecture (404, nothing
 * recorded); the payload's identity; and the retry key: a stored scan with
 * this clientScanId is returned as it is (`replayed`), or 409
 * ATTENDANCE_SCAN_ID_REUSED when it was a different scan (other lecture or
 * token).
 *
 * In one transaction (recordScanInTransaction): the Student FOR SHARE (own
 * student only) with its token re-checked; the lecture re-checked under its
 * lock (deleted / cancelled: LECTURE_UNAVAILABLE); HISTORICAL lectures:
 * 409 ATTENDANCE_LECTURE_HISTORICAL, nothing recorded; the register held
 * FOR KEY SHARE, then the QR window: 409 ATTENDANCE_QR_CLOSED once the
 * teacher closed it, 409 ATTENDANCE_QR_NOT_OPEN before the scheduled start
 * minus 30 minutes (nothing recorded for either); eligibility at
 * receivedAt; for VALID scans the register and the record (planEvidence);
 * then the scan event and the audit row. A concurrent identical submission
 * loses on the unique key, its transaction rolls back, and it returns the
 * stored outcome.
 */
export async function recordQrScan(input: QrScanInput, options: { env?: Env } = {}): Promise<QrScanOutcome> {
  const { teacherId, lectureId, clientScanId } = input;

  if (typeof teacherId !== "string" || teacherId === "" || typeof lectureId !== "string" || lectureId === "") {
    throw attendanceError("VALIDATION_ERROR");
  }
  if (typeof clientScanId !== "string" || !CLIENT_SCAN_ID_PATTERN.test(clientScanId)) {
    throw attendanceError("VALIDATION_ERROR", { field: "clientScanId" });
  }

  const receivedAt = new Date();
  const env = options.env ?? process.env;
  const context = requireApprovalContext(env);
  const evidenceStartedAt = requireEvidenceStartedAt(env);
  const secret = loadQrSecret(env);

  const owned = await prisma.lecture.findFirst({ where: { id: lectureId, ...NORMAL_LECTURE_WHERE, class: { teacherId } }, select: { id: true } });
  if (!owned) throw attendanceError("LECTURE_NOT_FOUND");

  const identity = await resolveScanIdentity(input.payload, teacherId, secret);
  const storedHash = storedHashOf(identity);

  const stored = await findStoredScan(teacherId, clientScanId);
  if (stored) return replayOrConflict(stored, lectureId, storedHash);

  let scanEventId: string;
  try {
    scanEventId = await runAttendanceTransaction((locks) =>
      recordScanInTransaction(locks, { teacherId, lectureId, clientScanId, identity, receivedAt, context, evidenceStartedAt })
    );
  } catch (error) {
    // The transaction has already rolled back. A unique-key clash means an
    // identical submission won the race: answer with what it stored.
    if (isUniqueViolation(error)) {
      const winner = await findStoredScan(teacherId, clientScanId);
      if (winner) return replayOrConflict(winner, lectureId, storedHash);
    }
    throw error;
  }

  return presentScan(scanEventId, false);
}

async function recordScanInTransaction(
  locks: AttendanceLocks,
  ctx: {
    teacherId: string;
    lectureId: string;
    clientScanId: string;
    identity: ScanIdentity;
    receivedAt: Date;
    context: ApprovalHistoryContext;
    evidenceStartedAt: Date;
  }
): Promise<string> {
  let identity = ctx.identity;

  // 1. Student (own students only), and its token re-checked under that lock
  //    (revocation and decisions lock the student row).
  let student: Awaited<ReturnType<typeof lockStudentShared>> = null;
  if (identity.kind === "STUDENT") {
    student = await lockStudentShared(locks, identity.studentId);
    const token = await locks.db.studentQrToken.findUnique({
      where: { id: identity.qrTokenId },
      select: { studentId: true, revokedAt: true },
    });

    if (!student || !token || token.studentId !== student.id) {
      identity = { kind: "INVALID_QR", studentId: null, qrTokenId: null, hash: identity.hash };
    } else if (student.teacherId !== ctx.teacherId) {
      identity = { kind: "WRONG_TEACHER" };
    } else if (token.revokedAt !== null || student.status === DELETED_STUDENT_STATUS) {
      identity = { kind: "INVALID_QR", studentId: identity.studentId, qrTokenId: identity.qrTokenId, hash: identity.hash };
    }
  }

  // 2. The lecture under its lock (W3).
  const found = await inspectLectureForAttendance(locks, ctx.lectureId);
  if (found.state === "NOT_FOUND" || found.cls.teacherId !== ctx.teacherId) throw attendanceError("LECTURE_NOT_FOUND");

  const register = await lockRegisterKeyShared(locks, ctx.lectureId);
  const afterFinalization = register?.finalizedAt != null;
  const now = later(new Date(), ctx.receivedAt);

  const base = {
    lectureId: ctx.lectureId,
    classId: found.lecture.classId,
    classSessionId: null,
    scannedByTeacherId: ctx.teacherId,
    clientScanId: ctx.clientScanId,
    clientScannedAt: null,
    receivedAt: ctx.receivedAt,
  };
  const identityColumns = (id: ScanIdentity) =>
    id.kind === "WRONG_TEACHER"
      ? { studentId: null, qrTokenId: null, scannedTokenHash: null }
      : id.kind === "QR_UNVERIFIABLE"
        ? { studentId: null, qrTokenId: id.qrTokenId, scannedTokenHash: id.hash }
        : { studentId: id.studentId, qrTokenId: id.qrTokenId, scannedTokenHash: id.hash };

  const recordOnly = async (result: "INVALID_QR" | "QR_UNVERIFIABLE" | "WRONG_TEACHER" | "LECTURE_UNAVAILABLE") => {
    locks.beginWrites();
    const event = await locks.db.attendanceScanEvent.create({
      data: { ...base, ...identityColumns(identity), result, effect: "NONE", eligibilityReason: null, afterFinalization, lectureAttendanceId: null },
      select: { id: true },
    });
    return event.id;
  };

  // 3. Lecture availability, then the LIVE / HISTORICAL boundary, then the token.
  if (found.state !== "OK") return recordOnly("LECTURE_UNAVAILABLE");

  const start = register?.scheduledStartAt ?? found.lecture.date;
  if (classifyLecture(start, ctx.evidenceStartedAt) === "HISTORICAL") throw attendanceError("ATTENDANCE_LECTURE_HISTORICAL");

  // 4. The register (created when needed), held FOR KEY SHARE. The closure
  //    holds it FOR UPDATE, so every accepted scan is serialized with the
  //    closure: a scan that gets the lock after a closure committed sees it.
  //    Then the window: the register's start (the authoritative schedule:
  //    frozen once finalized, otherwise kept in step with the lecture by the
  //    schedule sync, Stage 5.4e; the same start PRESENT / LATE uses), minus
  //    30 minutes; open until closed (the scheduled end never closes it).
  //    Rejected scans record nothing.
  const ensured = await ensureRegister(locks, ctx.lectureId, {
    mode: "KEY_SHARE",
    now,
    actor: { role: "SYSTEM" },
    teacherId: ctx.teacherId,
  });
  const closure = await readQrClosure(locks, ctx.lectureId);
  const windowStart = ensured.register.scheduledStartAt;
  const window = qrScanWindowState({ scheduledStartAt: windowStart, closed: closure !== null, receivedAt: ctx.receivedAt });
  if (window === "CLOSED") throw attendanceError("ATTENDANCE_QR_CLOSED");
  if (window === "NOT_OPEN") {
    throw attendanceError("ATTENDANCE_QR_NOT_OPEN", { opensAt: qrScanOpensAt(windowStart).toISOString() });
  }

  if (identity.kind !== "STUDENT" || !student) return recordOnly(identity.kind === "STUDENT" ? "INVALID_QR" : identity.kind);

  // 4. Eligibility at the server-recorded scan time.
  const { history, enrolments } = await readEligibilityInputs(locks, student.id, found.lecture.classId);
  const eligibility = attendanceEligibilityAt({
    student,
    history,
    enrolments,
    classId: found.lecture.classId,
    instant: ctx.receivedAt,
    context: ctx.context,
  });
  const { result, eligibilityReason } = scanResultForEligibility(eligibility);

  if (result !== "VALID") {
    locks.beginWrites();
    const event = await locks.db.attendanceScanEvent.create({
      data: { ...base, ...identityColumns(identity), result, effect: "NONE", eligibilityReason, afterFinalization, lectureAttendanceId: null },
      select: { id: true },
    });
    return event.id;
  }

  // 5. VALID: the record (the register is already held).
  const applied = await applyEvidenceInTransaction(locks, {
    register: ensured.register,
    lectureId: ctx.lectureId,
    classId: found.lecture.classId,
    studentId: student.id,
    channel: "QR",
    serverRecordedAt: ctx.receivedAt,
    now,
  });

  // 6. The scan event (it references the record), then the audit (it references the scan).
  const event = await locks.db.attendanceScanEvent.create({
    data: {
      ...base,
      ...identityColumns(identity),
      result: "VALID",
      effect: applied.plan.effect,
      eligibilityReason,
      afterFinalization: applied.plan.afterFinalization,
      lectureAttendanceId: LINKED_EFFECTS.has(applied.plan.effect) ? applied.recordId : null,
    },
    select: { id: true },
  });
  await writeEvidenceAudit(locks, applied, { lectureId: ctx.lectureId, studentId: student.id, now, scanEventId: event.id });
  return event.id;
}

type StoredScan = { id: string; lectureId: string; scannedTokenHash: string | null };

function findStoredScan(teacherId: string, clientScanId: string): Promise<StoredScan | null> {
  return prisma.attendanceScanEvent.findUnique({
    where: { scannedByTeacherId_clientScanId: { scannedByTeacherId: teacherId, clientScanId } },
    select: { id: true, lectureId: true, scannedTokenHash: true },
  });
}

/** The same scan again: its stored outcome. A different scan under the same id: 409. */
async function replayOrConflict(stored: StoredScan, lectureId: string, hash: string | null): Promise<QrScanOutcome> {
  const sameHash =
    stored.scannedTokenHash === null || hash === null ? stored.scannedTokenHash === hash : studentQrTokenHashesEqual(stored.scannedTokenHash, hash);
  if (stored.lectureId !== lectureId || !sameHash) throw attendanceError("ATTENDANCE_SCAN_ID_REUSED");
  return presentScan(stored.id, true);
}

async function presentScan(scanEventId: string, replayed: boolean): Promise<QrScanOutcome> {
  const event = await prisma.attendanceScanEvent.findUnique({
    where: { id: scanEventId },
    select: {
      id: true,
      result: true,
      effect: true,
      afterFinalization: true,
      receivedAt: true,
      student: { select: { id: true, name: true, registrationNumber: true } },
      attendance: { select: { status: true, statusSource: true, pendingReviewSince: true, version: true } },
    },
  });
  if (!event) throw new Error("Attendance: the scan event is missing.");

  return {
    scanEventId: event.id,
    result: event.result,
    effect: event.effect,
    afterFinalization: event.afterFinalization,
    receivedAt: event.receivedAt,
    student: event.student,
    attendance: event.attendance
      ? {
          status: event.attendance.status,
          statusSource: event.attendance.statusSource,
          pendingReview: event.attendance.pendingReviewSince !== null,
          version: event.attendance.version,
        }
      : null,
    replayed,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "PrismaClientKnownRequestError" &&
    (error as Error & { code?: unknown }).code === "P2002"
  );
}

// =========================================================================================
// Closing QR attendance (teacher, permanent)
// =========================================================================================

export type QrAttendanceClosureResult = {
  lectureId: string;
  closedAt: Date;
  closedByTeacherId: string;
  /** True when it was already closed (a retry): nothing was written. */
  alreadyClosed: boolean;
};

/**
 * Closes QR attendance for the lecture: no QR scan is accepted after this
 * commits (the scheduled end never closes it by itself). Teacher-only (404
 * for another teacher's or a deleted lecture; 409 LECTURE_CANCELLED for a
 * cancelled one); allowed before or after finalization; needs no
 * configuration. Permanent: there is no reopening (the database refuses any
 * change or removal of the row).
 *
 * One transaction: the Lecture FOR SHARE and Class FOR KEY SHARE (re-checked),
 * the register FOR UPDATE (created when needed; waits for every scan holding
 * it FOR KEY SHARE, and blocks new ones until this commits), then the closure
 * row (who, when: server time), which is also its audit record. A retry, or a
 * concurrent closure, finds the row and returns it without writing.
 */
export async function closeQrAttendance(input: { teacherId: string; lectureId: string }): Promise<QrAttendanceClosureResult> {
  if (typeof input.teacherId !== "string" || input.teacherId === "" || typeof input.lectureId !== "string" || input.lectureId === "") {
    throw attendanceError("VALIDATION_ERROR");
  }
  return runAttendanceTransaction((locks) => closeQrInTransaction(locks, input));
}

async function closeQrInTransaction(
  locks: AttendanceLocks,
  input: { teacherId: string; lectureId: string }
): Promise<QrAttendanceClosureResult> {
  const now = new Date();
  const { register } = await ensureRegister(locks, input.lectureId, {
    mode: "UPDATE",
    now,
    actor: { role: "TEACHER", teacherId: input.teacherId },
    teacherId: input.teacherId,
  });

  const existing = await readQrClosure(locks, input.lectureId);
  if (existing) {
    return { lectureId: existing.lectureId, closedAt: existing.closedAt, closedByTeacherId: existing.closedByTeacherId, alreadyClosed: true };
  }

  locks.beginWrites();
  const inserted = await insertQrClosure(locks, {
    lectureId: input.lectureId,
    classId: register.classId,
    closedAt: now,
    closedByTeacherId: input.teacherId,
  });
  if (!inserted) throw new Error("Attendance: the QR closure appeared while the register was held exclusively.");

  return { lectureId: input.lectureId, closedAt: now, closedByTeacherId: input.teacherId, alreadyClosed: false };
}

