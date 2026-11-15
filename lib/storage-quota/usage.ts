/*
 * Teacher storage accounting (Stage 3.1): the pure rules, shared by the usage
 * service (services/teacher-storage-usage-service.ts) and, later, the admin /
 * teacher APIs and upload enforcement. No database or filesystem access here.
 *
 * Units: BYTES as BigInt everywhere in the backend. "GB" is DECIMAL,
 * 1 GB = 1,000,000,000 bytes - the convention the product already uses for
 * storage sizes (the Recorded Lectures config, formatDecimalSize: the
 * 4,000,000,000-byte part limit is shown as "4 GB"). SubscriptionPlan.storageGB
 * is therefore multiplied by 10^9, never by 2^30.
 *
 * Effective limit, in this order:
 *   1. the teacher's individual override (TeacherStorageLimit row), when present;
 *   2. otherwise the ACTIVE subscription plan's storageGB (status ACTIVE, not past
 *      its endDate; cancelled / expired / suspended subscriptions never supply it);
 *   3. otherwise (plan storageGB NULL, or no active subscription) UNLIMITED.
 * 0 is a real limit (nothing may be stored); unlimited is the absence of a
 * limit (limitBytes === null), never 0.
 *
 * Counted categories: Recorded Lectures, Notes (incl. supporting material),
 * assignment submissions - only files referenced by valid database rows in the
 * unified storage hierarchy. Everything else is excluded (see
 * docs/unified-file-storage.md, "Teacher storage quota").
 */

export const BYTES_PER_GB = BigInt(1_000_000_000);
/** The largest limit accepted anywhere (1 PB); the database CHECKs use the same bound. */
export const MAX_STORAGE_LIMIT_BYTES = BigInt("1000000000000000");

export class InvalidStorageLimitError extends Error {
  constructor(readonly source: "OVERRIDE" | "PLAN") {
    super(source === "OVERRIDE" ? "The teacher's storage limit is not a valid byte count." : "The subscription plan's storageGB is not a valid number of GB.");
    this.name = "InvalidStorageLimitError";
  }
}

/** A plan's storageGB as bytes (decimal GB); null = unlimited. Throws for anything but a whole number >= 0. */
export function planStorageLimitBytes(storageGB: number | null | undefined): bigint | null {
  if (storageGB === null || storageGB === undefined) return null;
  if (!Number.isSafeInteger(storageGB) || storageGB < 0) throw new InvalidStorageLimitError("PLAN");
  const bytes = BigInt(storageGB) * BYTES_PER_GB;
  if (bytes > MAX_STORAGE_LIMIT_BYTES) throw new InvalidStorageLimitError("PLAN");
  return bytes;
}

/** Validates an individual override (0 .. 1 PB, whole bytes). */
export function assertValidLimitBytes(limitBytes: bigint): bigint {
  if (typeof limitBytes !== "bigint" || limitBytes < BigInt(0) || limitBytes > MAX_STORAGE_LIMIT_BYTES) throw new InvalidStorageLimitError("OVERRIDE");
  return limitBytes;
}

export type StorageLimitSource = "OVERRIDE" | "PLAN" | "UNLIMITED_PLAN" | "NO_ACTIVE_SUBSCRIPTION";

export type EffectiveStorageLimit = {
  /** null = unlimited. */
  limitBytes: bigint | null;
  source: StorageLimitSource;
  /** The individual override (null = none) and the plan allocation (null = unlimited / no active subscription), for display and audit. */
  overrideBytes: bigint | null;
  planLimitBytes: bigint | null;
};

export function resolveEffectiveStorageLimit(input: {
  overrideBytes: bigint | null;
  /** null = the teacher has no ACTIVE subscription. */
  subscription: { planStorageGB: number | null } | null;
}): EffectiveStorageLimit {
  const overrideBytes = input.overrideBytes === null ? null : assertValidLimitBytes(input.overrideBytes);
  const planLimitBytes = input.subscription ? planStorageLimitBytes(input.subscription.planStorageGB) : null;
  if (overrideBytes !== null) return { limitBytes: overrideBytes, source: "OVERRIDE", overrideBytes, planLimitBytes };
  if (!input.subscription) return { limitBytes: null, source: "NO_ACTIVE_SUBSCRIPTION", overrideBytes, planLimitBytes };
  if (planLimitBytes === null) return { limitBytes: null, source: "UNLIMITED_PLAN", overrideBytes, planLimitBytes };
  return { limitBytes: planLimitBytes, source: "PLAN", overrideBytes, planLimitBytes };
}

// ---- Recorded Lecture session reservations ---------------------------------------------------------------

export type RecordingSessionForQuota = {
  state: string;
  expectedBytes: bigint;
  receivedBytes: bigint;
  leaseBytes: number | null;
  leaseExpiresAt: Date | null;
  expiresAt: Date;
};

/**
 * Bytes one Recorded Lecture upload session reserves against its teacher's
 * quota at `nowMs` - the same rules as reservationRows()
 * (services/recorded-lecture-upload-service.ts):
 *   ACTIVE, not past its upload expiry   -> expectedBytes (the declared size)
 *   ACTIVE, past expiry, CURRENT lease   -> receivedBytes + leaseBytes
 *                                          (as if the upload ended after that chunk)
 *   ACTIVE, past expiry, no current lease -> 0 (it will never receive more)
 *   COMPLETING                           -> expectedBytes (being assembled / verified)
 *   anything else (COMPLETED, CANCELLED, EXPIRED, FAILED) -> 0
 * A COMPLETED session's recording is READY and counted as COMMITTED instead,
 * so a recording is never counted twice (the READY transition and the
 * session's COMPLETED transition commit in one transaction: markReady).
 */
