/*
 * Class-scoped Assignments (Assignments page, Stage 1: backend).
 *
 * A class's assignments are ordinary Assignment rows on its lectures:
 *  - General Assignments: the assignments of the class's DEFAULT lecture
 *    (Lecture.isDefault = true, the same lecture as General Notes and General
 *    Recordings), resolved on the server from the class; the routes never
 *    accept a default lecture id from the client;
 *  - Lecture Assignments: one NORMAL lecture of that class, checked to belong to it.
 *
 * The lecture is resolved by the shared resolveClassLectureForTeacher
 * (services/class-notes-service.ts: class ownership first, then the default
 * or the normal lecture). Listing and creation are then the existing
 * lecture-service functions, with the default lecture let through only by an
 * explicit `includeDefault` decided here. Everything after creation is the
 * existing per-assignment API (update, permanent deletion, submissions,
 * files, marks: /api/lectures/[lectureId]/assignments/[assignmentId]/...),
 * addressed with the lecture id this API returns.
 */

import type { CreateAssignmentInput } from "@/lib/lecture-validation";
import { GENERAL_ASSIGNMENTS_LABEL } from "@/lib/coursework-lecture";
import { AppError } from "@/lib/error-handler";
import { CLASS_NOTES_ERROR_CODES, resolveClassLectureForTeacher } from "@/services/class-notes-service";
import { addAssignmentToLectureForTeacher, listAssignmentsForLectureForTeacher } from "@/services/lecture-service";

export type ClassAssignmentsSection = "GENERAL" | "LECTURE";

/** The section's display label: never the default lecture's internal title (lib/coursework-lecture.ts). */
export { GENERAL_ASSIGNMENTS_LABEL };

/**
 * The resolved lecture. For General Assignments `title` and `date` are null:
 * the default lecture's internal title and creation date are not a
 * teaching session's and are never shown.
 */
export type ClassAssignmentsLecture = { id: string; isDefault: boolean; title: string | null; date: string | null };

export type ClassAssignmentDto = Awaited<ReturnType<typeof listAssignmentsForLectureForTeacher>>[number];

export type TeacherClassAssignments = {
  class: { id: string; name: string };
  section: ClassAssignmentsSection;
  label: string;
  lecture: ClassAssignmentsLecture;
  assignments: ClassAssignmentDto[];
};

/** 409 DEFAULT_LECTURE_MISSING (the shared resolver's status and code) in this page's words. */
function asAssignmentsError(error: unknown): unknown {
  if (error instanceof AppError && error.code === CLASS_NOTES_ERROR_CODES.DEFAULT_LECTURE_MISSING) {
    return new AppError(
      "This class has no General Assignments section yet. Ask the administrator to set it up.",
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
    throw asAssignmentsError(error);
  }
}

function scopeView(lecture: { id: string; title: string; date: Date; isDefault: boolean }) {
  const section: ClassAssignmentsSection = lecture.isDefault ? "GENERAL" : "LECTURE";
  return {
    section,
    label: lecture.isDefault ? GENERAL_ASSIGNMENTS_LABEL : lecture.title,
    lecture: lecture.isDefault
      ? { id: lecture.id, isDefault: true, title: null, date: null }
      : { id: lecture.id, isDefault: false, title: lecture.title, date: lecture.date.toISOString() },
  };
}

/**
 * Teacher: the class's General Assignments (no lectureId) or one normal
 * lecture's assignments, exactly the lecture API's rows and order (dueDate
 * ascending). 404 CLASS_NOT_FOUND (not the teacher's active class), 409
 * DEFAULT_LECTURE_MISSING, 404 LECTURE_NOT_FOUND (another class's, a default
 * or a removed lecture).
 */
export async function listClassAssignmentsForTeacher(
  teacherId: string,
  classId: string,
  options: { lectureId?: string | null } = {}
): Promise<TeacherClassAssignments> {
  const { class: cls, lecture } = await resolveScope(teacherId, classId, options.lectureId);
  const assignments = await listAssignmentsForLectureForTeacher(teacherId, lecture.id, { includeDefault: lecture.isDefault });
  return { class: cls, ...scopeView(lecture), assignments };
}

/**
 * Teacher: creates an assignment in the class's General Assignments (no
 * lectureId) or in one normal lecture of the class: the existing creation
 * (addAssignmentToLectureForTeacher: the same row, fields and student
 * refresh event) on the lecture resolved here. Errors as
 * listClassAssignmentsForTeacher.
 */
export async function createClassAssignmentForTeacher(input: {
  teacherId: string;
  classId: string;
  lectureId?: string | null;
  assignment: CreateAssignmentInput;
}) {
  const { class: cls, lecture } = await resolveScope(input.teacherId, input.classId, input.lectureId);
  const assignment = await addAssignmentToLectureForTeacher(input.teacherId, lecture.id, input.assignment, {
    includeDefault: lecture.isDefault,
  });
  return { class: cls, ...scopeView(lecture), assignment };
}
