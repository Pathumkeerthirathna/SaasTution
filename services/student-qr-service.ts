import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import {
  StudentQrConfigError,
  buildStudentQrPayload,
  deriveStudentQrToken,
  deriveVerifiedStudentQrToken,
  generateStudentQrNonce,
  hashStudentQrToken,
  loadStudentQrSecret,
  parseStudentQrPayload,
  studentQrTokenHashesEqual,
} from "@/lib/student-qr-token";

/**
 * Student QR identity tokens: database service (docs/student-qr-identity.md).
 *
 * - The raw token is never stored, returned only to the caller that renders
 *   the QR, and never logged. Only `nonce` + `tokenHash` are persisted.
 * - Timestamps are real UTC `Date`s from the application (no DB defaults).
 * - Issuance and regeneration lock the Student row (SELECT ... FOR NO KEY
 *   UPDATE), so concurrent requests for one student run one after another;
 *   the partial unique index (one active token per student) is the backstop.
 * - A token that no longer matches its stored hash (STUDENT_QR_SECRET
 *   changed) is NEVER silently reissued: callers get QR_TOKEN_UNVERIFIABLE
 *   until an administrator runs the explicit reissue operation.
 * - Authorization (who may act for which student) is enforced by the routes
 *   (T5/T6) AND re-checked here: a STUDENT actor only for itself, a TEACHER
 *   actor only for a student it owns; anything else looks like "not found".
 */

export const STUDENT_QR_REGENERATION_LIMIT = 5;
export const STUDENT_QR_REGENERATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Students with status 2 are deleted; 0 (active) and 1 (inactive) keep their QR. */
const DELETED_STUDENT_STATUS = 2;

export type StudentQrActor =
  | { role: "STUDENT"; id: string }
  | { role: "TEACHER"; id: string }
  | { role: "SYSTEM" };

export type StudentQrErrorCode =
  | "STUDENT_NOT_FOUND"
  | "QR_TOKEN_NOT_FOUND"
  | "QR_REGENERATION_LIMIT"
  | "STUDENT_QR_NOT_CONFIGURED"
  | "QR_TOKEN_UNVERIFIABLE"
  | "INVALID_QR_PAYLOAD"
  | "INVALID_QR_ACTOR";

const ERRORS: Record<StudentQrErrorCode, { status: number; message: string }> = {
  STUDENT_NOT_FOUND: { status: 404, message: "Student not found." },
  QR_TOKEN_NOT_FOUND: { status: 404, message: "This student has no active QR code yet." },
  QR_REGENERATION_LIMIT: {
    status: 429,
    message: `A QR code can be regenerated at most ${STUDENT_QR_REGENERATION_LIMIT} times in 24 hours.`,
  },
  STUDENT_QR_NOT_CONFIGURED: { status: 503, message: "Student QR codes are not configured on this server." },
  QR_TOKEN_UNVERIFIABLE: {
    status: 503,
    message: "This QR code can no longer be verified. An administrator must reissue student QR codes.",
  },
  INVALID_QR_PAYLOAD: { status: 400, message: "This QR code is not valid." },
  INVALID_QR_ACTOR: { status: 400, message: "Invalid QR request." },
};

/**
 * Typed service error (an AppError, so routes answer it with its status and
 * safe message). `internalReason` is for server logs only; it never contains
 * a token, nonce, hash or secret.
 */
export class StudentQrServiceError extends AppError {
  readonly code: StudentQrErrorCode;
  readonly internalReason?: string;

  constructor(code: StudentQrErrorCode, options: { details?: unknown; internalReason?: string } = {}) {
    super(ERRORS[code].message, ERRORS[code].status, code, options.details);
    this.name = "StudentQrServiceError";
    this.code = code;
    this.internalReason = options.internalReason;
  }
}

export type StudentQrRegenerationLimitDetails = {
  limit: number;
  retryAfterSeconds: number;
  /** ISO UTC instant when the next regeneration becomes possible. */
  retryAt: string;
};

export type ActiveStudentQr = {
  /** The bearer token. Render it; never log it or put it in a URL. */
  token: string;
  /** "SLCQR1:<token>": the text to encode in the QR image. */
  payload: string;
  reason: "ISSUE" | "REGENERATE" | "SYSTEM_REISSUE";
  createdAt: Date;
};

export type StudentQrStatus = {
  configured: boolean;
  hasActiveToken: boolean;
  activeSince: Date | null;
  regenerationLimit: number;
  regenerationsUsed: number;
  regenerationsRemaining: number;
  /** When the next regeneration is allowed again; null when one is allowed now. */
  nextRegenerationAt: Date | null;
};

