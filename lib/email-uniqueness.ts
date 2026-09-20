import { Prisma } from "@prisma/client";

import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

type EmailAvailabilityContext =
  | { type: "TEACHER"; excludeTeacherId?: string }
  | { type: "STUDENT"; teacherId: string; excludeStudentId?: string }
  | { type: "GUARDIAN"; excludeGuardianId?: string };

/**
 * Email-uniqueness rules for the platform:
 *  - Two teachers may never share an email (global).
 *  - A student may never use any teacher's email, from any teacher (global).
 *  - Two students who belong to the *same* teacher may never share an
 *    email, but two students who belong to *different* teachers may use the
 *    same email — each teacher's students are their own namespace.
 *  - A guardian's email must stay globally unique against every teacher,
 *    student and guardian.
 * Postgres cannot express a cross-table or partially-scoped unique
 * constraint, so this must be called wherever any of these emails is set or
 * changed. Pass the id of the record being updated so its own current email
 * does not count as a collision against itself.
 */
export async function assertEmailAvailable(
  email: string,
  context: EmailAvailabilityContext
): Promise<void> {
  const normalized = email.trim().toLowerCase();

  if (!normalized) {
    return;
  }

  const teacherWhere: Prisma.TeacherWhereInput = { email: normalized };
  if (context.type === "TEACHER" && context.excludeTeacherId) {
    teacherWhere.NOT = { id: context.excludeTeacherId };
  }

  const studentWhere: Prisma.StudentWhereInput = {
    email: { equals: normalized, mode: "insensitive" },
  };
  if (context.type === "STUDENT") {
    studentWhere.teacherId = context.teacherId;
    if (context.excludeStudentId) {
      studentWhere.NOT = { id: context.excludeStudentId };
    }
  }

  const guardianWhere: Prisma.GuardianWhereInput = { email: normalized };
  if (context.type === "GUARDIAN" && context.excludeGuardianId) {
    guardianWhere.NOT = { id: context.excludeGuardianId };
  }

  const [teacher, student, guardian] = await Promise.all([
    prisma.teacher.findFirst({ where: teacherWhere, select: { id: true } }),
    prisma.student.findFirst({ where: studentWhere, select: { id: true } }),
    prisma.guardian.findFirst({ where: guardianWhere, select: { id: true } }),
  ]);

  if (teacher) {
    throw new AppError(
      context.type === "TEACHER"
        ? "A teacher account already exists with this email."
        : "This email is already in use by a teacher account.",
      409,
      "EMAIL_ALREADY_EXISTS"
    );
  }

  if (student) {
    throw new AppError(
      context.type === "STUDENT"
        ? "Another student already uses this email."
        : "This email is already in use by another account.",
      409,
      "EMAIL_ALREADY_EXISTS"
    );
  }

  if (guardian) {
    throw new AppError(
      "This email is already in use by another account.",
      409,
      "EMAIL_ALREADY_EXISTS"
    );
  }
}
