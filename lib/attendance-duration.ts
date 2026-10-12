/**
 * Attendance durations from a student's actual visits (Attendance rows) in one
 * ClassSession. A student can have several visits per session (left at 08:10,
 * came back at 08:50): their durations are summed.
 *
 * Overlapping visits (e.g. two rows left open by an older client after a
 * refresh, or two devices at once) are merged first, so the same minutes are
 * never counted twice.
 *
 * Open visits (no leftAt) count only up to `openUntil` when one is given (the
 * session's end, or "now" for a live view); without it they are left out, so
 * a total never includes time that is not known yet.
 *
 * Pure functions, safe on the server and in the browser.
 */

export type AttendanceVisit = {
  joinedAt: Date | string;
  leftAt: Date | string | null;
};

type Options = {
  /** End for open visits (session end / now). Absent: open visits are skipped. */
  openUntil?: Date | string | null;
  /** Clamp every visit into the session window when known. */
  sessionStart?: Date | string | null;
  sessionEnd?: Date | string | null;
};

const toMs = (value: Date | string | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();

  return Number.isFinite(ms) ? ms : null;
};

/** Visits ordered by join time (oldest first), without changing the input. */
export function sortVisitsChronologically<T extends { joinedAt: Date | string }>(visits: T[]): T[] {
  return visits
    .slice()
    .sort((a, b) => (toMs(a.joinedAt) ?? 0) - (toMs(b.joinedAt) ?? 0));
}

/** Total time present in milliseconds: the union of the visits' intervals. */
export function attendedMs(visits: AttendanceVisit[], options: Options = {}): number {
  const openUntil = toMs(options.openUntil);
  const windowStart = toMs(options.sessionStart);
  const windowEnd = toMs(options.sessionEnd);

  const intervals: Array<[number, number]> = [];

  for (const visit of visits) {
    let start = toMs(visit.joinedAt);
    let end = toMs(visit.leftAt) ?? openUntil;

    if (start === null || end === null) {
      continue;
    }

    if (windowStart !== null) start = Math.max(start, windowStart);
    if (windowEnd !== null) end = Math.min(end, windowEnd);

    if (end > start) {
      intervals.push([start, end]);
    }
  }

  intervals.sort((a, b) => a[0] - b[0]);

  let total = 0;
  let currentStart = -Infinity;
  let currentEnd = -Infinity;

  for (const [start, end] of intervals) {
    if (start > currentEnd) {
      if (currentEnd > currentStart) total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    } else if (end > currentEnd) {
      currentEnd = end;
    }
  }

  if (currentEnd > currentStart) total += currentEnd - currentStart;

  return total;
}
