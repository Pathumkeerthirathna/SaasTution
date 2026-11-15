import type { StorageLimitSource, TeacherStorageUsage } from "./usage";

/*
 * Teacher storage quota, Stage 3.5: the TEACHER's own read-only view of
 * getTeacherStorageUsage (lib/storage-quota/usage.ts). Built only from that
 * result - no accounting here.
 *
 * Deliberately left out (admin-only configuration): the individual override's
 * value, the plan figure, who changed the limit and when, the limit history,
 * and any id. The source is shown as a plain category ("set by an
 * administrator" / "your subscription plan" / unlimited), never with an
 * administrator's identity. Byte counts are decimal strings; per-category and
 * overall totals are added here with BigInt so the browser never does byte
 * arithmetic.
 */

export type TeacherStorageLimitSource = "INDIVIDUAL" | "PLAN" | "UNLIMITED_PLAN" | "NO_ACTIVE_SUBSCRIPTION";

const SOURCE: Record<StorageLimitSource, TeacherStorageLimitSource> = {
  OVERRIDE: "INDIVIDUAL",
  PLAN: "PLAN",
  UNLIMITED_PLAN: "UNLIMITED_PLAN",
  NO_ACTIVE_SUBSCRIPTION: "NO_ACTIVE_SUBSCRIPTION",
};

type CategoryRow = { committedBytes: string; reservedBytes: string; totalBytes: string };

export type TeacherStorageView = {
  measuredAt: string;
  categories: { recordedLectures: CategoryRow; notes: CategoryRow; submissions: CategoryRow };
  committedBytes: string;
  reservedBytes: string;
  /** committed + reserved: what new uploads are measured against. */
  totalBytes: string;
  /** null = unlimited. */
  limitBytes: string | null;
  limitSource: TeacherStorageLimitSource;
  isUnlimited: boolean;
  /** limit - total, never below 0; null when unlimited. */
  remainingBytes: string | null;
  /** total / limit in percent (2 decimals, may exceed 100); null when unlimited or the limit is 0. */
  usagePercent: number | null;
  /** Stored files alone exceed the limit (e.g. after it was reduced). */
  isOverQuota: boolean;
  /** How far stored files exceed the limit ("0" when not over; null when unlimited). */
  overQuotaBytes: string | null;
  /** Stored files + uploads in progress reach beyond the limit: new uploads are refused. */
  isOverLimitIncludingReservations: boolean;
};

export function buildTeacherStorageView(usage: TeacherStorageUsage): TeacherStorageView {
  const row = (key: "recordedLectures" | "notes" | "submissions"): CategoryRow => ({
    committedBytes: usage.committed[key].toString(),
    reservedBytes: usage.reserved[key].toString(),
    totalBytes: (usage.committed[key] + usage.reserved[key]).toString(),
  });
  const limit = usage.limit.limitBytes;
  return {
    measuredAt: usage.measuredAt.toISOString(),
    categories: { recordedLectures: row("recordedLectures"), notes: row("notes"), submissions: row("submissions") },
    committedBytes: usage.committed.total.toString(),
    reservedBytes: usage.reserved.total.toString(),
    totalBytes: usage.totalUsedAndReservedBytes.toString(),
    limitBytes: limit === null ? null : limit.toString(),
    limitSource: SOURCE[usage.limit.source],
    isUnlimited: usage.isUnlimited,
    remainingBytes: usage.remainingBytes === null ? null : usage.remainingBytes.toString(),
    usagePercent: usage.usagePercent,
    isOverQuota: usage.isOverQuota,
    overQuotaBytes: usage.overQuotaBytes === null ? null : usage.overQuotaBytes.toString(),
    isOverLimitIncludingReservations: limit !== null && usage.totalUsedAndReservedBytes > limit,
  };
}