export function recordingSessionReservedBytes(session: RecordingSessionForQuota, nowMs: number): bigint {
  if (session.state === "COMPLETING") return session.expectedBytes;
  if (session.state !== "ACTIVE") return BigInt(0);
  if (session.expiresAt.getTime() > nowMs) return session.expectedBytes;
  const leaseCurrent = session.leaseBytes !== null && session.leaseExpiresAt !== null && session.leaseExpiresAt.getTime() > nowMs;
  return leaseCurrent ? session.receivedBytes + BigInt(session.leaseBytes as number) : BigInt(0);
}

// ---- Usage -------------------------------------------------------------------------------------------------

export type StorageCategoryBytes = { recordedLectures: bigint; notes: bigint; submissions: bigint };

export type TeacherStorageUsage = {
  teacherId: string;
  /** Database time the usage was computed at (reservation expiry is decided against it). */
  measuredAt: Date;
  committed: StorageCategoryBytes & { total: bigint };
  reserved: StorageCategoryBytes & { total: bigint };
  /** committed.total + reserved.total: what new uploads are checked against. */
  totalUsedAndReservedBytes: bigint;
  limit: EffectiveStorageLimit;
  isUnlimited: boolean;
  /** limit - (committed + reserved), never below 0; null when unlimited. */
  remainingBytes: bigint | null;
  /** (committed + reserved) / limit in percent, 2 decimals, may exceed 100; null when unlimited or the limit is 0. */
  usagePercent: number | null;
  /** COMMITTED storage alone is above the limit (e.g. after the limit was reduced). */
  isOverQuota: boolean;
  /** How far committed storage is above the limit (0 when not over, null when unlimited). */
  overQuotaBytes: bigint | null;
};

const ZERO = BigInt(0);
const sum = (c: StorageCategoryBytes) => c.recordedLectures + c.notes + c.submissions;

function assertNonNegative(value: bigint, what: string) {
  if (typeof value !== "bigint" || value < ZERO) throw new Error(`Invalid ${what}: expected a non-negative BigInt.`);
}

export function summarizeTeacherStorageUsage(input: {
  teacherId: string;
  measuredAt: Date;
  committed: StorageCategoryBytes;
  reserved: StorageCategoryBytes;
  limit: EffectiveStorageLimit;
}): TeacherStorageUsage {
  for (const [group, values] of [["committed", input.committed], ["reserved", input.reserved]] as const) {
    for (const [key, value] of Object.entries(values)) assertNonNegative(value, `${group}.${key}`);
  }
  const committedTotal = sum(input.committed);
  const reservedTotal = sum(input.reserved);
  const total = committedTotal + reservedTotal;
  const limitBytes = input.limit.limitBytes;
  const isUnlimited = limitBytes === null;

  let remainingBytes: bigint | null = null;
  let usagePercent: number | null = null;
  let overQuotaBytes: bigint | null = null;
  if (limitBytes !== null) {
    remainingBytes = limitBytes > total ? limitBytes - total : ZERO;
    // Basis points in BigInt (exact for any size), then 2 decimals.
    usagePercent = limitBytes === ZERO ? null : Number((total * BigInt(10_000)) / limitBytes) / 100;
    overQuotaBytes = committedTotal > limitBytes ? committedTotal - limitBytes : ZERO;
  }

  return {
    teacherId: input.teacherId,
    measuredAt: input.measuredAt,
    committed: { ...input.committed, total: committedTotal },
    reserved: { ...input.reserved, total: reservedTotal },
    totalUsedAndReservedBytes: total,
    limit: input.limit,
    isUnlimited,
    remainingBytes,
    usagePercent,
    isOverQuota: limitBytes !== null && committedTotal > limitBytes,
    overQuotaBytes,
  };
}

/** Whether `additionalBytes` more can be reserved now (the Stage 3.2 quota decision). */
export function fitsWithinStorageLimit(usage: TeacherStorageUsage, additionalBytes: bigint): boolean {
  assertNonNegative(additionalBytes, "additionalBytes");
  return usage.limit.limitBytes === null || usage.totalUsedAndReservedBytes + additionalBytes <= usage.limit.limitBytes;
}

// ---- JSON-safe serialization ------------------------------------------------------------------------------

/*
 * JSON.stringify throws on BigInt, and Number() loses precision above 2^53 - 1
 * (about 9 PB, but byte sums must never be rounded). Every byte count crosses
 * the API boundary as a DECIMAL STRING ("12345678901234567"); clients parse it
 * with BigInt() or display it. Percentages stay numbers.
 */

const s = (value: bigint | null) => (value === null ? null : value.toString());
const categories = (c: StorageCategoryBytes & { total: bigint }) => ({
  recordedLectures: c.recordedLectures.toString(),
  notes: c.notes.toString(),
  submissions: c.submissions.toString(),
  total: c.total.toString(),
});

export type SerializedTeacherStorageUsage = ReturnType<typeof serializeTeacherStorageUsage>;

export function serializeTeacherStorageUsage(usage: TeacherStorageUsage) {
  return {
    teacherId: usage.teacherId,
    measuredAt: usage.measuredAt.toISOString(),
    committedBytes: categories(usage.committed),
    reservedBytes: categories(usage.reserved),
    totalUsedAndReservedBytes: usage.totalUsedAndReservedBytes.toString(),
    limit: {
      limitBytes: s(usage.limit.limitBytes),
      source: usage.limit.source,
      overrideBytes: s(usage.limit.overrideBytes),
      planLimitBytes: s(usage.limit.planLimitBytes),
    },
    isUnlimited: usage.isUnlimited,
    remainingBytes: s(usage.remainingBytes),
    usagePercent: usage.usagePercent,
    isOverQuota: usage.isOverQuota,
    overQuotaBytes: s(usage.overQuotaBytes),
  };
}
