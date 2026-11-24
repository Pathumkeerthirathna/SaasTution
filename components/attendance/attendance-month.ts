/*
 * Sri Lankan (Asia/Colombo) calendar months for the Attendance workspace.
 * Pure (no React, no "use client"), so the server page can compute the
 * current month once and hand it to the client (one value for the server
 * render and the hydration: no mismatch around midnight at a month's end),
 * and the client can step through months. Never the browser's time zone.
 */

import { sriLankaCalendarParts, sriLankaDigitsToInstant } from "@/lib/time";

const MONTH_KEY = /^(\d{4})-(\d{2})$/;
const monthKeyOf = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

/** Whether `value` is a month key "YYYY-MM" (month 01-12). */
export function isMonthKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = MONTH_KEY.exec(value);
  return Boolean(match) && Number(match![2]) >= 1 && Number(match![2]) <= 12;
}

/** The Sri Lankan calendar month "YYYY-MM" of a real instant. */
export function colomboMonthKey(instant: Date): string {
  const { year, month } = sriLankaCalendarParts(instant);
  return monthKeyOf(year, month);
}

/** The month before (-1) or after (+1) "YYYY-MM": plain calendar arithmetic (2026-12 → 2027-01, 2026-01 → 2025-12). */
export function shiftMonthKey(key: string, delta: 1 | -1): string {
  const match = MONTH_KEY.exec(key);
  if (!match) throw new RangeError(`Not a month key: ${key}`);
  const index = Number(match[1]) * 12 + (Number(match[2]) - 1) + delta;
  return monthKeyOf(Math.floor(index / 12), (index % 12) + 1);
}

/**
 * The real instants of a Sri Lankan month, as the lecture list's inclusive
 * from / to: its first instant (00:00 on the 1st at +05:30) and the last
 * millisecond before the next month's first instant. The same bounds as the
 * matrix's month.
 */
export function colomboMonthBounds(key: string): { from: Date; to: Date } {
  const match = MONTH_KEY.exec(key);
  if (!match) throw new RangeError(`Not a month key: ${key}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const from = sriLankaDigitsToInstant(new Date(Date.UTC(year, month - 1, 1)));
  const next = sriLankaDigitsToInstant(new Date(Date.UTC(year, month, 1)));
  return { from, to: new Date(next.getTime() - 1) };
}
