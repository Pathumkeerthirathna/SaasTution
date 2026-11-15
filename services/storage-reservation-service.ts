import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { AppError, reportRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { serverNow } from "@/lib/server-clock";
import { lockTeacherStorageQuota, setStorageQuotaLockTimeout } from "@/lib/storage-quota/locks";
import { fitsWithinStorageLimit, type TeacherStorageUsage } from "@/lib/storage-quota/usage";
import { getTeacherStorageUsage } from "@/services/teacher-storage-usage-service";

/*
 * Teacher storage quota, Stage 3.2: reservations for Notes and assignment
 * submission uploads (Recorded Lectures reserve through their upload
 * sessions; Stage 3.3).
 *
 *   1. reserveTeacherStorage    one short transaction: quota lock, expired
 *                               reservations of the teacher removed, usage
 *                               computed (committed + reserved, database time),
 *                               the reservation inserted ONLY if
 *                               committed + reserved + requested <= limit.
 *   2. (caller) write the files (storeUpload: new storage + rollback copy).
 *   3. commitTeacherStorageReservation
 *                               one transaction: quota lock, the reservation
 *                               re-read and checked (same teacher, category,
 *                               key and size); if it is missing or expired the
 *                               quota is checked AGAIN before anything is
 *                               written; then the caller's row write (Note
 *                               create / submission create or compare-and-set)
 *                               and the reservation's deletion, atomically.
 *   4. releaseTeacherStorageReservation
 *                               after any failure; best effort (logged). A
 *                               reservation that could not be released stops
 *                               counting when it expires.
 *
 * Every quota decision for a teacher holds that teacher's advisory lock
 * (lib/storage-quota/locks.ts), so simultaneous uploads - in any process -
 * cannot together exceed the limit. Notes and submissions take ONLY this lock
 * (lock order level 2).
 *
 * Reservation lifetime: STORAGE_RESERVATION_TTL_MS = 15 minutes. A Notes /
 * submission file is at most 25 MB and has already been received in full
 * (request.formData) before the reservation is made; writing it (twice while
 * dual-write is on) takes seconds. 15 minutes covers a very slow disk with a
 * wide margin, and bounds how long a crashed request's reservation can block
 * capacity. A request that still outlives it is not trusted: its commit
 * re-checks the quota.
 */

export const STORAGE_RESERVATION_TTL_MS = 15 * 60_000;
/** The reservation size CHECK: the Int range of Note / AssignmentSubmission.sizeBytes. */
const MAX_RESERVATION_BYTES = BigInt(2_147_483_647);
/** Waiting for the quota lock is bounded by its lock_timeout (10 s); the transaction itself must not die first. */
const QUOTA_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

export type QuotaAudience = "TEACHER" | "STUDENT";
export type StorageReservationCategory = "NOTE" | "SUBMISSION";

export type StorageReservationHandle = {
  id: string;
  teacherId: string;
  category: StorageReservationCategory;
  storageKey: string;
  bytes: bigint;
  expiresAt: Date;
};

type Tx = Prisma.TransactionClient;

// ---- Errors -------------------------------------------------------------------------------------------------

export const STORAGE_QUOTA_EXCEEDED = "STORAGE_QUOTA_EXCEEDED";

/**
 * 413 STORAGE_QUOTA_EXCEEDED. A teacher sees the figures (decimal strings);
 * a student only a generic message - never the teacher's quota or usage.
 * Never confused with 507 (the server's disk is full).
 */
export function storageQuotaExceededError(usage: TeacherStorageUsage, requestedBytes: bigint, audience: QuotaAudience): AppError {
  if (audience === "STUDENT") {
    return new AppError(
      "This file cannot be submitted right now because your teacher's storage space is full. Please contact your teacher.",
      413,
      STORAGE_QUOTA_EXCEEDED
    );
  }
  return new AppError("This upload would exceed your storage limit. Delete files you no longer need or ask an administrator for more storage.", 413, STORAGE_QUOTA_EXCEEDED, {
    limitBytes: usage.limit.limitBytes === null ? null : usage.limit.limitBytes.toString(),
    usedBytes: usage.committed.total.toString(),
    reservedBytes: usage.reserved.total.toString(),
    requestedBytes: requestedBytes.toString(),
    remainingBytes: usage.remainingBytes === null ? null : usage.remainingBytes.toString(),
  });
}

/** The quota lock could not be obtained within its lock_timeout (a very busy teacher): retry, not a failure. */
export function isQuotaLockTimeout(error: unknown): boolean {
  const e = error as { message?: unknown; code?: unknown; meta?: { code?: unknown; message?: unknown } } | null;
  const text = `${e?.message ?? ""} ${e?.code ?? ""} ${e?.meta?.code ?? ""} ${e?.meta?.message ?? ""}`;
  return /55P03|lock timeout|could not obtain lock/i.test(text);
}

/** 503 STORAGE_QUOTA_BUSY: the teacher's quota lock was not obtained in time (shared with Recorded Lectures uploads). */
export function storageQuotaBusyError() {
  return new AppError("Storage is busy right now. Please try again in a moment.", 503, "STORAGE_QUOTA_BUSY");
}
const storageBusyError = storageQuotaBusyError;

function reportReleaseFailure(error: unknown, label: string) {
  try {
    reportRouteError(error, { request: new Request("http://internal/storage-quota/reservation", { method: "POST" }), label });
  } catch {
    // Logging must never break the request.
  }
}

// ---- The quota transaction ------------------------------------------------------------------------------

/** Runs fn in a transaction that holds the teacher's quota lock; `now` is database time taken AFTER the lock. */
async function inQuotaTransaction<T>(teacherId: string, fn: (tx: Tx, now: Date) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      await setStorageQuotaLockTimeout(tx);
      await lockTeacherStorageQuota(tx, teacherId);
      const now = await serverNow();
      return fn(tx, now);
    }, QUOTA_TRANSACTION_OPTIONS);
  } catch (error) {
    if (isQuotaLockTimeout(error)) throw storageBusyError();
    throw error;
  }
}

