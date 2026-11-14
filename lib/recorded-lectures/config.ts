/*
 * Recorded Lectures: every limit in one place (RL-1).
 *
 * Each value has a default and may be overridden by an environment variable
 * (a plain decimal integer). Values are validated together; any invalid
 * value makes the whole feature report "not configured" instead of running
 * with a surprising limit. Nothing here reads files or secrets; the storage
 * root (FILE_STORAGE_ROOT) is checked by lib/file-storage/config.ts.
 *
 * Accepted defaults (plan v8, as amended for RL-1):
 *   maximum part             4,000,000,000 bytes (decimal 4 GB)
 *   chunk                    8,388,608 bytes (8 MiB)
 *   chunk lease              300 s
 *   in-flight chunk cap      134,217,728 bytes (128 MiB)
 *   scratch cleanup grace    15 min
 *   dashboard window         7 days after the lecture start
 */

export type RecordedLectureConfig = {
  /** Largest accepted recording part, in bytes. */
  maxPartBytes: number;
  /** Size of one upload chunk, in bytes. */
  chunkBytes: number;
  /** How long one chunk lease (one in-flight chunk per upload) lasts, in seconds. */
  chunkLeaseSeconds: number;
  /** Cap on the sum of all current chunk leases, in bytes. */
  maxInflightChunkBytes: number;
  /** Minimum age before an abandoned scratch (.chunk) file is removed, in minutes. */
  scratchGraceMinutes: number;
  /** How long an unfinished upload may stay open, in hours. */
  uploadExpiryHours: number;
  /** Concurrent unfinished uploads per teacher. */
  maxActiveUploadsPerTeacher: number;
  /** Optional cap on parts per lecture; null = no cap (only capacity limits it). */
  maxPartsPerLecture: number | null;
  /** Disk space always kept free, in bytes. */
  minFreeBytes: number;
  /** Largest MP4 metadata box (moov) the validator will read, in bytes. */
  maxMoovBytes: number;
  /** Days after the lecture start during which the dashboard offers "Watch Recorded Lecture". */
  dashboardAvailabilityDays: number;
  /** Minimum age before an unreferenced recording file is removed, in hours. */
  orphanGraceHours: number;
};

type Setting = {
  key: keyof RecordedLectureConfig;
  env: string;
  defaultValue: number | null;
  min: number;
  max: number;
  optional?: boolean;
};

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const RECORDED_LECTURE_SETTINGS: readonly Setting[] = [
  { key: "maxPartBytes", env: "RECORDED_LECTURE_MAX_PART_BYTES", defaultValue: 4_000_000_000, min: 1_000_000, max: 64_000_000_000 },
  { key: "chunkBytes", env: "RECORDED_LECTURE_CHUNK_BYTES", defaultValue: 8 * MIB, min: 1 * MIB, max: 64 * MIB },
  { key: "chunkLeaseSeconds", env: "RECORDED_LECTURE_CHUNK_LEASE_SECONDS", defaultValue: 300, min: 30, max: 900 },
  { key: "maxInflightChunkBytes", env: "RECORDED_LECTURE_MAX_INFLIGHT_CHUNK_BYTES", defaultValue: 128 * MIB, min: 1 * MIB, max: 4 * GIB },
  { key: "scratchGraceMinutes", env: "RECORDED_LECTURE_SCRATCH_GRACE_MINUTES", defaultValue: 15, min: 5, max: 1440 },
  { key: "uploadExpiryHours", env: "RECORDED_LECTURE_UPLOAD_EXPIRY_HOURS", defaultValue: 24, min: 1, max: 168 },
  { key: "maxActiveUploadsPerTeacher", env: "RECORDED_LECTURE_MAX_ACTIVE_UPLOADS_PER_TEACHER", defaultValue: 3, min: 1, max: 20 },
  { key: "maxPartsPerLecture", env: "RECORDED_LECTURE_MAX_PARTS_PER_LECTURE", defaultValue: null, min: 1, max: 1_000_000, optional: true },
  { key: "minFreeBytes", env: "RECORDED_LECTURE_MIN_FREE_BYTES", defaultValue: 5 * GIB, min: 0, max: 1024 * GIB },
  { key: "maxMoovBytes", env: "RECORDED_LECTURE_MAX_MOOV_BYTES", defaultValue: 64 * MIB, min: 1 * MIB, max: 256 * MIB },
  { key: "dashboardAvailabilityDays", env: "RECORDED_LECTURE_DASHBOARD_DAYS", defaultValue: 7, min: 1, max: 30 },
  { key: "orphanGraceHours", env: "RECORDED_LECTURE_ORPHAN_GRACE_HOURS", defaultValue: 48, min: 1, max: 720 },
];

export const RECORDED_LECTURE_DEFAULTS: RecordedLectureConfig = Object.freeze(
  Object.fromEntries(RECORDED_LECTURE_SETTINGS.map((s) => [s.key, s.defaultValue]))
) as RecordedLectureConfig;

export type RecordedLectureConfigResult =
  | { ok: true; config: RecordedLectureConfig }
  | { ok: false; problems: string[] };

const INTEGER = /^\d{1,16}$/;

/** Reads and validates every setting. Problems name the variable only (never its value). */
export function loadRecordedLectureConfig(env: Record<string, string | undefined> = process.env): RecordedLectureConfigResult {
  const problems: string[] = [];
  const values: Record<string, number | null> = {};

  for (const setting of RECORDED_LECTURE_SETTINGS) {
    const raw = env[setting.env];
    if (raw === undefined || raw.trim() === "") {
      values[setting.key] = setting.defaultValue;
      continue;
    }
    const text = raw.trim();
    const value = INTEGER.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(value) || value < setting.min || value > setting.max) {
      problems.push(`${setting.env} must be a whole number from ${setting.min} to ${setting.max}.`);
      continue;
    }
    values[setting.key] = value;
  }

  if (problems.length > 0) return { ok: false, problems };
  const config = values as unknown as RecordedLectureConfig;

  if (config.chunkBytes > config.maxPartBytes) {
    problems.push("RECORDED_LECTURE_CHUNK_BYTES must not exceed RECORDED_LECTURE_MAX_PART_BYTES.");
  }
  if (config.maxInflightChunkBytes < config.chunkBytes) {
    problems.push("RECORDED_LECTURE_MAX_INFLIGHT_CHUNK_BYTES must be at least RECORDED_LECTURE_CHUNK_BYTES.");
  }
  if (config.scratchGraceMinutes * 60 < config.chunkLeaseSeconds) {
    problems.push("RECORDED_LECTURE_SCRATCH_GRACE_MINUTES must cover at least one RECORDED_LECTURE_CHUNK_LEASE_SECONDS.");
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, config: Object.freeze({ ...config }) };
}

/** "4 GB" style text for messages (decimal units, as the limit is defined). */
export function formatDecimalSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${trimNumber(bytes / 1_000_000_000)} GB`;
  if (bytes >= 1_000_000) return `${trimNumber(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${trimNumber(bytes / 1_000)} KB`;
  return `${bytes} bytes`;
}

function trimNumber(value: number): string {
  return (Math.floor(value * 100) / 100).toString();
}
