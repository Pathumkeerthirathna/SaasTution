import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { serverNow } from "@/lib/server-clock";
import type { StorageLimitRequest } from "@/lib/storage-quota/limit-input";
import { lockTeacherStorageQuota, setStorageQuotaLockTimeout } from "@/lib/storage-quota/locks";
import { planStorageLimitBytes, serializeTeacherStorageUsage, type SerializedTeacherStorageUsage } from "@/lib/storage-quota/usage";
import { isQuotaLockTimeout, storageQuotaBusyError } from "@/services/storage-reservation-service";
import { activeSubscriptionWhere, getTeacherStorageUsage } from "@/services/teacher-storage-usage-service";

/*
 * Teacher storage quota, Stage 3.4: the administrator's view and control of
 * one teacher's storage.
 *
 * - The usage and the effective limit always come from getTeacherStorageUsage
 *   (never recomputed here).
 * - An override change and its append-only audit row (TeacherStorageLimitChange)
 *   are written in ONE transaction that holds the teacher's quota lock (lock
 *   level 2 only), so concurrent admin changes are serialised with each other
 *   and with upload reservations, and "previous" is always exact.
 * - The administrator is the authenticated session's (adminId, email); the
 *   teacher is the URL's. Nothing is taken from the request body.
 * - Reducing a limit never touches files: a teacher above it is simply "over
 *   the limit" and new uploads are refused by the existing enforcement.
 * - No storage key, path, hash or file detail is ever returned; byte counts are
 *   decimal strings.
 */

const TEACHER_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const QUOTA_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

export type AdminIdentity = { adminId: string; email: string };

export function assertTeacherIdFormat(teacherId: unknown): asserts teacherId is string {
  if (typeof teacherId !== "string" || !TEACHER_ID.test(teacherId)) throw new AppError("Invalid teacher id.", 400, "VALIDATION_ERROR");
}

const teacherNotFound = () => new AppError("Teacher not found.", 404, "TEACHER_NOT_FOUND");

type Db = Pick<Prisma.TransactionClient, "teacher" | "teacherSubscription">;

/** The ACTIVE subscription (the one that may supply the plan limit) and the latest one of any status (context). */
async function readPlanInfo(db: Db, teacherId: string, now: Date) {
  const select = { id: true, status: true, startDate: true, endDate: true, plan: { select: { id: true, name: true, storageGB: true } } } as const;
  const [active, latest] = await Promise.all([
    db.teacherSubscription.findFirst({ where: activeSubscriptionWhere(teacherId, now), orderBy: { updatedAt: "desc" }, select }),
    db.teacherSubscription.findFirst({ where: { teacherId }, orderBy: { updatedAt: "desc" }, select }),
  ]);
  const describe = (s: typeof active) =>
    s && {
      subscriptionId: s.id,
      status: s.status,
      endDate: s.endDate ? s.endDate.toISOString() : null,
      planId: s.plan.id,
      planName: s.plan.name,
      planStorageGB: s.plan.storageGB,
      /** null = the plan is unlimited. */
      planLimitBytes: (() => {
        const bytes = planStorageLimitBytes(s.plan.storageGB);
        return bytes === null ? null : bytes.toString();
      })(),
    };
  return { active: describe(active), latest: describe(latest) };
}

export type AdminTeacherStorageSummary = {
  teacher: { id: string; name: string; email: string };
  usage: SerializedTeacherStorageUsage;
  /** Committed + reserved above the limit (new uploads are refused); usage.isOverQuota is committed alone. */
  isOverLimitIncludingReservations: boolean;
  override: { limitBytes: string; updatedAt: string; updatedByAdminEmail: string } | null;
  subscription: {
    /** The subscription that supplies the plan limit (ACTIVE, not ended), if any. */
    active: Awaited<ReturnType<typeof readPlanInfo>>["active"];
    /** The latest subscription of any status, to explain why no plan limit applies. */
    latest: Awaited<ReturnType<typeof readPlanInfo>>["latest"];
  };
};

