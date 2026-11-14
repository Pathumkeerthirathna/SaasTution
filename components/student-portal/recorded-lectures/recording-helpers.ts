import type { StudentRecordedLectureDto } from "@/lib/recorded-lectures/student-dto";

/*
 * Pure helpers for the student Recorded Lectures pages (RL-5.1): grouping
 * recording parts by lecture, part navigation and display formatting. No
 * React, no browser APIs, no server code (safe in client components; unit
 * tested in tests/recorded-lectures/student-player-helpers.test.cjs).
 */

export type RecordedLecture = StudentRecordedLectureDto;

export type LectureGroup = {
  lecture: RecordedLecture["lecture"];
  class: RecordedLecture["class"];
  parts: RecordedLecture[];
};

/**
 * Appends a further page to what is already shown, dropping duplicates (a
 * part that was already listed keeps its first position). The API order
 * (lecture date desc, lecture id, part, id) is preserved.
 */
export function mergeRecordings(existing: readonly RecordedLecture[], more: readonly RecordedLecture[]): RecordedLecture[] {
  const seen = new Set(existing.map((r) => r.id));
  const merged = [...existing];
  for (const r of more) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  return merged;
}

/**
 * Groups recordings by lecture in first-seen order. Works across page
 * boundaries: the parts of a lecture split over two pages end up in one group.
 */
export function groupByLecture(recordings: readonly RecordedLecture[]): LectureGroup[] {
  const groups = new Map<string, LectureGroup>();
  for (const r of recordings) {
    const group = groups.get(r.lecture.id);
    if (group) group.parts.push(r);
    else groups.set(r.lecture.id, { lecture: r.lecture, class: r.class, parts: [r] });
  }
  return [...groups.values()];
}

export type PartPosition = {
  index: number;
  current: RecordedLecture;
  previous: RecordedLecture | null;
  next: RecordedLecture | null;
};

/** The part with this id and its neighbours in list order (part numbers may have gaps). Null when absent. */
export function partPosition(parts: readonly RecordedLecture[], recordingId: string | null | undefined): PartPosition | null {
  const index = parts.findIndex((p) => p.id === recordingId);
  if (index < 0) return null;
  return {
    index,
    current: parts[index],
    previous: index > 0 ? parts[index - 1] : null,
    next: index < parts.length - 1 ? parts[index + 1] : null,
  };
}

/** Which part to open: the requested one, else the last watched one, else the first. */
export function initialPartId(
  parts: readonly RecordedLecture[],
  requestedId: string | null | undefined,
  lastWatchedId: string | null | undefined
): string | null {
  if (requestedId && parts.some((p) => p.id === requestedId)) return requestedId;
  if (lastWatchedId && parts.some((p) => p.id === lastWatchedId)) return lastWatchedId;
  return parts[0]?.id ?? null;
}

/** The player page for a lecture, optionally at one part. */
export function playerHref(lectureId: string, recordingId?: string | null): string {
  const base = `/student/recorded-lectures/${encodeURIComponent(lectureId)}`;
  return recordingId ? `${base}?recording=${encodeURIComponent(recordingId)}` : base;
}

/** A class's recorded lectures page. */
export function classRecordingsHref(classId: string): string {
  return `/student/recorded-lectures?classId=${encodeURIComponent(classId)}`;
}

/** List API URL for the next page (class or lecture), with an explicit page size. */
export function listApiUrl(filter: { classId?: string; lectureId?: string; scope?: "all" | "dashboard" }, cursor: string | null, limit: number): string {
  const params = new URLSearchParams();
  if (filter.scope) params.set("scope", filter.scope);
  if (filter.classId) params.set("classId", filter.classId);
  if (filter.lectureId) params.set("lectureId", filter.lectureId);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(limit));
  return `/api/student/recorded-lectures?${params.toString()}`;
}

// ---- Formatting (Sri Lankan time, whatever the browser's timezone) ---------------------------------

export const DISPLAY_TIME_ZONE = "Asia/Colombo";

/** "14 Nov 2026, 3:30 pm" in Sri Lankan time; "—" for a missing or invalid value. */
export function formatLectureDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-GB", {
    timeZone: DISPLAY_TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** 3725 -> "1:02:05", 65 -> "1:05", null -> "—". */
export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** sizeBytes arrives as a decimal string (BigInt column): "1.5 GB" style, "—" when unreadable. */
export function formatSize(sizeBytes: string | null | undefined): string {
  if (typeof sizeBytes !== "string" || !/^\d+$/.test(sizeBytes)) return "—";
  const bytes = Number(sizeBytes);
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** "Part 3" (from the stored part number, gaps kept). */
export function partLabel(part: Pick<RecordedLecture, "partNumber">): string {
  return `Part ${part.partNumber}`;
}

// ---- Playback speed ------------------------------------------------------------------------------

export const PLAYBACK_RATES: readonly number[] = [0.75, 1, 1.25, 1.5, 1.75, 2];

/** A saved / chosen rate if it is one of PLAYBACK_RATES, else 1. */
export function normalizePlaybackRate(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && PLAYBACK_RATES.includes(n) ? n : 1;
}
