import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";

import { isValidSessionVersion } from "@/lib/auth";
import { AppError } from "@/lib/error-handler";
import { sendPasswordChangedEmail } from "@/lib/mailer";
import { prisma } from "@/lib/prisma";
import { studentLoginRateLimiter } from "@/lib/student-login-rate-limit";
import { PASSWORD_MESSAGES, isRegistrationNumberPassword } from "@/lib/student-password-validation";

/*
 * Teacher-initiated student password reset (Student Profile SP-7D). The
 * caller (POST /api/students/[id]/resetpassword) has checked the origin, the
 * teacher session, the body, the password rules and the rate limits.
 *
 *  1. The student is read by { id, teacherId (from the verified session),
 *     status 0 or 1 }. Missing, deleted and another teacher's student give
 *     the same 404 "Student not found." (nothing reveals which).
 *  2. The registration number as password is refused (SP-6C), before bcrypt.
 *  3. Hash (cost 12) BEFORE the transaction.
 *  4. One interactive transaction:
 *       - UPDATE ... WHERE { id, teacherId, status: read, sessionVersion: read }
 *         SET password, sessionVersion + 1 — exactly one row (optimistic
 *         concurrency: a concurrent reset, password change, email reset,
 *         device block, deactivation, deletion or transfer makes it zero);
 *       - every unused STUDENT reset token of the student is marked used;
 *       - the student's CURRENT email is read (the row is locked by the
 *         update, so it is the email at commit).
 *     Any failure rolls everything back.
 *  5. Zero rows: re-read with the same ownership filter -> 404 when the
 *     student is gone / no longer this teacher's, else 409 (try again).
 *     A database write conflict or deadlock (Prisma P2034) is also 409.
 *  6. After the commit only: the registration number's login failures are
 *     cleared (SP-7D.1), then "password changed" to the current email. No
 *     email on file: nothing is sent (no other address is ever used). A
 *     mail failure is logged generically and never changes the result.
 * No student session is issued: every existing one ends (sessionVersion + 1).
 *
 * Lock order: student row, then the student's reset tokens — the same as the
 * SP-5.6 password change. The SP-7B email reset takes them the other way
 * round (token, then student); see the SP-7D report.
 */

const HASH_ROUNDS = 12;
const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;
/** 0 = active, 1 = inactive (may be reset, as before); 2 = deleted (never). */
const RESETTABLE_STATUSES = [0, 1];

export type TeacherStudentPasswordResetResult = {
  /** Whether a "password changed" email was sent to the student's current address. */
  notification: "sent" | "no-email" | "failed";
};

class ConflictSignal extends Error {}

function studentNotFound() {
  return new AppError("Student not found.", 404, "STUDENT_NOT_FOUND");
}

function resetConflict() {
  return new AppError("The student's account changed while the password was being reset. Please try again.", 409, "PASSWORD_RESET_CONFLICT");
}

function ownedStudentWhere(teacherId: string, studentId: string) {
  return { id: studentId, teacherId, status: { in: RESETTABLE_STATUSES } };
}

export async function resetStudentPasswordByTeacher(input: {
  teacherId: string;
  studentId: string;
  password: string;
}): Promise<TeacherStudentPasswordResetResult> {
  const { teacherId, studentId, password } = input;

  const student = await prisma.student.findFirst({
    where: ownedStudentWhere(teacherId, studentId),
    select: { status: true, sessionVersion: true, registrationNumber: true },
  });
  if (!student) throw studentNotFound();
  if (!isValidSessionVersion(student.sessionVersion)) {
    throw new Error("Invalid student session version in the database.");
  }

  if (isRegistrationNumberPassword(password, student.registrationNumber)) {
    throw new AppError(PASSWORD_MESSAGES.registrationNumber, 400, "VALIDATION_ERROR", { field: "password" });
  }

  const passwordHash = await bcrypt.hash(password, HASH_ROUNDS);

  let currentEmail: string | null;
  try {
    currentEmail = await prisma.$transaction(async (tx) => {
      const updated = await tx.student.updateMany({
        where: { id: studentId, teacherId, status: student.status, sessionVersion: student.sessionVersion },
        data: { password: passwordHash, sessionVersion: { increment: 1 } },
      });
      if (updated.count !== 1) throw new ConflictSignal();

      await tx.passwordResetToken.updateMany({
        where: { role: "STUDENT", userId: studentId, usedAt: null },
        data: { usedAt: new Date() },
      });

      const current = await tx.student.findUnique({ where: { id: studentId }, select: { email: true } });
      return current?.email?.trim() ? current.email : null;
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    if (error instanceof ConflictSignal) {
      const still = await prisma.student.findFirst({ where: ownedStudentWhere(teacherId, studentId), select: { id: true } });
      throw still ? resetConflict() : studentNotFound();
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") throw resetConflict();
    throw error;
  }

  // ---- After the commit only ----

  // SP-7D.1: the student can sign in with the new password straight away
  // (the same clearing as after an email reset, SP-7B). In-memory only; a
  // failure here never affects the committed reset and logs nothing.
  if (student.registrationNumber) {
    try {
      studentLoginRateLimiter().clearRegistrationFailures(student.registrationNumber);
    } catch {
      // Nothing to undo: the password is already changed.
    }
  }

  if (!currentEmail) {
    console.warn("[teacher-password-reset] Password reset; no email on file, so no notification was sent.");
    return { notification: "no-email" };
  }

  try {
    await sendPasswordChangedEmail({ to: currentEmail, by: "teacher" });
    return { notification: "sent" };
  } catch (error) {
    // The reset stands. No address, password or token is logged (sendEmail
    // has already logged the masked recipient).
    console.error(`[teacher-password-reset] Password-changed notification failed (${error instanceof Error ? error.name : "unknown error"}).`);
    return { notification: "failed" };
  }
}
