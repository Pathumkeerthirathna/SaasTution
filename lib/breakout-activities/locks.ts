// Database locks and transactions for Breakout Activities. Every lock here
// runs INSIDE an interactive transaction and is released when that
// transaction ends (commit or rollback); locks are refused on the top-level
// client, where they would be released immediately.
//
// Transactions: every breakout transaction goes through
// runBreakoutTransaction(), which applies BREAKOUT_TRANSACTION_OPTIONS
// (guarded by tests/breakout-activities/locks.test.cjs: no other
// `$transaction(` call in breakout code).
//
// Timeouts: a lock wait (BREAKOUT_LOCK_TIMEOUT_MS) always ends well before
// the transaction itself expires (BREAKOUT_TRANSACTION_OPTIONS.timeout), so
// a busy lock surfaces as a lock-timeout error (errors.ts -> 409
// BREAKOUT_BUSY), never as an expired transaction (P2028 -> 500).
//
// Lock order (always the same, so two transactions can never wait for each
// other in a cycle). A transaction may skip levels but never go back up:
//   1. the ClassSession row
//        - FOR KEY SHARE by every breakout write (create, publish, close,
//                     edit, draft, submit, quiz save, grading): many run at
//                     once, and they never wait for (or block) the frequent
//                     teacher-presence / Jibri UPDATEs of the session row,
//                     which take FOR NO KEY UPDATE;
//        - FOR UPDATE by session end / replacement (Step 5): conflicts with
//                     FOR KEY SHARE, so it waits until the running writes
//                     finish, and every later write then sees the session as
//                     ended (isActive = false). Every path that sets
//                     isActive = false must take this lock first: a plain
//                     UPDATE does not conflict with FOR KEY SHARE;
//   2. the activity row (BreakoutAssignment / BreakoutQuiz): FOR UPDATE by
//      the teacher (publish / close / edit / delete), FOR KEY SHARE by
//      student writes (see "Student writes" at the end of this file);
//   3. the advisory lock of one (assignment, student) pair, for a
//      submission: serializes one student's submissions to one assignment
//      (version numbers, isLatest flip);
//   4. quiz attempt rows (BreakoutQuizSubmission): FOR UPDATE, several always
//      in id order. Never lock an activity row after an attempt row.
// Levels 2-4 require the ActiveSessionLock that requireActiveSessionShared()
// returned for the SAME transaction (a branded type at compile time, checked
// again at run time), so the session lock always comes first.
//
// Only Breakout Activities use advisory locks in this codebase; the key
// namespace below keeps it that way if others are added later.

import type { Prisma, PrismaClient } from "@prisma/client";

import { breakoutError } from "./errors";

type Tx = Prisma.TransactionClient;

/** Upper bound for any breakout lock wait (SET LOCAL lock_timeout). */
export const BREAKOUT_LOCK_TIMEOUT_MS = 3_000;

/** Options of every breakout interactive transaction. */
export const BREAKOUT_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

/** Prefix of every breakout advisory-lock key. */
export const SUBMISSION_LOCK_NAMESPACE = "breakout-submission";

export type LockedSession = { id: string; classId: string; isActive: boolean };

declare const ACTIVE_SESSION_LOCK: unique symbol;

/**
 * Proof that this transaction holds the shared lock on a live session: only
 * requireActiveSessionShared() creates one. Required by every lock of levels
 * 2-4 (activity row, submission slot, attempt rows).
 */
export type ActiveSessionLock = Readonly<LockedSession> & { readonly [ACTIVE_SESSION_LOCK]: true };

// Each issued ActiveSessionLock -> the transaction it was taken in.
const issuedSessionLocks = new WeakMap<object, Tx>();

/**
 * Runs `fn` in an interactive transaction with BREAKOUT_TRANSACTION_OPTIONS.
 * The only way breakout code starts a transaction.
 */
export function runBreakoutTransaction<T>(client: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return client.$transaction(fn, BREAKOUT_TRANSACTION_OPTIONS);
}

function assertInTransaction(tx: Tx) {
  // The top-level PrismaClient has $transaction; a transaction client has not
  // (Prisma 5.22 hides it from the transaction client: `has` returns false).
  if (!tx || typeof tx !== "object" || "$transaction" in tx) {
    throw new Error("Breakout locks must be taken inside an interactive transaction.");
  }
}

