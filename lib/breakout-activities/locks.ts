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
// other in a cycle):
//   1. the ClassSession row
//        - FOR SHARE  by every breakout write (create, publish, draft, submit,
//                     quiz save, grading): many can run at once;
//        - FOR UPDATE by session end / replacement (Step 5): waits until the
//                     running writes finish, and every later write then sees
//                     the session as ended (isActive = false);
//   2. then, for a submission only, the advisory lock of the
//      (assignment, student) pair, which serializes one student's
//      submissions to one assignment (version numbers, isLatest flip).
// The order is enforced: lockSubmissionSlot() requires the ActiveSessionLock
// that requireActiveSessionShared() returned for the SAME transaction
// (a branded type at compile time, checked again at run time).
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
 * requireActiveSessionShared() creates one. Required by lockSubmissionSlot().
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
      ? await tx.$queryRaw<LockedSession[]>`SELECT "id", "classId", "isActive" FROM "ClassSession" WHERE "id" = ${sessionId} FOR SHARE`
      : await tx.$queryRaw<LockedSession[]>`SELECT "id", "classId", "isActive" FROM "ClassSession" WHERE "id" = ${sessionId} FOR UPDATE`;
  return rows.length === 1 ? rows[0] : null;
}

/** Shared lock on the session row. Null when the session does not exist. */
export function lockSessionShared(tx: Tx, sessionId: string): Promise<LockedSession | null> {
  return lockSessionRow(tx, sessionId, "share");
}

/** Session end / replacement: exclusive lock on the session row. */
export function lockSessionExclusive(tx: Tx, sessionId: string): Promise<LockedSession | null> {
  return lockSessionRow(tx, sessionId, "update");
}

/**
 * Shared lock for a breakout write, and the session must be live:
 * 404 SESSION_NOT_FOUND, or 409 SESSION_ENDED once it has ended.
 */
export async function requireActiveSessionShared(tx: Tx, sessionId: string): Promise<ActiveSessionLock> {
  const session = await lockSessionShared(tx, sessionId);
  if (!session) throw breakoutError("SESSION_NOT_FOUND");
  if (!session.isActive) throw breakoutError("SESSION_ENDED");
  const lock = Object.freeze({ id: session.id, classId: session.classId, isActive: true }) as ActiveSessionLock;
  issuedSessionLocks.set(lock, tx);
  return lock;
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
  assertInTransaction(tx);
  if (!session || typeof session !== "object" || issuedSessionLocks.get(session) !== tx) {
    throw new Error("Take the session lock (requireActiveSessionShared) in this transaction before the submission lock.");
  }
  const key = submissionLockKey(assignmentId, studentId);
  // $executeRaw: pg_advisory_xact_lock returns void, which $queryRaw cannot read.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
