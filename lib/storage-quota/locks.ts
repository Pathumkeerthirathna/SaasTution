/*
 * Teacher storage quota (Stage 3.1): the per-teacher quota lock.
 *
 * A PostgreSQL TRANSACTION-level advisory lock (pg_advisory_xact_lock): it is
 * held by the database, so it serialises quota decisions across every
 * application process and server, and it is released automatically when the
 * transaction commits or rolls back (a crashed process can never leave it
 * held). Every operation that decides whether a teacher may add stored bytes
 * (a reservation, a Recorded Lecture upload start) takes it, computes the
 * usage and records its reservation in the SAME transaction.
 *
 * REQUIRED LOCK ORDER (always acquire in this order, skipping levels not needed;
 * never acquire a lower-numbered lock after a higher-numbered one):
 *   1. lockTeacherUploads(tx, teacherId)        Recorded Lectures, per teacher
 *      (the Recorded Lectures upload-locks module)
 *   2. lockTeacherStorageQuota(tx, teacherId)   this module, per teacher
 *   3. lockUploadCapacity(tx)                   Recorded Lectures, global disk capacity
 *      (the Recorded Lectures upload-locks module)
 * Notes and submissions take only level 2. A Recorded Lecture upload start
 * takes 1, then 2, then 3. With one global order no two transactions can wait
 * for each other in a cycle. Guarded by tests/storage-quota/locks.test.cjs (a
 * source check of every caller).
 *
 * Stage 3.1 only provides the helper: no upload route takes it yet.
 */

export const STORAGE_QUOTA_LOCK_NAMESPACE = "storage-quota";

/** Bounded wait for the quota lock (a busy teacher's upload fails fast instead of piling up). */
export const STORAGE_QUOTA_LOCK_TIMEOUT_MS = 10_000;

const TEACHER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The transaction client this module needs (Prisma's interactive transaction client, or a test fake). */
export type QuotaLockTx = {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  $executeRawUnsafe(query: string): Promise<unknown>;
};

/** The advisory-lock key of one teacher's quota (distinct from every Recorded Lectures key). */
export function teacherStorageQuotaLockKey(teacherId: string): string {
  if (typeof teacherId !== "string" || !TEACHER_ID.test(teacherId)) throw new TypeError("teacherId is not a valid id.");
  return `${STORAGE_QUOTA_LOCK_NAMESPACE}:teacher:${teacherId}`;
}

function assertInTransaction(tx: unknown) {
  // An interactive transaction client has no $transaction method of its own:
  // an advisory XACT lock outside a transaction would be released immediately.
  if (!tx || typeof tx !== "object" || "$transaction" in tx) {
    throw new Error("The storage quota lock must be taken inside an interactive transaction.");
  }
}

/** Bounds this transaction's lock waits (SET LOCAL: this transaction only). Run before taking the lock. */
export async function setStorageQuotaLockTimeout(tx: QuotaLockTx): Promise<void> {
  assertInTransaction(tx);
  // SET cannot take a bind parameter; the value is a module constant.
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${STORAGE_QUOTA_LOCK_TIMEOUT_MS}ms'`);
}

/** Level 2: one teacher's storage quota. Held until the transaction ends. */
export async function lockTeacherStorageQuota(tx: QuotaLockTx, teacherId: string): Promise<void> {
  assertInTransaction(tx);
  const key = teacherStorageQuotaLockKey(teacherId);
  // $executeRaw: pg_advisory_xact_lock returns void, which $queryRaw cannot read.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
