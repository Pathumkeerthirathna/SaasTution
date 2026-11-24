/*
 * The default lecture (Lecture.isDefault = true): one per class, created in
 * the same transaction as the class (services/class-service.ts
 * createClassForTeacher). It is an internal container for class-level
 * content (the upcoming Notes module), NOT a teaching session:
 *
 *  - every list, selector, count, calendar, attendance, QR, session,
 *    recording and YouTube query adds NORMAL_LECTURE_WHERE;
 *  - every normal single-lecture workflow (detail, update, status, delete,
 *    attendance register, QR, live session, recordings, whiteboards, quizzes,
 *    assignments) treats it as not found (404), server side;
 *  - the normal lecture creation APIs can never create one (their input
 *    schemas have no isDefault field and the services never set it);
 *  - at most one per class: the partial unique index
 *    "Lecture_one_default_per_class" (migration 20261129120000).
 *
 * Always identify it by the isDefault flag, never by its title or date.
 */

/** Spread into a Prisma Lecture `where`: normal lectures only (default lectures excluded). */
export const NORMAL_LECTURE_WHERE = { isDefault: false } as const;

/** The default lecture's internal title (display only; never used to find it). */
export const DEFAULT_LECTURE_TITLE = "General Notes";

/** The partial unique index that allows at most one default lecture per class. */
export const DEFAULT_LECTURE_UNIQUE_INDEX = "Lecture_one_default_per_class";

/**
 * The default lecture's columns for a new class. `date` is the class's
 * creation instant (a real UTC instant, like every Lecture.date; shown in
 * Sri Lankan time), `endDate` null (no end; the CHECK
 * Lecture_endDate_after_date only applies to a non-null end). classStatus and
 * status keep their column defaults (SCHEDULED, 0).
 */
export function defaultLectureData(classId: string, now: Date) {
  return {
    classId,
    title: DEFAULT_LECTURE_TITLE,
    date: now,
    endDate: null,
    isDefault: true,
  } as const;
}
