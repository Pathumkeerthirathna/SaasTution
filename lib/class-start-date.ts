/*
 * A class's Batch Start Date (Class.startDate).
 *
 * The sentinel 1900-01-01 means "the teacher did not give a Batch Start
 * Date". It is stored like any other date: no schema change, no special
 * column value, and existing rows are untouched.
 *
 *   - Create: an empty date input is sent as the sentinel; a chosen date is
 *     sent unchanged.
 *   - Students / visitors: the sentinel is never shown as a date.
 *   - The teacher's edit form shows the saved value as it is (the sentinel
 *     too) and the teacher can replace it.
 *
 * Dates are calendar dates ("YYYY-MM-DD"), stored as UTC midnight (what
 * `new Date("YYYY-MM-DD")` produced before) and read back by their UTC date
 * part, so no time zone can move them by a day. Pure and dependency-free
 * (browser and server).
 */

/** "The teacher did not give a Batch Start Date." */
export const CLASS_START_DATE_NOT_SET = "1900-01-01";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written "YYYY-MM-DD" (rejects 2026-02-30, 2026-13-01, ...). */
export function isCalendarDateString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The value a NEW class is created with: the chosen date unchanged, or the sentinel when the input is empty. */
export function classStartDateForCreate(input: string | null | undefined): string {
  const value = typeof input === "string" ? input.trim() : "";
  return value === "" ? CLASS_START_DATE_NOT_SET : value;
}

/** The stored instant for a "YYYY-MM-DD" date: UTC midnight of that day. */
export function classStartDateToDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** "YYYY-MM-DD" of a saved start date (an ISO string or a Date, by its UTC date), or "" when there is none. */
export function classStartDateInputValue(saved: string | Date | null | undefined): string {
  if (saved === null || saved === undefined || saved === "") return "";
  if (typeof saved === "string" && isCalendarDateString(saved)) return saved;
  const date = saved instanceof Date ? saved : new Date(saved);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/** True when the class has a REAL Batch Start Date (not none, not the sentinel, not unreadable): only then is it shown. */
export function hasClassStartDate(saved: string | Date | null | undefined): boolean {
  const value = classStartDateInputValue(saved);
  return value !== "" && value !== CLASS_START_DATE_NOT_SET;
}
