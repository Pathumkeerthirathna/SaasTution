import bcrypt from "bcryptjs";

import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { PASSWORD_MESSAGES, isRegistrationNumberPassword } from "@/lib/student-password-validation";
import { checkStudentSessionAccess, type StudentTokenPayload } from "@/lib/student-session";

/*
 * Student password change (Student Profile SP-5.6): the database part. The
 * caller (lib/student-password-change-http.ts) has already checked the
 * origin, the central student session, the rate limits and the input.
 *
 *  1. Read the stored hash, fresh name / email and the registration number
 *     (the token's student only); a new password equal to the registration
 *     number is refused (SP-6C) before any bcrypt work.
 *  2. Verify the current password; wrong -> 400 INVALID_CURRENT_PASSWORD and
 *     nothing is written (no session is affected).
 *  3. Only then hash the new password (cost 12, as everywhere else).
 *  4. One interactive transaction: the password and sessionVersion + 1 in a
 *     single UPDATE conditioned on { id, status: 0, sessionVersion: expected },
 *     exactly one row or the transaction is rolled back; then every unused
 *     student password-reset token is marked used. Any failure rolls back both.
 *  5. Zero rows: the session is re-checked centrally -> 401 (revoked / deleted),
 *     403 (inactive) or 409 (unexpected while still active).
 */

const HASH_ROUNDS = 12;
const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;
const ACTIVE_STATUS = 0;

class ConflictSignal extends Error {}

export type StudentPasswordChangeResult = {
  studentId: string;
  sessionVersion: number;
  name: string;
  email: string;
};

export async function changeStudentPassword(input: {
  session: StudentTokenPayload;
  currentPassword: string;
  newPassword: string;
}): Promise<StudentPasswordChangeResult> {
  const { session } = input;
  const studentId = session.sub;
  const expectedVersion = session.sessionVersion;

  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { password: true, name: true, email: true, registrationNumber: true },
  });

  if (!student || !student.password) {
    throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
  }

  // SP-6C: never the registration number (from the student's own record),
  // checked like the other input rules, before any bcrypt work.
  if (isRegistrationNumberPassword(input.newPassword, student.registrationNumber)) {
    throw new AppError(PASSWORD_MESSAGES.registrationNumber, 400, "VALIDATION_ERROR", { field: "newPassword" });
  }

  const matches = await bcrypt.compare(input.currentPassword, student.password);
  if (!matches) {
    throw new AppError("Current password is incorrect.", 400, "INVALID_CURRENT_PASSWORD");
  }

  const passwordHash = await bcrypt.hash(input.newPassword, HASH_ROUNDS);

  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.student.updateMany({
        where: { id: studentId, status: ACTIVE_STATUS, sessionVersion: expectedVersion },
        data: { password: passwordHash, sessionVersion: { increment: 1 } },
      });
      if (updated.count !== 1) throw new ConflictSignal();

      await tx.passwordResetToken.updateMany({
        where: { role: "STUDENT", userId: studentId, usedAt: null },
        data: { usedAt: new Date() },
      });
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    if (!(error instanceof ConflictSignal)) throw error;
    const access = await checkStudentSessionAccess(session);
    if (access === "INACTIVE") {
      throw new AppError("Your student account is inactive. Please contact your teacher.", 403, "STUDENT_ACCOUNT_INACTIVE");
    }
    if (access === "INVALID") {
      throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    }
    throw new AppError("Your password could not be changed. Please try again.", 409, "PASSWORD_CHANGE_CONFLICT");
  }

  return {
    studentId,
    sessionVersion: expectedVersion + 1,
    name: student.name,
    // The login flow requires an email; should it have been removed since, the
    // session's own (already verified) email keeps the new token valid.
    email: student.email ?? session.email,
  };
}
