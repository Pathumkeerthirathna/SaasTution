import { dashboardWindowFor } from "./dashboard-window";
import { assertClientSafe } from "./upload-dto";

/*
 * Student-facing recorded lecture DTO (Recorded Lectures RL-4.2).
 *
 * An explicit allow-list: the builder copies named fields into a new object,
 * so a column added to the query later never reaches a student by accident.
 * Never included: storage keys or paths, the stored (internal) file name, the
 * teacher's original file name, teacher ids, upload session ids, lease
 * tokens, failure information, codecs, lifecycle / deletion columns or any
 * other database-only field. sizeBytes is a decimal string (BigInt column).
 *
 * The result is checked by assertClientSafe (the upload DTO guard: plain JSON
 * only, none of FORBIDDEN_DTO_KEYS) plus STUDENT_FORBIDDEN_DTO_KEYS below.
 */

/** Keys a student response must never contain, in addition to FORBIDDEN_DTO_KEYS. */
export const STUDENT_FORBIDDEN_DTO_KEYS: readonly string[] = [
  "displayFileName",
  "fileName",
  "storedName",
  "uploadId",
  "uploadSessionId",
  "recordedLectureId",
  "failureCode",
  "failedAt",
  "deletedAt",
  "purgeRequestedAt",
  "purgedAt",
  "videoCodec",
  "audioCodec",
  "fragmented",
  "status",
  "state",
];

const STUDENT_FORBIDDEN = new Set(STUDENT_FORBIDDEN_DTO_KEYS);

function assertNoStudentForbiddenKey(value: unknown, at: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoStudentForbiddenKey(item, `${at}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (STUDENT_FORBIDDEN.has(key)) throw new TypeError(`${at}: forbidden key "${key}".`);
      assertNoStudentForbiddenKey(item, `${at}.${key}`);
    }
  }
}

/** Throws unless `value` is safe to send to a student (plain JSON, no forbidden key at any depth). */
export function assertStudentClientSafe(value: unknown, at = "dto"): void {
  assertClientSafe(value, at);
  assertNoStudentForbiddenKey(value, at);
}

/** The columns the builder reads (the service selects exactly these). */
export type StudentRecordedLectureRow = {
  id: string;
  title: string;
  partNumber: number;
  sizeBytes: bigint;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  readyAt: Date | null;
  lecture: { id: string; title: string; date: Date; endDate: Date | null };
  class: { id: string; name: string };
};

/** Monthly resource access of one recording (services/resource-access-service.ts). */
export type StudentResourceLock = { locked: boolean; year: number; month: number };

export type StudentRecordedLectureDto = {
  id: string;
  title: string;
  partNumber: number;
  /** Decimal string: the column is a BigInt. */
  sizeBytes: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  readyAt: string | null;
  lecture: { id: string; title: string; date: string; endDate: string | null };
  class: { id: string; name: string };
  /** Dashboard shortcut visibility only; it never limits access. */
  dashboard: { visible: boolean; visibleFrom: string; visibleUntil: string };
  /**
   * Relative playback path (RL-4.3); authorised again on every request, never
   * a storage location. null when the recording's billing month is locked.
   */
  streamUrl: string | null;
  /** The recording's billing month and whether it is locked (lists; absent on the single-recording read, which refuses a locked month). */
  resourceAccess?: StudentResourceLock;
};

/** The playback API path for a recording (relative; no host, no token). */
export function studentStreamPath(recordingId: string): string {
  return `/api/student/recorded-lectures/${encodeURIComponent(recordingId)}/stream`;
}

function sizeString(value: unknown): string {
  if (typeof value !== "bigint" || value < BigInt(0)) throw new TypeError("sizeBytes must be a non-negative bigint.");
  return value.toString();
}

const iso = (date: Date | null): string | null => (date instanceof Date ? date.toISOString() : null);

export function buildStudentRecordedLectureDto(
  row: StudentRecordedLectureRow,
  options: { now: Date; dashboardDays: number; lock?: StudentResourceLock }
): StudentRecordedLectureDto {
  const window = dashboardWindowFor(row.lecture.date, options.now, options.dashboardDays);
  const dto: StudentRecordedLectureDto = {
    id: row.id,
    title: row.title,
    partNumber: row.partNumber,
    sizeBytes: sizeString(row.sizeBytes),
    durationSeconds: row.durationSeconds,
    width: row.width,
    height: row.height,
    readyAt: iso(row.readyAt),
    lecture: {
      id: row.lecture.id,
      title: row.lecture.title,
      date: row.lecture.date.toISOString(),
      endDate: iso(row.lecture.endDate),
    },
    class: { id: row.class.id, name: row.class.name },
    dashboard: {
      visible: window.visible,
      visibleFrom: window.visibleFrom.toISOString(),
      visibleUntil: window.visibleUntil.toISOString(),
    },
    streamUrl: options.lock?.locked ? null : studentStreamPath(row.id),
    ...(options.lock ? { resourceAccess: { locked: options.lock.locked, year: options.lock.year, month: options.lock.month } } : {}),
  };
  assertStudentClientSafe(dto);
  return dto;
}
