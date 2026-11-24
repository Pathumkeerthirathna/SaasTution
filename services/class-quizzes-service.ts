/*
 * Class-scoped Quizzes (Quizzes page, Stage 2: backend).
 *
 * A class's quizzes are ordinary Quiz rows on its lectures:
 *  - General Quizzes: the quizzes of the class's DEFAULT lecture
 *    (Lecture.isDefault = true, the same lecture as General Notes, Recordings
 *    and Assignments), resolved on the server from the class; the routes
 *    never accept a default lecture id from the client;
 *  - Lecture Quizzes: one NORMAL lecture of that class, checked to belong to it.
 *
 * The lecture is resolved by the shared resolveClassLectureForTeacher
 * (services/class-notes-service.ts). Listing and creation are then the
 * existing lecture-service functions (validation, question / option
 * creation, time window, maxAttempts), with the default lecture let through
 * only by an explicit `includeDefault` decided here. Everything after
 * creation is the existing per-quiz API, addressed with the lecture id this
 * API returns: edit and delete (/api/lectures/[lectureId]/quizzes/[quizId]),
 * results (.../results); students take, submit and review it through the
 * existing student quiz routes, with the answer snapshots and locks of
 * lib/quiz-answer-snapshot.ts and lib/quiz-locks.ts.
 */

import type { CreateQuizInput } from "@/lib/lecture-validation";
import { GENERAL_QUIZZES_LABEL } from "@/lib/coursework-lecture";
import { AppError } from "@/lib/error-handler";
import { CLASS_NOTES_ERROR_CODES, resolveClassLectureForTeacher } from "@/services/class-notes-service";
import { addQuizToLectureForTeacher, listQuizzesForLectureForTeacher } from "@/services/lecture-service";

export type ClassQuizzesSection = "GENERAL" | "LECTURE";

/** The section's display label: never the default lecture's internal title (lib/coursework-lecture.ts). */
export { GENERAL_QUIZZES_LABEL };

/**
 * The resolved lecture. For General Quizzes `title` and `date` are null: the
 * default lecture's internal title and creation date are not a teaching
 * session's and are never shown.
 */
export type ClassQuizzesLecture = { id: string; isDefault: boolean; title: string | null; date: string | null };

export type ClassQuizDto = Awaited<ReturnType<typeof listQuizzesForLectureForTeacher>>[number];

export type TeacherClassQuizzes = {
  class: { id: string; name: string };
  section: ClassQuizzesSection;
  label: string;
  lecture: ClassQuizzesLecture;
  quizzes: ClassQuizDto[];
};

/** 409 DEFAULT_LECTURE_MISSING (the shared resolver's status and code) in this page's words. */
function asQuizzesError(error: unknown): unknown {
  if (error instanceof AppError && error.code === CLASS_NOTES_ERROR_CODES.DEFAULT_LECTURE_MISSING) {
    return new AppError(
      "This class has no General Quizzes section yet. Ask the administrator to set it up.",
      409,
      CLASS_NOTES_ERROR_CODES.DEFAULT_LECTURE_MISSING
    );
  }
  return error;
}

async function resolveScope(teacherId: string, classId: string, lectureId: string | null | undefined) {
  try {
    return await resolveClassLectureForTeacher(teacherId, classId, lectureId);
  } catch (error) {
    throw asQuizzesError(error);
  }
}

function scopeView(lecture: { id: string; title: string; date: Date; isDefault: boolean }) {
  const section: ClassQuizzesSection = lecture.isDefault ? "GENERAL" : "LECTURE";
  return {
    section,
    label: lecture.isDefault ? GENERAL_QUIZZES_LABEL : lecture.title,
    lecture: lecture.isDefault
      ? { id: lecture.id, isDefault: true, title: null, date: null }
      : { id: lecture.id, isDefault: false, title: lecture.title, date: lecture.date.toISOString() },
  };
}

/**
 * Teacher: the class's General Quizzes (no lectureId) or one normal
 * lecture's quizzes, exactly the lecture API's rows (with their questions and
 * options) and order. 404 CLASS_NOT_FOUND (not the teacher's active class),
 * 409 DEFAULT_LECTURE_MISSING, 404 LECTURE_NOT_FOUND (another class's, a
 * default or a removed lecture).
 */
export async function listClassQuizzesForTeacher(
  teacherId: string,
  classId: string,
  options: { lectureId?: string | null } = {}
): Promise<TeacherClassQuizzes> {
  const { class: cls, lecture } = await resolveScope(teacherId, classId, options.lectureId);
  const quizzes = await listQuizzesForLectureForTeacher(teacherId, lecture.id, { includeDefault: lecture.isDefault });
  return { class: cls, ...scopeView(lecture), quizzes };
}

/**
 * Teacher: creates a quiz in the class's General Quizzes (no lectureId) or in
 * one normal lecture of the class: the existing creation
 * (addQuizToLectureForTeacher: the same quiz, questions, options and student
 * refresh event) on the lecture resolved here. Errors as listClassQuizzesForTeacher.
 */
export async function createClassQuizForTeacher(input: {
  teacherId: string;
  classId: string;
  lectureId?: string | null;
  quiz: CreateQuizInput;
}) {
  const { class: cls, lecture } = await resolveScope(input.teacherId, input.classId, input.lectureId);
  const quiz = await addQuizToLectureForTeacher(input.teacherId, lecture.id, input.quiz, { includeDefault: lecture.isDefault });
  return { class: cls, ...scopeView(lecture), quiz };
}
