import { apiError } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

/**
 * Access guard for teacher-only views of ONE student (e.g. the
 * /api/student/Profile/[StudentId]/* routes behind /dashboard/students/[id]).
 *
 * The caller must be a signed-in teacher (401 otherwise) and the student must
 * belong to that teacher (Student.teacherId). An unknown student and another
 * teacher's student both answer 404, so a student's existence is never
 * confirmed to someone who cannot see it. Every student status is allowed
 * (the owning teacher may review inactive and removed students' history).
 */
export async function requireTeacherOwnedStudent(studentId: unknown) {
  const session = await requireTeacherSession();
  const id = typeof studentId === "string" ? studentId.trim() : "";

  if (!id) {
    throw new AppError("Student not found.", 404, "STUDENT_NOT_FOUND");
  }

  const student = await prisma.student.findFirst({
    where: { id, teacherId: session.teacherId },
    select: { id: true },
  });

  if (!student) {
    throw new AppError("Student not found.", 404, "STUDENT_NOT_FOUND");
  }

  return { teacherId: session.teacherId, studentId: student.id };
}

/**
 * For routes whose catch block reports unexpected errors with
 * reportRouteError and answers 500: an access refusal (or any other AppError)
 * is answered with its own status instead (401 / 404), never turned into a 500.
 * Returns null for anything else, which the caller then reports as before.
 */
export function accessErrorResponse(error: unknown) {
  return error instanceof AppError ? apiError(error.message, error.statusCode, error.code) : null;
}

/**
 * The class must belong to the same teacher (any status, for history views);
 * otherwise 404.
 */
export async function requireTeacherOwnedClass(teacherId: string, classId: unknown) {
  const id = typeof classId === "string" ? classId.trim() : "";

  if (!id) {
    throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
  }

  const classroom = await prisma.class.findFirst({
    where: { id, teacherId },
    select: { id: true },
  });

  if (!classroom) {
    throw new AppError("Class not found.", 404, "CLASS_NOT_FOUND");
  }

  return classroom.id;
}