export async function getAdminTeacherStorageSummary(teacherId: string): Promise<AdminTeacherStorageSummary> {
  assertTeacherIdFormat(teacherId);
  const teacher = await prisma.teacher.findUnique({ where: { id: teacherId }, select: { id: true, name: true, email: true } });
  if (!teacher) throw teacherNotFound();

  const usage = await getTeacherStorageUsage(teacherId);
  const [override, subscription] = await Promise.all([
    prisma.teacherStorageLimit.findUnique({ where: { teacherId }, select: { limitBytes: true, updatedAt: true, updatedByAdminEmail: true } }),
    readPlanInfo(prisma, teacherId, usage.measuredAt),
  ]);
  const limit = usage.limit.limitBytes;
  return {
    teacher,
    usage: serializeTeacherStorageUsage(usage),
    isOverLimitIncludingReservations: limit !== null && usage.totalUsedAndReservedBytes > limit,
    override: override && { limitBytes: override.limitBytes.toString(), updatedAt: override.updatedAt.toISOString(), updatedByAdminEmail: override.updatedByAdminEmail },
    subscription,
  };
}

/**
 * Sets or removes the teacher's individual override, with its audit row, in
 * one transaction under the teacher's quota lock. A request that changes
 * nothing (the same limit, or removing an override that does not exist) writes
 * nothing and reports changed: false.
 */
export async function setTeacherStorageLimit(input: { teacherId: string; admin: AdminIdentity; request: StorageLimitRequest }): Promise<{ changed: boolean }> {
  assertTeacherIdFormat(input.teacherId);
  const { teacherId, admin, request } = input;
  try {
    return await prisma.$transaction(async (tx) => {
      await setStorageQuotaLockTimeout(tx);
      await lockTeacherStorageQuota(tx, teacherId);
      const now = await serverNow();

      const teacher = await tx.teacher.findUnique({ where: { id: teacherId }, select: { id: true } });
      if (!teacher) throw teacherNotFound();

      const existing = await tx.teacherStorageLimit.findUnique({ where: { teacherId }, select: { limitBytes: true } });
      const previous = existing?.limitBytes ?? null;
      const next = request.kind === "set" ? request.limitBytes : null;
      if (previous === next) return { changed: false };

      const plan = await readPlanInfo(tx, teacherId, now);
      const planLimitBytes = plan.active?.planLimitBytes ? BigInt(plan.active.planLimitBytes) : null;

      if (next === null) {
        await tx.teacherStorageLimit.delete({ where: { teacherId } });
      } else {
        const data = { limitBytes: next, updatedAt: now, updatedByAdminId: admin.adminId, updatedByAdminEmail: admin.email };
        await tx.teacherStorageLimit.upsert({ where: { teacherId }, create: { teacherId, ...data }, update: data });
      }
      await tx.teacherStorageLimitChange.create({
        data: {
          id: randomUUID(),
          teacherId,
          previousLimitBytes: previous,
          newLimitBytes: next,
          planLimitBytes,
          changedByAdminId: admin.adminId,
          changedByAdminEmail: admin.email,
          changedAt: now,
        },
      });
      return { changed: true };
    }, QUOTA_TRANSACTION_OPTIONS);
  } catch (error) {
    if (isQuotaLockTimeout(error)) throw storageQuotaBusyError();
    throw error;
  }
}

export type StorageLimitHistoryItem = {
  id: string;
  previousLimitBytes: string | null;
  newLimitBytes: string | null;
  planLimitBytes: string | null;
  changedByAdminEmail: string;
  changedAt: string;
};

/** The audit history, newest first (read only). */
export async function listTeacherStorageLimitHistory(teacherId: string, page: { skip: number; take: number }): Promise<{ items: StorageLimitHistoryItem[]; totalItems: number }> {
  assertTeacherIdFormat(teacherId);
  const teacher = await prisma.teacher.findUnique({ where: { id: teacherId }, select: { id: true } });
  if (!teacher) throw teacherNotFound();
  const [rows, totalItems] = await Promise.all([
    prisma.teacherStorageLimitChange.findMany({
      where: { teacherId },
      orderBy: [{ changedAt: "desc" }, { id: "desc" }],
      skip: page.skip,
      take: page.take,
      select: { id: true, previousLimitBytes: true, newLimitBytes: true, planLimitBytes: true, changedByAdminEmail: true, changedAt: true },
    }),
    prisma.teacherStorageLimitChange.count({ where: { teacherId } }),
  ]);
  const s = (v: bigint | null) => (v === null ? null : v.toString());
  return {
    items: rows.map((r) => ({
      id: r.id,
      previousLimitBytes: s(r.previousLimitBytes),
      newLimitBytes: s(r.newLimitBytes),
      planLimitBytes: s(r.planLimitBytes),
      changedByAdminEmail: r.changedByAdminEmail,
      changedAt: r.changedAt.toISOString(),
    })),
    totalItems,
  };
}