function assertReservableBytes(bytes: bigint) {
  if (typeof bytes !== "bigint" || bytes < BigInt(1) || bytes > MAX_RESERVATION_BYTES) throw new Error("Invalid reservation size.");
}

// ---- 1. Reserve -----------------------------------------------------------------------------------------

export async function reserveTeacherStorage(input: {
  teacherId: string;
  category: StorageReservationCategory;
  storageKey: string;
  bytes: bigint;
  audience: QuotaAudience;
}): Promise<StorageReservationHandle> {
  assertReservableBytes(input.bytes);
  return inQuotaTransaction(input.teacherId, async (tx, now) => {
    // Expiry recovery: a crashed request's reservation stops counting once expired (the usage
    // query ignores it) and is removed here, under the same lock.
    await tx.storageReservation.deleteMany({ where: { teacherId: input.teacherId, expiresAt: { lte: now } } });

    const usage = await getTeacherStorageUsage(input.teacherId, { db: tx, now });
    if (!fitsWithinStorageLimit(usage, input.bytes)) throw storageQuotaExceededError(usage, input.bytes, input.audience);

    const row = await tx.storageReservation.create({
      data: {
        id: randomUUID(),
        teacherId: input.teacherId,
        category: input.category,
        bytes: input.bytes,
        storageKey: input.storageKey,
        createdAt: now,
        expiresAt: new Date(now.getTime() + STORAGE_RESERVATION_TTL_MS),
      },
      select: { id: true, teacherId: true, category: true, storageKey: true, bytes: true, expiresAt: true },
    });
    return row;
  });
}

// ---- 3. Commit ------------------------------------------------------------------------------------------

/**
 * Writes the upload's row (fn) and deletes its reservation in ONE transaction
 * under the teacher's quota lock. A reservation of another teacher, category,
 * key or size is refused (it can never be borrowed). A missing or expired
 * reservation is not trusted: the quota is checked again first, as if
 * reserving now. If fn throws, the transaction rolls back (the reservation
 * stays; the caller releases it).
 */
export async function commitTeacherStorageReservation<T>(
  handle: StorageReservationHandle,
  audience: QuotaAudience,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  return inQuotaTransaction(handle.teacherId, async (tx, now) => {
    const row = await tx.storageReservation.findUnique({
      where: { id: handle.id },
      select: { teacherId: true, category: true, storageKey: true, bytes: true, expiresAt: true },
    });
    if (row && (row.teacherId !== handle.teacherId || row.category !== handle.category || row.storageKey !== handle.storageKey || row.bytes !== handle.bytes)) {
      throw new Error("The storage reservation does not belong to this upload.");
    }
    if (!row || row.expiresAt.getTime() <= now.getTime()) {
      // Not (or no longer) reserved: the usage below does not count it, so this is a fresh decision.
      const usage = await getTeacherStorageUsage(handle.teacherId, { db: tx, now });
      if (!fitsWithinStorageLimit(usage, handle.bytes)) throw storageQuotaExceededError(usage, handle.bytes, audience);
    }
    const result = await fn(tx);
    await tx.storageReservation.deleteMany({ where: { id: handle.id, teacherId: handle.teacherId, storageKey: handle.storageKey } });
    return result;
  });
}

// ---- 4. Release -----------------------------------------------------------------------------------------

/**
 * Deletes the reservation after a failed upload. Never throws: a failure is
 * logged and the reservation stops counting at expiresAt. Deleting only frees
 * capacity, so it does not need the quota lock.
 */
export async function releaseTeacherStorageReservation(handle: StorageReservationHandle, label: string): Promise<boolean> {
  try {
    const result = await prisma.storageReservation.deleteMany({ where: { id: handle.id, teacherId: handle.teacherId, storageKey: handle.storageKey } });
    return result.count > 0;
  } catch (error) {
    reportReleaseFailure(error, label);
    return false;
  }
}