/**
 * Bounds every lock wait of this transaction to BREAKOUT_LOCK_TIMEOUT_MS
 * (SET LOCAL: this transaction only). Internal and without a parameter, so
 * no caller can raise the timeout; run by every session lock before it locks.
 */
async function setBreakoutLockTimeout(tx: Tx): Promise<void> {
  assertInTransaction(tx);
  // SET cannot take a bind parameter; the value is a module constant.
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${BREAKOUT_LOCK_TIMEOUT_MS}ms'`);
}

async function lockSessionRow(tx: Tx, sessionId: string, mode: "share" | "update"): Promise<LockedSession | null> {
  assertInTransaction(tx);
  if (typeof sessionId !== "string" || sessionId === "") throw new TypeError("sessionId is required.");
  await setBreakoutLockTimeout(tx);
  const rows =
    mode === "share"
      ? await tx.$queryRaw<LockedSession[]>`SELECT "id", "classId", "isActive" FROM "ClassSession" WHERE "id" = ${sessionId} FOR KEY SHARE`
      : await tx.$queryRaw<LockedSession[]>`SELECT "id", "classId", "isActive" FROM "ClassSession" WHERE "id" = ${sessionId} FOR UPDATE`;
  return rows.length === 1 ? rows[0] : null;
}

/** Shared (FOR KEY SHARE) lock on the session row. Null when the session does not exist. */
export function lockSessionShared(tx: Tx, sessionId: string): Promise<LockedSession | null> {
  return lockSessionRow(tx, sessionId, "share");
}

/** Session end / replacement: exclusive lock on the session row. */
export function lockSessionExclusive(tx: Tx, sessionId: string): Promise<LockedSession | null> {
  return lockSessionRow(tx, sessionId, "update");
}

/**
 * Shared (FOR KEY SHARE) lock for a breakout write, and the session must be
 * live: 404 SESSION_NOT_FOUND, or 409 SESSION_NOT_ACTIVE once it has ended.
 */
export async function requireActiveSessionShared(tx: Tx, sessionId: string): Promise<ActiveSessionLock> {
  const session = await lockSessionShared(tx, sessionId);
  if (!session) throw breakoutError("SESSION_NOT_FOUND");
  if (!session.isActive) throw breakoutError("SESSION_NOT_ACTIVE");
  const lock = Object.freeze({ id: session.id, classId: session.classId, isActive: true }) as ActiveSessionLock;
  issuedSessionLocks.set(lock, tx);
  return lock;
}

/** Levels 2-4 of the lock order: the session lock of this same transaction comes first. */
function assertSessionLockHeld(tx: Tx, session: ActiveSessionLock, what: string) {
  assertInTransaction(tx);
  if (!session || typeof session !== "object" || issuedSessionLocks.get(session) !== tx) {
    throw new Error(`Take the session lock (requireActiveSessionShared) in this transaction before the ${what} lock.`);
  }
}

export type BreakoutActivityKind = "assignment" | "quiz";

export type LockedActivity = { id: string; state: "DRAFT" | "PUBLISHED" | "CLOSED"; status: number };

/**
 * Level 2: FOR UPDATE on one activity row of the locked session (publish,
 * close, edit, delete). Null when no such activity exists in this session:
 * an id from another session is never locked.
 */
export async function lockActivityForUpdate(
  tx: Tx,
  session: ActiveSessionLock,
  kind: BreakoutActivityKind,
  activityId: string
): Promise<LockedActivity | null> {
  assertSessionLockHeld(tx, session, "activity");
  if (typeof activityId !== "string" || activityId === "") throw new TypeError("activityId is required.");
  let rows: LockedActivity[];
  if (kind === "assignment") {
    rows = await tx.$queryRaw<LockedActivity[]>`SELECT "id", "state"::text AS "state", "status" FROM "BreakoutAssignment" WHERE "id" = ${activityId} AND "classSessionId" = ${session.id} FOR UPDATE`;
  } else if (kind === "quiz") {
    rows = await tx.$queryRaw<LockedActivity[]>`SELECT "id", "state"::text AS "state", "status" FROM "BreakoutQuiz" WHERE "id" = ${activityId} AND "classSessionId" = ${session.id} FOR UPDATE`;
  } else {
    throw new TypeError("Unknown activity kind.");
  }
  return rows.length === 1 ? rows[0] : null;
}

