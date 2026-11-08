// Sri Lanka Standard Time is UTC+05:30 all year round (no daylight saving).
const SRI_LANKA_UTC_OFFSET_MINUTES = 5 * 60 + 30;
const SRI_LANKA_OFFSET_MS = SRI_LANKA_UTC_OFFSET_MINUTES * 60 * 1000;

/**
 * Returns a `Date` whose UTC calendar fields equal the current Sri Lankan
 * wall-clock time.
 *
 * The database timestamp columns are `timestamp without time zone`, so whatever
 * calendar fields the `Date` carries are the digits that get stored. Shifting by
 * the Sri Lanka offset before persisting means the stored value reads as local
 * Sri Lankan time instead of UTC.
 */
export function nowInSriLanka(): Date {
  return new Date(Date.now() + SRI_LANKA_OFFSET_MS);
}

/**
 * Shift an existing instant to Sri Lankan wall-clock time, for the same reason
 * as {@link nowInSriLanka}.
 */
export function toSriLankaWallClock(date: Date): Date {
  return new Date(date.getTime() + SRI_LANKA_OFFSET_MS);
}

/**
 * The real (non-shifted) UTC instant marking 00:00 today in Sri Lanka. Unlike
 * {@link nowInSriLanka}, this is for comparing against genuine UTC instant
 * columns (e.g. event start/end times), not values persisted with the
 * shifted-digits convention.
 */
export function startOfTodaySriLankaUtc(): Date {
  const wallClockNow = nowInSriLanka();
  const shiftedMidnight = Date.UTC(
    wallClockNow.getUTCFullYear(),
    wallClockNow.getUTCMonth(),
    wallClockNow.getUTCDate(),
    0,
    0,
    0,
    0
  );
  return new Date(shiftedMidnight - SRI_LANKA_OFFSET_MS);
}

/**
 * Format a value that was persisted with {@link nowInSriLanka} (i.e. its
 * calendar fields already hold Sri Lankan wall-clock time). The value must be
 * read back with `timeZone: "UTC"` so the stored digits are shown verbatim
 * rather than being converted again by the viewer's browser.
 */
export function formatStoredSriLankaDateTime(
  value: string | Date | null | undefined
): string {
  if (!value) return "—";

  return new Date(value).toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatStoredSriLankaDate(
  value: string | Date | null | undefined
): string {
  if (!value) return "—";

  return new Date(value).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Explicit Asia/Colombo helpers for real UTC instants (e.g. Lecture.date).
// Pure UTC arithmetic with the fixed +05:30 offset (Sri Lanka has no daylight
// saving), so the result never depends on the server's or browser's timezone.
// ---------------------------------------------------------------------------

const SRI_LANKA_LOCAL_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/**
 * Reads a timezone-less "YYYY-MM-DDTHH:MM[:SS[.mmm]]" value (what a
 * datetime-local input produces) as Sri Lankan wall-clock time and returns
 * the real UTC instant. Returns null for anything else — including values
 * that carry "Z" or an explicit offset, and impossible dates such as
 * 2026-02-30 — so callers can keep their existing handling for those.
 *
 * "2026-11-08T18:00" -> 2026-11-08T12:30:00.000Z
 */
export function parseSriLankaLocalDateTime(value: string): Date | null {
  const match = SRI_LANKA_LOCAL_DATE_TIME.exec(value);

  if (!match) {
    return null;
  }

  const [, y, mo, d, h, mi, s = "0", ms = "0"] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const millisecond = Number(ms.padEnd(3, "0"));

  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  const wallClock = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));

  // Rejects rolled-over dates (month 13, February 30th, ...).
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() !== month - 1 ||
    wallClock.getUTCDate() !== day
  ) {
    return null;
  }

  return new Date(wallClock.getTime() - SRI_LANKA_OFFSET_MS);
}

/** Whether `value` has the timezone-less datetime-local shape (valid or not). */
export function isLocalDateTimeString(value: string): boolean {
  return SRI_LANKA_LOCAL_DATE_TIME.test(value);
}

/** Sri Lankan calendar date of a real instant: "YYYY-MM-DD". */
export function sriLankaDateKey(instant: Date): string {
  return toSriLankaWallClock(instant).toISOString().slice(0, 10);
}

/** Sri Lankan wall-clock time of a real instant: "HH:MM". */
export function sriLankaTimeKey(instant: Date): string {
  return toSriLankaWallClock(instant).toISOString().slice(11, 16);
}

/** A real instant as a datetime-local value in Sri Lankan time: "YYYY-MM-DDTHH:MM". */
export function toSriLankaDateTimeLocal(instant: Date): string {
  return toSriLankaWallClock(instant).toISOString().slice(0, 16);
}

/** Sri Lankan year, month (1-12) and weekday (0 = Sunday) of a real instant. */
export function sriLankaCalendarParts(instant: Date): {
  year: number;
  month: number;
  weekday: number;
} {
  const wallClock = toSriLankaWallClock(instant);

  return {
    year: wallClock.getUTCFullYear(),
    month: wallClock.getUTCMonth() + 1,
    weekday: wallClock.getUTCDay(),
  };
}

/**
 * Converts a value whose UTC fields hold Sri Lankan wall-clock digits (e.g. a
 * calendar day boundary `new Date("YYYY-MM-DDT00:00:00.000Z")`) to the real
 * instant, so it can be compared with real-instant columns like Lecture.date.
 */
export function sriLankaDigitsToInstant(digits: Date): Date {
  return new Date(digits.getTime() - SRI_LANKA_OFFSET_MS);
}

/**
 * The next occurrence, strictly after `now`, of a weekly Sri Lankan slot
 * (weekday 0 = Sunday, time "HH:MM"), as a real instant. Null for a malformed
 * weekday or time.
 */
export function nextSriLankaWeeklyOccurrence(
  now: Date,
  weekday: number,
  time: string
): Date | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(time.trim());

  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour > 23 || minute > 59) {
    return null;
  }

  const wallNow = toSriLankaWallClock(now);
  const daysAhead = (weekday - wallNow.getUTCDay() + 7) % 7;
  const wallOccurrence = Date.UTC(
    wallNow.getUTCFullYear(),
    wallNow.getUTCMonth(),
    wallNow.getUTCDate() + daysAhead,
    hour,
    minute,
    0,
    0
  );

  let occurrence = wallOccurrence - SRI_LANKA_OFFSET_MS;

  if (occurrence <= now.getTime()) {
    occurrence += 7 * 24 * 60 * 60 * 1000;
  }

  return new Date(occurrence);
}