/** What a future scanner gets: the minimum to identify and authorize. */
export type ResolvedStudentQr = {
  studentId: string;
  teacherId: string;
  name: string;
  registrationNumber: string | null;
  isActive: boolean;
};

type Tx = Prisma.TransactionClient;
type LockedStudent = { id: string; teacherId: string; status: number };

const ACTIVE_TOKEN_SELECT = { id: true, nonce: true, tokenHash: true, reason: true, createdAt: true } as const;

// ---------------------------------------------------------------- public API

/**
 * READ-ONLY (GET image routes): the student's active QR token, or
 * QR_TOKEN_NOT_FOUND when none was issued yet. Never writes, never issues,
 * never reissues (a token that fails verification is QR_TOKEN_UNVERIFIABLE).
 * Same actor / ownership rules as the writing operations.
 */
export async function getActiveToken(studentId: string, actor: StudentQrActor): Promise<ActiveStudentQr> {
  assertStudentId(studentId);
  assertActor(actor);
  const secret = loadSecret();

  const student = await prisma.student.findFirst({
    where: { id: studentId, status: { not: DELETED_STUDENT_STATUS } },
    select: { id: true, teacherId: true },
  });
  if (!student || !actorMayAct(actor, student)) throw new StudentQrServiceError("STUDENT_NOT_FOUND");

  const active = await findActiveToken(prisma, studentId);
  if (!active) throw new StudentQrServiceError("QR_TOKEN_NOT_FOUND");
  return present(secret, active);
}

/**
 * Explicit issuance (POST routes): the student's active QR token, issuing the
 * first one (reason ISSUE) if the student has none. Idempotent: later calls
 * return the same token. Never replaces an existing token, not even when it
 * fails verification. ISSUE never counts towards the regeneration limit.
 */
export async function getOrCreateActiveToken(studentId: string, actor: StudentQrActor): Promise<ActiveStudentQr> {
  assertStudentId(studentId);
  assertActor(actor);
  const secret = loadSecret();

  // Fast path: an active token already exists (no lock, no write).
  const student = await prisma.student.findFirst({
    where: { id: studentId, status: { not: DELETED_STUDENT_STATUS } },
    select: { id: true, teacherId: true },
  });
  if (!student || !actorMayAct(actor, student)) throw new StudentQrServiceError("STUDENT_NOT_FOUND");

  const existing = await findActiveToken(prisma, studentId);
  if (existing) return present(secret, existing);

  try {
    const row = await prisma.$transaction(async (tx) => {
      const locked = await lockStudent(tx, studentId);
      if (!locked || !actorMayAct(actor, locked)) throw new StudentQrServiceError("STUDENT_NOT_FOUND");

      // Another request may have issued while we waited for the lock.
      const current = await findActiveToken(tx, studentId);
      if (current) return current;

      return createToken(tx, secret, studentId, "ISSUE", actor, new Date());
    });
    return present(secret, row);
  } catch (error) {
    // Backstop: the partial unique index refused a second active token.
    if (isUniqueViolation(error)) {
      const winner = await findActiveToken(prisma, studentId);
      if (winner) return present(secret, winner);
    }
    throw sanitizeWriteError(error);
  }
}

/**
 * Replaces the active token (reason REGENERATE) in one transaction: lock the
 * student, enforce 5 successful regenerations per rolling 24 hours (student
 * and teacher requests combined), revoke the active token with all audit
 * fields, insert the replacement. Either both writes commit or neither.
 */
export async function regenerateToken(studentId: string, actor: StudentQrActor): Promise<ActiveStudentQr> {
  assertStudentId(studentId);
  assertActor(actor);
  if (actor.role === "SYSTEM") {
    // System replacements are SYSTEM_REISSUE (explicit admin operation), never REGENERATE.
    throw new StudentQrServiceError("INVALID_QR_ACTOR", { internalReason: "system actor cannot regenerate" });
  }
  const secret = loadSecret();

  let row;
  try {
    row = await prisma.$transaction((tx) => regenerateInTransaction(tx, secret, studentId, actor));
  } catch (error) {
    throw sanitizeWriteError(error);
  }
  return present(secret, row);
}