/**
 * Level 4: FOR UPDATE on every IN_PROGRESS attempt of a quiz in the locked
 * session, in id order (quiz close: auto-submit). Returns their ids.
 */
export async function lockInProgressAttemptsForUpdate(tx: Tx, session: ActiveSessionLock, quizId: string): Promise<string[]> {
  assertSessionLockHeld(tx, session, "attempt");
  if (typeof quizId !== "string" || quizId === "") throw new TypeError("quizId is required.");
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "BreakoutQuizSubmission" WHERE "quizId" = ${quizId} AND "classSessionId" = ${session.id} AND "attemptStatus" = 'IN_PROGRESS' ORDER BY "id" FOR UPDATE`;
  return rows.map((row) => row.id);
}

/**
 * Level 4: FOR UPDATE on one attempt of a quiz in the locked session
 * (grading override). Null when it is not an attempt of that quiz there.
 */
export async function lockQuizAttemptForUpdate(
  tx: Tx,
  session: ActiveSessionLock,
  quizId: string,
  submissionId: string
): Promise<{ id: string } | null> {
  assertSessionLockHeld(tx, session, "attempt");
  if (typeof quizId !== "string" || quizId === "" || typeof submissionId !== "string" || submissionId === "") {
    throw new TypeError("quizId and submissionId are required.");
  }
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "BreakoutQuizSubmission" WHERE "id" = ${submissionId} AND "quizId" = ${quizId} AND "classSessionId" = ${session.id} FOR UPDATE`;
  return rows.length === 1 ? rows[0] : null;
}

/** The advisory-lock key text of one (assignment, student) pair. */
export function submissionLockKey(assignmentId: string, studentId: string): string {
  if (typeof assignmentId !== "string" || assignmentId === "" || typeof studentId !== "string" || studentId === "") {
    throw new TypeError("assignmentId and studentId are required.");
  }
  return `${SUBMISSION_LOCK_NAMESPACE}:${assignmentId}:${studentId}`;
}

/**
 * Serializes submissions of one student to one assignment until the
 * transaction ends. `session` must be the lock requireActiveSessionShared()
 * returned in this same transaction (lock order above); the lock_timeout it
 * set also bounds this wait. hashtextextended maps the key to the 64-bit
 * advisory-lock space; two keys sharing a hash only serialize each other.
 */
