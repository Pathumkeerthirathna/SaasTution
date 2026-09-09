import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

type EmailOwnerExclusion = {
  teacherId?: string;
  studentId?: string;
  guardianId?: string;
};

/**
 * An email address must be unique across every kind of account — a teacher, a
 * student and a guardian may never share one. Postgres cannot express a
 * cross-table unique constraint, so this is enforced here and must be called
 * wherever any of those three emails is set or changed.
 *
 * Pass the id of the record being updated in `exclude` so its own current
 * email does not count as a collision.
 */
export async function assertEmailAvailable(
  email: string,
  exclude: EmailOwnerExclusion = {}
): Promise<void> {
  const normalized = email.trim().toLowerCase();

  if (!normalized) {
    return;
  }

  const [teacher, student, guardian] = await Promise.all([
    prisma.teacher.findFirst({
      where: { email: normalized },
      select: { id: true },
    }),
    prisma.student.findFirst({
      where: { email: normalized },
      select: { id: true },
    }),
    prisma.guardian.findFirst({
      where: { email: normalized },
      select: { id: true },
    }),
  ]);

  const takenByTeacher = teacher && teacher.id !== exclude.teacherId;
  const takenByStudent = student && student.id !== exclude.studentId;
  const takenByGuardian = guardian && guardian.id !== exclude.guardianId;

  if (takenByTeacher || takenByStudent || takenByGuardian) {
    throw new AppError(
      "This email is already in use by another account.",
      409,
      "EMAIL_ALREADY_EXISTS"
    );
  }
}