async function regenerateInTransaction(
  tx: Tx,
  secret: Buffer,
  studentId: string,
  actor: Extract<StudentQrActor, { id: string }>
) {
  const locked = await lockStudent(tx, studentId);
  if (!locked || !actorMayAct(actor, locked)) throw new StudentQrServiceError("STUDENT_NOT_FOUND");

  const now = new Date();
  const recent = await recentRegenerations(tx, studentId, now);
  if (recent.length >= STUDENT_QR_REGENERATION_LIMIT) {
    throw new StudentQrServiceError("QR_REGENERATION_LIMIT", {
      details: limitDetails(recent[0].createdAt, now),
    });
  }

  const active = await findActiveToken(tx, studentId);
  if (!active) throw new StudentQrServiceError("QR_TOKEN_NOT_FOUND");

  // revokedAt >= createdAt is a CHECK; guard against a clock step backwards.
  const revokedAt = active.createdAt > now ? active.createdAt : now;
  const revoked = await tx.studentQrToken.updateMany({
    where: { id: active.id, revokedAt: null },
    data: {
      revokedAt,
      revokedByRole: actor.role,
      revokedById: actor.id,
      revokedReason: "REGENERATE",
    },
  });
  if (revoked.count !== 1) throw new StudentQrServiceError("QR_TOKEN_NOT_FOUND");

  return createToken(tx, secret, studentId, "REGENERATE", actor, revokedAt);
}

/** Regeneration quota and whether a QR exists. Never returns token material. */
export async function getQrStatus(studentId: string): Promise<StudentQrStatus> {
  assertStudentId(studentId);
  const student = await prisma.student.findFirst({
    where: { id: studentId, status: { not: DELETED_STUDENT_STATUS } },
    select: { id: true },
  });
  if (!student) throw new StudentQrServiceError("STUDENT_NOT_FOUND");

  const now = new Date();
  const [active, recent] = await Promise.all([
    prisma.studentQrToken.findFirst({
      where: { studentId, revokedAt: null },
      select: { createdAt: true },
    }),
    recentRegenerations(prisma, studentId, now),
  ]);
  const used = recent.length;
  return {
    configured: isSecretConfigured(),
    hasActiveToken: Boolean(active),
    activeSince: active?.createdAt ?? null,
    regenerationLimit: STUDENT_QR_REGENERATION_LIMIT,
    regenerationsUsed: used,
    regenerationsRemaining: Math.max(0, STUDENT_QR_REGENERATION_LIMIT - used),
    nextRegenerationAt:
      used >= STUDENT_QR_REGENERATION_LIMIT
        ? new Date(recent[0].createdAt.getTime() + STUDENT_QR_REGENERATION_WINDOW_MS)
        : null,
  };
}

/**
 * Resolves a scanned payload to the student it identifies. Unknown,
 * revoked and malformed payloads all fail as INVALID_QR_PAYLOAD (the
 * distinction stays in internalReason). A stored token that no longer
 * verifies under the current secret fails as QR_TOKEN_UNVERIFIABLE and is
 * never reissued here.
 */
export async function resolveQrPayload(payload: unknown): Promise<ResolvedStudentQr> {
  const token = parseStudentQrPayload(payload);
  if (!token) throw new StudentQrServiceError("INVALID_QR_PAYLOAD", { internalReason: "malformed" });
  const secret = loadSecret();

  const scannedHash = hashStudentQrToken(token);
  const row = await prisma.studentQrToken.findUnique({
    where: { tokenHash: scannedHash },
    select: {
      id: true,
      nonce: true,
      tokenHash: true,
      revokedAt: true,
      student: {
        select: { id: true, teacherId: true, name: true, registrationNumber: true, status: true },
      },
    },
  });
  if (!row) throw new StudentQrServiceError("INVALID_QR_PAYLOAD", { internalReason: "unknown" });
  if (row.revokedAt !== null) throw new StudentQrServiceError("INVALID_QR_PAYLOAD", { internalReason: "revoked" });
  if (row.student.status === DELETED_STUDENT_STATUS) {
    throw new StudentQrServiceError("INVALID_QR_PAYLOAD", { internalReason: "student deleted" });
  }

  const expectedHash = hashStudentQrToken(deriveStudentQrToken(secret, row.id, row.nonce));
  if (!studentQrTokenHashesEqual(expectedHash, row.tokenHash) || !studentQrTokenHashesEqual(expectedHash, scannedHash)) {
    throw new StudentQrServiceError("QR_TOKEN_UNVERIFIABLE", { internalReason: "secret mismatch" });
  }

  return {
    studentId: row.student.id,
    teacherId: row.student.teacherId,
    name: row.student.name,
    registrationNumber: row.student.registrationNumber,
    isActive: row.student.status === 0,
  };
}

// ---------------------------------------------------------------- internals

function loadSecret(): Buffer {
  try {
    return loadStudentQrSecret();
  } catch (error) {
    if (error instanceof StudentQrConfigError) {
      throw new StudentQrServiceError("STUDENT_QR_NOT_CONFIGURED", { internalReason: error.detail });
    }
    throw error;
  }
}