export async function lockSubmissionSlot(tx: Tx, session: ActiveSessionLock, assignmentId: string, studentId: string): Promise<void> {
  assertSessionLockHeld(tx, session, "submission");
  const key = submissionLockKey(assignmentId, studentId);
  // $executeRaw: pg_advisory_xact_lock returns void, which $queryRaw cannot read.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

// ---- Student writes (Stage 3) -------------------------------------------------
// A student write locks, in this order (approved decision D4):
//   1. the session row FOR KEY SHARE (requireActiveSessionShared, through
//      student-access.ts: lockEnrolledActiveSession);
//   2. the assignment / quiz row FOR KEY SHARE (lockActivityShared): many
//      students at once, but it conflicts with the teacher's FOR UPDATE, so a
//      teacher close / edit waits for in-flight student writes, and student
//      writes after it see the new state;
//   3. assignment: the (assignment, student) advisory lock
//      (lockStudentSubmissionSlot); quiz: the student's own attempt row FOR
//      UPDATE (lockOwnQuizAttemptForUpdate).
// Step 3 needs the share lock of step 2 (a branded token, checked again at
// run time), so the quiz row is always locked BEFORE an attempt row, never
// after: no cycle with the teacher's close (quiz FOR UPDATE, then attempts).

declare const ACTIVITY_SHARE_LOCK: unique symbol;

type SharedActivityFields = {
  id: string;
  classSessionId: string;
  state: "DRAFT" | "PUBLISHED" | "CLOSED";
  status: number;
  targetRoomType: "MAIN" | "BREAKOUT";
  targetRoomId: string | null;
};

/** Proof that this transaction holds FOR KEY SHARE on this assignment row. */
export type AssignmentShareLock = Readonly<SharedActivityFields & { kind: "assignment" }> & { readonly [ACTIVITY_SHARE_LOCK]: "assignment" };
/** Proof that this transaction holds FOR KEY SHARE on this quiz row. */
export type QuizShareLock = Readonly<SharedActivityFields & { kind: "quiz" }> & { readonly [ACTIVITY_SHARE_LOCK]: "quiz" };

type ShareLockFor<K extends BreakoutActivityKind> = K extends "assignment" ? AssignmentShareLock : QuizShareLock;

// Each issued activity share lock -> the transaction it was taken in.
const issuedActivityLocks = new WeakMap<object, Tx>();

/**
 * Level 2 for a student write: FOR KEY SHARE on one activity row of the
 * locked session, with what the room / state checks need. Null when there is
 * no such activity in this session (an id from another session is never
 * locked). Visibility (status, state, target room) is the caller's check.
 */
export async function lockActivityShared<K extends BreakoutActivityKind>(
  tx: Tx,
  session: ActiveSessionLock,
  kind: K,
  activityId: string
): Promise<ShareLockFor<K> | null> {
  assertSessionLockHeld(tx, session, "activity");
  if (typeof activityId !== "string" || activityId === "") throw new TypeError("activityId is required.");
  let rows: SharedActivityFields[];
  if (kind === "assignment") {
    rows = await tx.$queryRaw<SharedActivityFields[]>`SELECT "id", "classSessionId", "state"::text AS "state", "status", "targetRoomType"::text AS "targetRoomType", "targetRoomId" FROM "BreakoutAssignment" WHERE "id" = ${activityId} AND "classSessionId" = ${session.id} FOR KEY SHARE`;
  } else if (kind === "quiz") {
    rows = await tx.$queryRaw<SharedActivityFields[]>`SELECT "id", "classSessionId", "state"::text AS "state", "status", "targetRoomType"::text AS "targetRoomType", "targetRoomId" FROM "BreakoutQuiz" WHERE "id" = ${activityId} AND "classSessionId" = ${session.id} FOR KEY SHARE`;
  } else {
    throw new TypeError("Unknown activity kind.");
  }
  if (rows.length !== 1) return null;
  const row = rows[0];
  const lock = Object.freeze({
    kind,
    id: row.id,
    classSessionId: row.classSessionId,
    state: row.state,
    status: row.status,
    targetRoomType: row.targetRoomType,
    targetRoomId: row.targetRoomId ?? null,
  }) as unknown as ShareLockFor<K>;
  issuedActivityLocks.set(lock, tx);
  return lock;
}

function assertActivityShareLockHeld(tx: Tx, lock: AssignmentShareLock | QuizShareLock, kind: BreakoutActivityKind, what: string) {
  assertInTransaction(tx);
  if (!lock || typeof lock !== "object" || issuedActivityLocks.get(lock) !== tx || lock.kind !== kind) {
    throw new Error(`Take the ${kind} share lock (lockActivityShared) in this transaction before the ${what} lock.`);
  }
}

/**
 * Level 3 for a student submission or draft: the (assignment, student)
 * advisory lock, after the assignment share lock of this transaction. Same
 * key as lockSubmissionSlot().
 */
export async function lockStudentSubmissionSlot(tx: Tx, assignment: AssignmentShareLock, studentId: string): Promise<void> {
  assertActivityShareLockHeld(tx, assignment, "assignment", "submission");
  const key = submissionLockKey(assignment.id, studentId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/**
 * Level 4 for a student quiz write: FOR UPDATE on the student's own attempt
 * of this quiz in this session, after the quiz share lock of this
 * transaction. Null when the student has no attempt yet.
 */
export async function lockOwnQuizAttemptForUpdate(tx: Tx, quiz: QuizShareLock, studentId: string): Promise<{ id: string } | null> {
  assertActivityShareLockHeld(tx, quiz, "quiz", "attempt");
  if (typeof studentId !== "string" || studentId === "") throw new TypeError("studentId is required.");
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "BreakoutQuizSubmission" WHERE "quizId" = ${quiz.id} AND "studentId" = ${studentId} AND "classSessionId" = ${quiz.classSessionId} FOR UPDATE`;
  return rows.length === 1 ? rows[0] : null;
}
