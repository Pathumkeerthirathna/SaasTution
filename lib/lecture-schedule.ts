/**
 * Lecture end time rules, shared by request validation
 * (lib/lecture-validation.ts), the lecture service (updates checked against
 * the stored start / end) and the lecture form. Pure; safe in the browser.
 *
 * Lecture.date (start) and Lecture.endDate (end, optional) are real UTC
 * instants. An end time must be strictly after the start and at most
 * MAX_LECTURE_DURATION_HOURS later. The database enforces "after the start"
 * as well (CHECK constraint Lecture_endDate_after_date); the maximum length
 * is enforced here only.
 */

export const MAX_LECTURE_DURATION_HOURS = 12;
export const MAX_LECTURE_DURATION_MS = MAX_LECTURE_DURATION_HOURS * 60 * 60 * 1000;

export type LectureEndDateProblem = "END_NOT_AFTER_START" | "LECTURE_TOO_LONG";

export const LECTURE_END_DATE_MESSAGES: Record<LectureEndDateProblem, string> = {
  END_NOT_AFTER_START: "The end time must be after the start time.",
  LECTURE_TOO_LONG: `A lecture can be at most ${MAX_LECTURE_DURATION_HOURS} hours long.`,
};

/** API error codes for an end time that does not fit the (stored) start. */
export const LECTURE_END_DATE_ERROR_CODES: Record<LectureEndDateProblem, string> = {
  END_NOT_AFTER_START: "LECTURE_END_NOT_AFTER_START",
  LECTURE_TOO_LONG: "LECTURE_TOO_LONG",
};

/** Why `end` is not a valid end for a lecture starting at `start`; null when it is (or there is no end). */
export function lectureEndDateProblem(start: Date, end: Date | null | undefined): LectureEndDateProblem | null {
  if (end === null || end === undefined) return null;

  const duration = end.getTime() - start.getTime();

  // NaN (an invalid date) is never "after".
  if (!(duration > 0)) return "END_NOT_AFTER_START";
  if (duration > MAX_LECTURE_DURATION_MS) return "LECTURE_TOO_LONG";

  return null;
}
