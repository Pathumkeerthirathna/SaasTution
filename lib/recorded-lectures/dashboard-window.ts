/*
 * The student dashboard window for a recorded lecture (Recorded Lectures RL-4.2).
 *
 * A "Watch Recorded Lecture" shortcut is shown on the student dashboard from
 * the lecture start for RECORDED_LECTURE_DASHBOARD_DAYS days:
 *
 *     lecture.date <= now < lecture.date + days * 24 h
 *
 * Both sides are real UTC instants: Lecture.date is stored as the real
 * instant (a Sri Lankan datetime-local value is converted when it is entered,
 * lib/lecture-validation.ts) and `now` comes from serverNow(). Sri Lanka has
 * no daylight saving time, so days * 24 h is always the same number of Sri
 * Lankan calendar days, and no timezone arithmetic is needed or done here.
 * Never pass nowInSriLanka() (shifted digits) or a local-time value.
 *
 * The window decides dashboard visibility ONLY. It never restricts the full
 * recording list, the metadata or (RL-4.3) playback.
 *
 * Pure: no I/O, no clock of its own (`now` is always passed in).
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The same bounds as the RECORDED_LECTURE_DASHBOARD_DAYS setting (lib/recorded-lectures/config.ts). */
export const MIN_DASHBOARD_DAYS = 1;
export const MAX_DASHBOARD_DAYS = 30;

export type DashboardWindow = {
  /** True when the dashboard shows the shortcut at `now`. */
  visible: boolean;
  /** The lecture start: the first instant of the window (inclusive). */
  visibleFrom: Date;
  /** The first instant AFTER the window (exclusive). */
  visibleUntil: Date;
};

function instantMs(value: Date, name: string): number {
  const ms = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`${name} must be a valid Date.`);
  return ms;
}

/** The window length in milliseconds; throws for a day count outside the setting's bounds. */
export function dashboardWindowMs(days: number): number {
  if (!Number.isInteger(days) || days < MIN_DASHBOARD_DAYS || days > MAX_DASHBOARD_DAYS) {
    throw new RangeError(`The dashboard window must be ${MIN_DASHBOARD_DAYS} to ${MAX_DASHBOARD_DAYS} whole days.`);
  }
  return days * DAY_MS;
}

/** The window of one lecture, and whether `now` is inside it. */
export function dashboardWindowFor(lectureStart: Date, now: Date, days: number): DashboardWindow {
  const start = instantMs(lectureStart, "lectureStart");
  const at = instantMs(now, "now");
  const until = start + dashboardWindowMs(days);
  return { visible: start <= at && at < until, visibleFrom: new Date(start), visibleUntil: new Date(until) };
}

/**
 * The lecture start instants whose window contains `now`, for a database
 * filter: `lecture.date > gt AND lecture.date <= lte`. This is exactly
 * `date <= now < date + days` rearranged, so a row matches the filter if and
 * only if dashboardWindowFor(row.date, now, days).visible.
 */
export function dashboardLectureStartRange(now: Date, days: number): { gt: Date; lte: Date } {
  const at = instantMs(now, "now");
  return { gt: new Date(at - dashboardWindowMs(days)), lte: new Date(at) };
}
