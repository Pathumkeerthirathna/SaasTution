import crypto from "node:crypto";
import type { Role } from "@prisma/client";

import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

const CODE_TTL_MINUTES = 30;
const RESEND_THROTTLE_SECONDS = 60;
const MAX_ATTEMPTS = 5;

function generateNumericCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/**
 * Generates and stores a fresh one-time email-confirmation code for a
 * teacher or student, invalidating any earlier unused codes for that
 * account. Throttled so a client cannot spam new codes faster than
 * `RESEND_THROTTLE_SECONDS`.
 */
export async function createEmailVerificationCode(params: {
  role: Extract<Role, "TEACHER" | "STUDENT">;
  userId: string;
  email: string;
}): Promise<string> {
  const recentCode = await prisma.emailVerificationCode.findFirst({
    where: {
      role: params.role,
      userId: params.userId,
      usedAt: null,
      createdAt: { gt: new Date(Date.now() - RESEND_THROTTLE_SECONDS * 1000) },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  if (recentCode) {
    throw new AppError(
      "A confirmation code was already sent recently. Please wait a moment before requesting another.",
      429,
      "VERIFICATION_CODE_THROTTLED"
    );
  }

  const code = generateNumericCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

  await prisma.$transaction([
    prisma.emailVerificationCode.updateMany({
      where: { role: params.role, userId: params.userId, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.emailVerificationCode.create({
      data: {
        codeHash: hashCode(code),
        role: params.role,
        userId: params.userId,
        email: params.email.trim().toLowerCase(),
        expiresAt,
      },
    }),
  ]);

  return code;
}

/**
 * Validates a submitted confirmation code for a teacher or student and, if
 * correct, marks that account's email as confirmed. A wrong code counts
 * against a small attempt budget per outstanding code so it cannot be
 * brute-forced.
 */
export async function verifyEmailConfirmationCode(params: {
  role: Extract<Role, "TEACHER" | "STUDENT">;
  userId: string;
  code: string;
}): Promise<void> {
  const record = await prisma.emailVerificationCode.findFirst({
    where: {
      role: params.role,
      userId: params.userId,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!record) {
    throw new AppError(
      "This code has expired or is invalid. Please request a new one.",
      400,
      "INVALID_VERIFICATION_CODE"
    );
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    throw new AppError(
      "Too many incorrect attempts. Please request a new code.",
      429,
      "VERIFICATION_CODE_LOCKED"
    );
  }

  const submittedHash = hashCode(params.code.trim());

  if (submittedHash !== record.codeHash) {
    await prisma.emailVerificationCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });

    throw new AppError("Incorrect code. Please try again.", 400, "INVALID_VERIFICATION_CODE");
  }

  await prisma.$transaction(async (tx) => {
    await tx.emailVerificationCode.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });

    if (params.role === "TEACHER") {
      await tx.teacher.update({
        where: { id: params.userId },
        data: { emailConfirmed: true, emailConfirmedAt: new Date() },
      });
    } else {
      await tx.student.update({
        where: { id: params.userId },
        data: { emailConfirmed: true, emailConfirmedAt: new Date() },
      });
    }
  });
}