function isSecretConfigured(): boolean {
  try {
    loadStudentQrSecret();
    return true;
  } catch {
    return false;
  }
}

function assertStudentId(studentId: unknown): asserts studentId is string {
  if (typeof studentId !== "string" || studentId.trim() === "" || studentId.length > 191) {
    throw new StudentQrServiceError("STUDENT_NOT_FOUND");
  }
}

function assertActor(actor: unknown): asserts actor is StudentQrActor {
  const value = actor as { role?: unknown; id?: unknown } | null;
  const valid =
    typeof value === "object" &&
    value !== null &&
    (value.role === "SYSTEM"
      ? value.id === undefined
      : (value.role === "STUDENT" || value.role === "TEACHER") &&
        typeof value.id === "string" &&
        value.id.trim() !== "" &&
        value.id.length <= 191);
  if (!valid) throw new StudentQrServiceError("INVALID_QR_ACTOR");
}

function actorMayAct(actor: StudentQrActor, student: { id: string; teacherId: string }): boolean {
  if (actor.role === "STUDENT") return actor.id === student.id;
  if (actor.role === "TEACHER") return actor.id === student.teacherId;
  return true;
}

/**
 * FOR NO KEY UPDATE: conflicts with itself (and FOR UPDATE / FOR SHARE /
 * updates of the row), so QR operations of one student are serialised, but
 * NOT with the FOR KEY SHARE lock that foreign-key inserts take on the
 * referenced Student (attendance, payments, login history ... keep flowing).
 */
async function lockStudent(tx: Tx, studentId: string): Promise<LockedStudent | null> {
  const rows = await tx.$queryRaw<LockedStudent[]>`
    SELECT "id", "teacherId", "status" FROM "Student" WHERE "id" = ${studentId} FOR NO KEY UPDATE`;
  const student = rows[0];
  return student && student.status !== DELETED_STUDENT_STATUS ? student : null;
}

function findActiveToken(db: Tx, studentId: string) {
  return db.studentQrToken.findFirst({ where: { studentId, revokedAt: null }, select: ACTIVE_TOKEN_SELECT });
}

/** Successful REGENERATE rows in the rolling window, oldest first. */
function recentRegenerations(db: Tx, studentId: string, now: Date) {
  return db.studentQrToken.findMany({
    where: {
      studentId,
      reason: "REGENERATE",
      createdAt: { gt: new Date(now.getTime() - STUDENT_QR_REGENERATION_WINDOW_MS) },
    },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
}

function limitDetails(oldestInWindow: Date, now: Date): StudentQrRegenerationLimitDetails {
  const retryAt = new Date(oldestInWindow.getTime() + STUDENT_QR_REGENERATION_WINDOW_MS);
  return {
    limit: STUDENT_QR_REGENERATION_LIMIT,
    retryAfterSeconds: Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000)),
    retryAt: retryAt.toISOString(),
  };
}

async function createToken(
  tx: Tx,
  secret: Buffer,
  studentId: string,
  reason: "ISSUE" | "REGENERATE",
  actor: StudentQrActor,
  createdAt: Date
) {
  const id = randomUUID();
  const nonce = generateStudentQrNonce();
  const tokenHash = hashStudentQrToken(deriveStudentQrToken(secret, id, nonce));
  return tx.studentQrToken.create({
    data: {
      id,
      studentId,
      nonce,
      tokenHash,
      reason,
      createdAt,
      createdByRole: actor.role,
      createdById: actor.role === "SYSTEM" ? null : actor.id,
    },
    select: ACTIVE_TOKEN_SELECT,
  });
}

function present(
  secret: Buffer,
  row: { id: string; nonce: string; tokenHash: string; reason: ActiveStudentQr["reason"]; createdAt: Date }
): ActiveStudentQr {
  const token = deriveVerifiedStudentQrToken(secret, row);
  if (!token) throw new StudentQrServiceError("QR_TOKEN_UNVERIFIABLE", { internalReason: "secret mismatch" });
  return { token, payload: buildStudentQrPayload(token), reason: row.reason, createdAt: row.createdAt };
}

/**
 * Database errors on StudentQrToken writes can carry PostgreSQL's
 * "Failing row contains (...)" detail, i.e. the nonce and tokenHash. Such
 * errors are replaced by a generic one (keeping only the error code) so they
 * cannot reach route error logs. Service errors pass through unchanged.
 */
function sanitizeWriteError(error: unknown): unknown {
  if (error instanceof StudentQrServiceError) return error;
  const code =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : error instanceof Prisma.PrismaClientUnknownRequestError
        ? "unknown request error"
        : error instanceof Error
          ? error.name
          : "unknown";
  return new Error(`Student QR database write failed (${code}).`);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
