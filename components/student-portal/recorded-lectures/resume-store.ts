/*
 * Per-device playback memory for recorded lectures (RL-5.1, decision D-4):
 * the resume position of each recording and the last watched part of each
 * lecture, kept in localStorage PER STUDENT (the key holds the student id,
 * so students sharing a browser never see each other's positions), plus the
 * preferred playback speed.
 *
 * Browser storage is a convenience only: it can be missing, empty, full or
 * throwing (private mode, blocked site data). Every access is wrapped; a
 * failure simply means "nothing remembered", and playback is never affected.
 * Nothing is sent to the server and there is no database change.
 *
 * Rules:
 *   - a position is only remembered after MIN_RESUME_SECONDS;
 *   - at FINISHED_FRACTION of the duration (or "ended") it is cleared, so a
 *     finished recording starts from the beginning next time;
 *   - at most MAX_ENTRIES positions (and as many last-part entries) are kept
 *     per student; the least recently saved are removed first.
 */

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export const MIN_RESUME_SECONDS = 10;
export const FINISHED_FRACTION = 0.95;
export const MAX_ENTRIES = 100;
export const SAVE_INTERVAL_MS = 5_000;

const POSITION_PREFIX = "sl:rl:pos:";
const LAST_PART_PREFIX = "sl:rl:last:";
const SPEED_KEY = "sl:rl:speed";

export function positionKey(studentId: string, recordingId: string): string {
  return `${POSITION_PREFIX}${studentId}:${recordingId}`;
}

export function lastPartKey(studentId: string, lectureId: string): string {
  return `${LAST_PART_PREFIX}${studentId}:${lectureId}`;
}

/** window.localStorage, or null when it is unavailable or throws on access. */
export function browserStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

type PositionEntry = { p: number; t: number };

function readJson(storage: StorageLike | null, key: string): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function write(storage: StorageLike | null, key: string, value: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(storage: StorageLike | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Nothing to do: storage is a convenience.
  }
}

/** Keeps at most `max` entries under `prefix` (oldest `t` first out). */
function enforceLimit(storage: StorageLike, prefix: string, max: number): void {
  try {
    const entries: { key: string; t: number }[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const value = readJson(storage, key) as { t?: unknown } | null;
      entries.push({ key, t: typeof value?.t === "number" ? value.t : 0 });
    }
    if (entries.length <= max) return;
    entries.sort((a, b) => a.t - b.t);
    for (const entry of entries.slice(0, entries.length - max)) remove(storage, entry.key);
  } catch {
    // Best effort.
  }
}

/** The saved position in seconds, or null (nothing saved, unreadable, or invalid). */
export function readResumePosition(storage: StorageLike | null, studentId: string, recordingId: string): number | null {
  const value = readJson(storage, positionKey(studentId, recordingId)) as PositionEntry | null;
  if (!value || typeof value.p !== "number" || !Number.isFinite(value.p) || value.p < MIN_RESUME_SECONDS) return null;
  return value.p;
}

/** Where to start: the saved position when it is before the "finished" point of this duration, else null. */
export function resumeStartFor(saved: number | null, duration: number | null | undefined): number | null {
  if (saved === null) return null;
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0 && saved >= duration * FINISHED_FRACTION) return null;
  return saved;
}

/**
 * Remembers `position` (seconds). Before MIN_RESUME_SECONDS nothing is kept
 * (an existing entry is left alone); at FINISHED_FRACTION of `duration` the
 * entry is removed. Returns what happened, for tests.
 */
export function saveResumePosition(
  storage: StorageLike | null,
  studentId: string,
  recordingId: string,
  position: number,
  duration: number | null | undefined,
  now: number = Date.now()
): "saved" | "cleared" | "skipped" {
  if (!storage || !Number.isFinite(position) || position < 0) return "skipped";
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0 && position >= duration * FINISHED_FRACTION) {
    remove(storage, positionKey(studentId, recordingId));
    return "cleared";
  }
  if (position < MIN_RESUME_SECONDS) return "skipped";
  const key = positionKey(studentId, recordingId);
  const isNew = readJson(storage, key) === null;
  if (!write(storage, key, JSON.stringify({ p: Math.floor(position), t: now }))) return "skipped";
  if (isNew) enforceLimit(storage, `${POSITION_PREFIX}${studentId}:`, MAX_ENTRIES);
  return "saved";
}

/** Forgets a position (the recording was finished). */
export function clearResumePosition(storage: StorageLike | null, studentId: string, recordingId: string): void {
  remove(storage, positionKey(studentId, recordingId));
}

export function readLastPart(storage: StorageLike | null, studentId: string, lectureId: string): string | null {
  const value = readJson(storage, lastPartKey(studentId, lectureId)) as { r?: unknown } | null;
  return value && typeof value.r === "string" ? value.r : null;
}

export function saveLastPart(storage: StorageLike | null, studentId: string, lectureId: string, recordingId: string, now: number = Date.now()): void {
  if (!storage) return;
  const key = lastPartKey(studentId, lectureId);
  const isNew = readJson(storage, key) === null;
  if (write(storage, key, JSON.stringify({ r: recordingId, t: now })) && isNew) {
    enforceLimit(storage, `${LAST_PART_PREFIX}${studentId}:`, MAX_ENTRIES);
  }
}

export function readPreferredRate(storage: StorageLike | null): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(SPEED_KEY);
  } catch {
    return null;
  }
}

export function savePreferredRate(storage: StorageLike | null, rate: number): void {
  write(storage, SPEED_KEY, String(rate));
}
