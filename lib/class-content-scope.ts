/*
 * The class scope of the standalone teacher Assignments / Quizzes pages: a
 * class, plus an optional NORMAL lecture of it. Without a lecture the class
 * APIs resolve the class's General section (its default lecture) on the
 * server; the client never sends a default lecture's id.
 *
 * Used by LectureAssignmentPanel / LectureQuizPanel when they are given a
 * `scope` (list and create through /api/classes/[id]/assignments|quizzes);
 * without one they keep using their lecture's own routes.
 */

export type ClassContentScope = { classId: string; lectureId?: string | null };

export type ClassContentKind = "assignments" | "quizzes";

/** GET (list) and POST (create) of one class section: /api/classes/{classId}/{kind}[?lectureId=]. */
export function classContentUrl(kind: ClassContentKind, scope: ClassContentScope): string {
  const base = `/api/classes/${encodeURIComponent(scope.classId)}/${kind}`;
  return scope.lectureId ? `${base}?lectureId=${encodeURIComponent(scope.lectureId)}` : base;
}

/** The class API's answer: the section's lecture (General: the default lecture, resolved on the server) and its rows. */
export type ClassContentPayload<K extends string, T> = {
  section: "GENERAL" | "LECTURE";
  label: string;
  lecture: { id: string; isDefault: boolean; title: string | null; date: string | null };
} & { [key in K]: T[] };
