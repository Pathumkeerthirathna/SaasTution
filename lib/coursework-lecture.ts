/*
 * How an assignment's / quiz's lecture is shown (General Assignments / General
 * Quizzes, Stage 4).
 *
 * General assignments and quizzes are stored on the class's hidden default
 * lecture (Lecture.isDefault = true, lib/default-lecture.ts). That lecture's
 * title ("General Notes") and date (the class's creation) are internal: they
 * are never shown as a lecture title or a lecture date. Every DTO that
 * exposes an assignment's / quiz's lecture classifies it here, by the
 * isDefault flag only (never by title or date):
 *  - isGeneral: true for the default lecture;
 *  - lectureTitle: "General Assignments" / "General Quizzes" for it, else the
 *    lecture's own title;
 *  - lectureDate: null for it, else the lecture's own date.
 * Client-safe (no server imports): the labels are also used by the pages.
 */

export const GENERAL_ASSIGNMENTS_LABEL = "General Assignments";
export const GENERAL_QUIZZES_LABEL = "General Quizzes";

export type CourseworkKind = "assignment" | "quiz";

/** The lecture columns every coursework DTO needs to classify its lecture. */
export const COURSEWORK_LECTURE_FIELDS = { title: true, date: true, isDefault: true } as const;

export type CourseworkLecture = { title: string; date: Date; isDefault: boolean };

export type CourseworkLectureView = { isGeneral: boolean; lectureTitle: string; lectureDate: Date | null };

export function generalCourseworkLabel(kind: CourseworkKind): string {
  return kind === "assignment" ? GENERAL_ASSIGNMENTS_LABEL : GENERAL_QUIZZES_LABEL;
}

/** The lecture as the coursework DTOs show it (see above). */
export function courseworkLectureView(kind: CourseworkKind, lecture: CourseworkLecture): CourseworkLectureView {
  if (lecture.isDefault === true) {
    return { isGeneral: true, lectureTitle: generalCourseworkLabel(kind), lectureDate: null };
  }
  return { isGeneral: false, lectureTitle: lecture.title, lectureDate: lecture.date };
}

/** The classification and title only (DTOs that never sent a lecture date). */
export function courseworkLectureLabel(kind: CourseworkKind, lecture: Pick<CourseworkLecture, "title" | "isDefault">): { isGeneral: boolean; lectureTitle: string } {
  return lecture.isDefault === true ? { isGeneral: true, lectureTitle: generalCourseworkLabel(kind) } : { isGeneral: false, lectureTitle: lecture.title };
}

/** courseworkLectureView with the date as an ISO string (JSON DTOs that already send strings). */
export function courseworkLectureJson(kind: CourseworkKind, lecture: CourseworkLecture): { isGeneral: boolean; lectureTitle: string; lectureDate: string | null } {
  const view = courseworkLectureView(kind, lecture);
  return { ...view, lectureDate: view.lectureDate ? view.lectureDate.toISOString() : null };
}
