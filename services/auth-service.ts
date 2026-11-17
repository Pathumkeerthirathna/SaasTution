import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { Prisma, StudentConfirmationStatus, type Role } from "@prisma/client";
import { z } from "zod";

import { isValidSessionVersion, studentSessionVersionOf } from "@/lib/auth";
import { AppError } from "@/lib/error-handler";
import {
  LoginRateLimitedError,
  MAX_LOGIN_REGISTRATION_NUMBER_LENGTH,
  normalizeLoginRegistrationNumber,
  studentLoginRateLimiter,
} from "@/lib/student-login-rate-limit";
import {
  PASSWORD_MESSAGES,
  STUDENT_PASSWORD_MAX_BYTES,
  STUDENT_PASSWORD_MAX_LENGTH,
  STUDENT_PASSWORD_MIN_LENGTH,
  isRegistrationNumberPassword,
  studentNewPasswordSchema,
  utf8ByteLength,
} from "@/lib/student-password-validation";
import { assertEmailAvailable } from "@/lib/email-uniqueness";
import { isRegistrationNumberTooLong } from "@/lib/student-validation";
import { buildPasswordResetLink, sendPasswordChangedEmail, sendPasswordResetEmail, sendEmailVerificationCodeEmail } from "@/lib/mailer";
import { createEmailVerificationCode, verifyEmailConfirmationCode } from "@/lib/email-verification";
import { prisma } from "@/lib/prisma";
import { defaultProfileSectionsCreateInput } from "@/services/teacher-profile-section-service";

const HASH_ROUNDS = 12;
const PASSWORD_RESET_TTL_MINUTES = 30;

export type LoginUser = {
  id: string;
  name: string;
  email: string;
};

export type LoginResult =
  | {
      user: LoginUser;
      role: "TEACHER";
      redirectTo: "/dashboard";
    }
  | {
      user: LoginUser;
      role: "STUDENT";
      redirectTo: "/student/dashboard";
      studentStatus: {
        isActive: boolean;
        isConfirmed: boolean;
      };
      /** From the authenticated student record; signed into the JWT as `sv`. */
      sessionVersion: number;
      /**
       * The password is still the emailed temporary one and the optional
       * "Secure Your Account" step has not been answered (Student.passwordSetupPending).
       */
      passwordSetupPending: boolean;
    };

/**
 * Roles whose password updatePasswordForAuthenticatedUser changes. Students
 * use the hardened flow instead (services/student-password-change-service.ts,
 * Student Profile SP-5.6).
 */
type PasswordOwnerRole = "TEACHER" | "GUARDIAN";

function hashResetToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createRawResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Issues a reset link (Student Profile SP-7C): 32 random bytes; only their
 * SHA-256 is stored, with the account's current email and a 30-minute
 * expiry. One active link per account: in the same transaction, every
 * earlier unused link of that account is marked used FIRST, then the new
 * one is created, so the link just issued is never affected and repeated
 * requests never accumulate active links. The raw token is returned only to
 * build the emailed link.
 */
async function createPasswordResetToken(params: {
  role: Role;
  userId: string;
  email: string;
}) {
  const rawToken = createRawResetToken();
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000);

  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.updateMany({
      where: { role: params.role, userId: params.userId, usedAt: null },
      data: { usedAt: new Date() },
    });

    await tx.passwordResetToken.create({
      data: {
        tokenHash,
        role: params.role,
        userId: params.userId,
        email: params.email,
        expiresAt,
      },
    });
  });

  return rawToken;
}

export async function findTeacherByEmail(email: string) {
  return prisma.teacher.findUnique({
    where: { email },
  });
}

export async function findStudentByRegistrationNumber(registrationNumber: string) {
  return prisma.student.findFirst({
    where: {
      registrationNumber: registrationNumber.toUpperCase(),
      // A deleted student's number may be reused by a new student: the
      // lookup must reach the current holder, never the deleted record.
      status: { not: 2 },
    },
  });
}

export async function registerTeacher(input: {
  name: string;
  email: string;
  password: string;
  contact: string;
}) {
  const existingTeacher = await findTeacherByEmail(input.email);

  if (existingTeacher) {
    throw new AppError(
      "A teacher account already exists with this email.",
      409,
      "EMAIL_ALREADY_EXISTS"
    );
  }

  // An email may not be shared with a student or guardian account either.
  await assertEmailAvailable(input.email, { type: "TEACHER" });

  const hashedPassword = await bcrypt.hash(input.password, HASH_ROUNDS);

  const teacher = await prisma.teacher.create({
    data: {
      name: input.name,
      email: input.email,
      password: hashedPassword,
      contact: input.contact,
      profileSections: defaultProfileSectionsCreateInput(),
    },
    select: {
      id: true,
      name: true,
      email: true,
      contact: true,
      createdAt: true,
    },
  });

  try {
    await sendEmailConfirmationCode("TEACHER", teacher.id, teacher.email);
  } catch (error) {
    console.error("Failed to send teacher email confirmation code:", error);
  }

  return teacher;
}

/**
 * Generates a fresh confirmation code for a teacher or student and emails
 * it to them. Used at registration and whenever a code needs to be resent.
 */
export async function sendEmailConfirmationCode(
  role: "TEACHER" | "STUDENT",
  userId: string,
  email: string
) {
  const code = await createEmailVerificationCode({ role, userId, email });
  await sendEmailVerificationCodeEmail({ to: email, code });
}

export async function loginTeacher(email: string, password: string) {
  const teacher = await findTeacherByEmail(email);

  if (!teacher) {
    throw new AppError("Invalid email or password.", 401, "INVALID_CREDENTIALS");
  }

  const isPasswordValid = await bcrypt.compare(password, teacher.password);

  if (!isPasswordValid) {
    throw new AppError("Invalid email or password.", 401, "INVALID_CREDENTIALS");
  }

  if (!teacher.emailConfirmed) {
    throw new AppError(
      "Please confirm your email before signing in. We've sent a confirmation code to your inbox.",
      403,
      "EMAIL_NOT_CONFIRMED",
      { email: teacher.email }
    );
  }

  if (teacher.isBlocked) {
    throw new AppError(
      teacher.blockReason
        ? `Your account has been blocked by the administrator. Reason: ${teacher.blockReason}`
        : "Your account has been blocked by the administrator.",
      403,
      "TEACHER_BLOCKED",
      { reason: teacher.blockReason ?? null }
    );
  }

  if (teacher.isRejected) {
    throw new AppError(
      "Your account has been rejected. Please contact our hotline for more information.",
      403,
      "TEACHER_REGISTRATION_REJECTED"
    );
  }

  return {
    id: teacher.id,
    name: teacher.name,
    email: teacher.email,
    createdAt: teacher.createdAt,
  };
}

/** The one answer for every invalid student credential (SP-6D). */
function invalidStudentCredentials() {
  return new AppError("Invalid registration number or password.", 401, "INVALID_CREDENTIALS");
}

/**
 * A fixed bcrypt hash (cost 12, as every stored password) of 32 random bytes
 * that were discarded when it was made: nothing matches it. Unknown students
 * and students without a password are compared against it, so every login
 * attempt costs one bcrypt comparison and the timing does not reveal whether
 * the account exists or has a password (Student Profile SP-6D).
 */
const DUMMY_PASSWORD_HASH = "$2b$12$ihvuTmqmgR2EAImt10.FF.sO5pHKTLP68Q4K5Y24Z89ywXpy.h6.G";

export type StudentLoginContext = {
  /** The trusted client address (lib/error-logging/request-trust.ts clientKey), or null. */
  clientKey?: string | null;
};

export async function loginStudent(registrationNumber: string, password: string, context: StudentLoginContext = {}) {
  const limiter = studentLoginRateLimiter();
  const clientKey = context.clientKey ?? null;

  // SP-6F: no registration number is this long. An over-long one is an
  // invalid credential like any other (same answer), but it creates no
  // per-number limiter key and costs no database lookup or bcrypt work; it
  // still counts against the address and global failure budgets.
  if (normalizeLoginRegistrationNumber(registrationNumber).length > MAX_LOGIN_REGISTRATION_NUMBER_LENGTH) {
    const counted = limiter.failWithoutRegistration(clientKey);
    if (!counted.allowed) throw new LoginRateLimitedError(counted.retryAfterSeconds);
    throw invalidStudentCredentials();
  }

  // Student Profile SP-6D: rate limits first (before any bcrypt work). Every
  // attempt, known number or not, reserves the same budget.
  const gate = limiter.begin(registrationNumber, clientKey);
  if (!gate.allowed) {
    throw new LoginRateLimitedError(gate.retryAfterSeconds);
  }
  const { ticket } = gate;

  let student: Awaited<ReturnType<typeof findStudentByRegistrationNumber>>;
  try {
    student = await findStudentByRegistrationNumber(registrationNumber);

    // A deleted student (status 2) is treated exactly like an unknown one.
    const storedHash = student && student.password && student.status !== 2 ? student.password : null;

    // Always exactly one comparison (the dummy hash when there is nothing to
    // compare), so an unknown number or a missing password costs the same time.
    const passwordMatches = await bcrypt.compare(password, storedHash ?? DUMMY_PASSWORD_HASH);

    // One answer for every invalid credential: unknown, no password, wrong
    // password, or (SP-6C) the registration number itself — even when it is
    // the stored password. Counted as a failure; nothing about the account
    // (email, approval, status, devices) is revealed for it.
    if (!student || !storedHash || !passwordMatches || isRegistrationNumberPassword(password, student.registrationNumber)) {
      ticket.fail();
      throw invalidStudentCredentials();
    }

    // Correct credentials: the number's failures are cleared; nothing is
    // counted against the address or globally.
    ticket.succeed();
  } catch (error) {
    ticket.release(); // an unexpected error (database) is not a credential failure; no-op once settled
    throw error;
  }
  if (!student) throw invalidStudentCredentials(); // unreachable (settled above); narrows the type

  // Only told after the password is verified, so this can't be used to probe
  // which registration numbers exist or are missing an email.
  if (!student.email) {
    const profile = await prisma.teacherProfile.findUnique({
      where: { teacherId: student.teacherId },
      select: {
        phone: true,
        whatsapp: true,
        teacher: { select: { name: true } },
      },
    });

    throw new AppError(
      "No email is linked to this account. Please ask your teacher to add one.",
      403,
      "STUDENT_EMAIL_MISSING",
      {
        teacherName: profile?.teacher.name ?? null,
        phone: profile?.phone ?? null,
        whatsapp: profile?.whatsapp ?? null,
      }
    );
  }

  // Simplified student registration: students no longer confirm their email
  // before signing in (their login details were sent to it, and every new
  // device still needs the teacher's approval). Teachers keep the email
  // confirmation step (loginTeacher, unchanged).

  if (student.confirmationStatus === StudentConfirmationStatus.PENDING) {
    const profile = await prisma.teacherProfile.findUnique({
      where: { teacherId: student.teacherId },
      select: {
        phone: true,
        whatsapp: true,
        teacher: { select: { name: true } },
      },
    });

    throw new AppError(
      "Your registration is waiting for your teacher's approval. You'll be able to sign in once they confirm it.",
      403,
      "STUDENT_PENDING_APPROVAL",
      {
        teacherName: profile?.teacher.name ?? null,
        phone: profile?.phone ?? null,
        whatsapp: profile?.whatsapp ?? null,
      }
    );
  }

  if (student.confirmationStatus === StudentConfirmationStatus.REJECTED) {
    throw new AppError(
      "Your registration was not approved. Please contact your teacher for help.",
      403,
      "STUDENT_REGISTRATION_REJECTED"
    );
  }

  if (student.status === 1) {
    const profile = await prisma.teacherProfile.findUnique({
      where: { teacherId: student.teacherId },
      select: {
        phone: true,
        whatsapp: true,
        teacher: { select: { name: true } },
      },
    });

    throw new AppError(
      student.deactivationReason
        ? `Your teacher has deactivated your account. Reason: ${student.deactivationReason}`
        : "Your teacher has deactivated your account.",
      403,
      "STUDENT_DEACTIVATED",
      {
        reason: student.deactivationReason ?? null,
        teacherName: profile?.teacher.name ?? null,
        phone: profile?.phone ?? null,
        whatsapp: profile?.whatsapp ?? null,
      }
    );
  }

  return {
    id: student.id,
    name: student.name,
    email: student.email,
    createdAt: student.createdAt,
    confirmationStatus:student.confirmationStatus,
    status:student.status,
    // The record loaded above (no extra query, no new select). Absent until the
    // sessionVersion migration is applied and the client regenerated: then 0.
    sessionVersion: studentSessionVersionOf(student),
    passwordSetupPending: student.passwordSetupPending === true,
  };
}

export async function loginByLoginId(loginId: string, password: string, studentContext: StudentLoginContext = {}): Promise<LoginResult> {
  const normalized = loginId.trim();
  const maybeEmail = normalized.toLowerCase();

  const teacher = await findTeacherByEmail(maybeEmail);

  if (teacher) {
    const authenticatedTeacher = await loginTeacher(maybeEmail, password);
    return {
      role: "TEACHER",
      redirectTo: "/dashboard",
      user: {
        id: authenticatedTeacher.id,
        name: authenticatedTeacher.name,
        email: authenticatedTeacher.email,
      },
    };
  }

  // Only the student branch is rate limited (SP-6D); a teacher returned above.
  const authenticatedStudent = await loginStudent(normalized, password, studentContext);
  return {
    role: "STUDENT",
    redirectTo: "/student/dashboard",
    user: {
      id: authenticatedStudent.id,
      name: authenticatedStudent.name,
      email: authenticatedStudent.email,
    },
    studentStatus:{
      isActive:authenticatedStudent.status==0?true:false,
      isConfirmed:authenticatedStudent.confirmationStatus==StudentConfirmationStatus.APPROVED?true:false
    },
    sessionVersion: authenticatedStudent.sessionVersion,
    passwordSetupPending: authenticatedStudent.passwordSetupPending,
  };
}

// ---- First login: the optional "Secure Your Account" step --------------------------------------------

export type StudentPasswordSetupChoice =
  | { action: "skip" }
  | { action: "set"; newPassword: string; confirmPassword: string };

/** The login request's optional `passwordSetup` field; null when absent or malformed. */
export function parseStudentPasswordSetupChoice(value: unknown): StudentPasswordSetupChoice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.action === "skip") return { action: "skip" };
  if (record.action === "set" && typeof record.newPassword === "string" && typeof record.confirmPassword === "string") {
    return { action: "set", newPassword: record.newPassword, confirmPassword: record.confirmPassword };
  }
  return null;
}

/**
 * Applies the student's first-login choice. The caller (the login route) has
 * just verified the student's CURRENT password through loginStudent (rate
 * limits and every account check included) and passes it as
 * `currentPassword`; nothing here grants a session or touches devices.
 *
 *   skip: the temporary password stays valid; the step is not offered again.
 *   set:  the student password rules (SP-5.6: 8-64 characters, <= 72 bytes),
 *         confirmation must match, never the registration number (SP-6C) or
 *         the current password; hashed at cost 12. Conditional on the step
 *         still being pending (a concurrent answer cannot apply twice). No
 *         session exists yet for a pending student, so sessionVersion is
 *         unchanged; unused reset links are retired, and the usual
 *         "password changed" notice is sent.
 */
export async function applyStudentPasswordSetupChoice(input: {
  studentId: string;
  currentPassword: string;
  choice: StudentPasswordSetupChoice;
}): Promise<void> {
  if (input.choice.action === "skip") {
    await prisma.student.updateMany({
      where: { id: input.studentId, passwordSetupPending: true },
      data: { passwordSetupPending: false },
    });
    return;
  }

  const { newPassword, confirmPassword } = input.choice;
  const parsed = studentNewPasswordSchema.safeParse(newPassword);
  if (!parsed.success) {
    throw new AppError(parsed.error.issues[0]?.message ?? PASSWORD_MESSAGES.newRequired, 400, "VALIDATION_ERROR", { field: "newPassword" });
  }
  if (confirmPassword !== newPassword) {
    throw new AppError(PASSWORD_MESSAGES.mismatch, 400, "VALIDATION_ERROR", { field: "confirmPassword" });
  }
  if (newPassword === input.currentPassword) {
    throw new AppError(PASSWORD_MESSAGES.unchanged, 400, "VALIDATION_ERROR", { field: "newPassword" });
  }

  const student = await prisma.student.findUnique({
    where: { id: input.studentId },
    select: { registrationNumber: true, email: true },
  });
  if (!student) throw new AppError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
  if (isRegistrationNumberPassword(newPassword, student.registrationNumber)) {
    throw new AppError(PASSWORD_MESSAGES.registrationNumber, 400, "VALIDATION_ERROR", { field: "newPassword" });
  }

  const passwordHash = await bcrypt.hash(newPassword, HASH_ROUNDS);
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.student.updateMany({
      where: { id: input.studentId, passwordSetupPending: true, status: 0 },
      data: { password: passwordHash, passwordSetupPending: false },
    });
    if (result.count === 1) {
      await tx.passwordResetToken.updateMany({
        where: { role: "STUDENT", userId: input.studentId, usedAt: null },
        data: { usedAt: new Date() },
      });
    }
    return result.count;
  });
  if (updated !== 1) {
    throw new AppError("Your password could not be changed. Please sign in again.", 409, "PASSWORD_SETUP_CONFLICT");
  }

  if (student.email) {
    try {
      await sendPasswordChangedEmail({ to: student.email });
    } catch (error) {
      console.error(`[first-login] Password-changed notification failed (${error instanceof Error ? error.name : "unknown error"}).`);
    }
  }
}

async function resolveAccountByLoginId(loginId: string): Promise<
  | { role: "TEACHER"; id: string; email: string; emailConfirmed: boolean }
  | { role: "STUDENT"; id: string; email: string; emailConfirmed: boolean }
  | null
> {
  const normalized = loginId.trim();
  const maybeEmail = normalized.toLowerCase();

  const teacher = await findTeacherByEmail(maybeEmail);

  if (teacher) {
    return {
      role: "TEACHER",
      id: teacher.id,
      email: teacher.email,
      emailConfirmed: teacher.emailConfirmed,
    };
  }

  const student = await findStudentByRegistrationNumber(normalized);

  if (student && student.email) {
    return {
      role: "STUDENT",
      id: student.id,
      email: student.email,
      emailConfirmed: student.emailConfirmed,
    };
  }

  return null;
}

/**
 * Validates a submitted confirmation code for whichever teacher or student
 * account `loginId` resolves to. Does not sign the user in — the caller is
 * expected to retry the normal login afterwards.
 */
export async function confirmEmailCode(loginId: string, code: string): Promise<void> {
  const account = await resolveAccountByLoginId(loginId);

  if (!account) {
    throw new AppError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
  }

  if (account.emailConfirmed) {
    return;
  }

  await verifyEmailConfirmationCode({ role: account.role, userId: account.id, code });
}

export async function resendEmailConfirmationCode(loginId: string): Promise<void> {
  const account = await resolveAccountByLoginId(loginId);

  if (!account) {
    throw new AppError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
  }

  if (account.emailConfirmed) {
    throw new AppError("This email is already confirmed.", 400, "ALREADY_CONFIRMED");
  }

  await sendEmailConfirmationCode(account.role, account.id, account.email);
}

/*
 * Password-reset request (Student Profile SP-7C). The caller
 * (lib/password-reset-request-http.ts) has checked the origin, the body and
 * the rate limits; whatever happens here, it answers the same.
 *
 *  - Teachers and guardians: by email (lower-cased), as before; both emails
 *    are unique.
 *  - Students: by REGISTRATION NUMBER ONLY, normalized as at login (trimmed,
 *    upper case, exact match), never by email (student emails are unique
 *    only per teacher). A value longer than 64 characters is no registration
 *    number: no student lookup. Deleted students (status 2) are never
 *    matched; inactive ones (status 1) still are, as before. Anything but
 *    exactly one match issues nothing — no record is chosen arbitrarily.
 *  - The three lookups run for every request, together, so which account
 *    exists changes neither the queries made nor (on a database failure)
 *    the error.
 *  - The link goes to the account's current email. Token or email failures
 *    after an account was found are logged generically (no identifier,
 *    address or token) and never change the answer. The email is sent after
 *    the request returns, so its duration and outcome are not observable.
 */

/** Reset emails still being delivered (in this process). */
const pendingResetEmails = new Set<Promise<void>>();

function logResetRequestFailure(step: "token" | "email", error: unknown) {
  console.error(`[password-reset] Reset request ${step} step failed (${error instanceof Error ? error.name : "unknown error"}).`);
}

/** Sends one reset email without holding up the request; a failure is only logged. */
function dispatchPasswordResetEmail(to: string, resetLink: string) {
  const delivery: Promise<void> = Promise.resolve()
    .then(() => sendPasswordResetEmail({ to, resetLink }))
    .catch((error: unknown) => logResetRequestFailure("email", error))
    .finally(() => {
      pendingResetEmails.delete(delivery);
    });
  pendingResetEmails.add(delivery);
}

/** Tests only: waits until every dispatched reset email has settled. */
export async function settlePasswordResetEmailsForTests(): Promise<void> {
  while (pendingResetEmails.size > 0) await Promise.all([...pendingResetEmails]);
}

async function findPasswordResetAccount(
  loginId: string
): Promise<{ role: "TEACHER" | "GUARDIAN" | "STUDENT"; id: string; email: string } | null> {
  const normalized = loginId.trim();
  const maybeEmail = normalized.toLowerCase();
  const registrationNumber = normalized.toUpperCase();
  const canBeRegistrationNumber = registrationNumber.length > 0 && !isRegistrationNumberTooLong(registrationNumber);

  const [teacher, guardian, students] = await Promise.all([
    prisma.teacher.findUnique({
      where: { email: maybeEmail },
      select: { id: true, email: true },
    }),
    prisma.guardian.findFirst({
      where: { email: maybeEmail },
      select: { id: true, email: true },
    }),
    canBeRegistrationNumber
      ? prisma.student.findMany({
          where: { registrationNumber, status: { not: 2 } },
          select: { id: true, email: true },
          take: 2,
        })
      : Promise.resolve([] as { id: string; email: string | null }[]),
  ]);

  if (teacher) return { role: "TEACHER", id: teacher.id, email: teacher.email };
  if (guardian?.email) return { role: "GUARDIAN", id: guardian.id, email: guardian.email };
  // Exactly one current holder of the number, with an email; otherwise nothing.
  if (students.length === 1 && students[0].email) return { role: "STUDENT", id: students[0].id, email: students[0].email };
  return null;
}

export async function requestPasswordReset(loginId: string, appBaseUrl?: string): Promise<void> {
  const account = await findPasswordResetAccount(loginId);
  if (!account) return;

  let token: string;
  try {
    token = await createPasswordResetToken({ role: account.role, userId: account.id, email: account.email });
  } catch (error) {
    logResetRequestFailure("token", error);
    return;
  }

  dispatchPasswordResetEmail(account.email, buildPasswordResetLink(token, appBaseUrl));
}

/*
 * Password-reset confirmation (Student Profile SP-7B).
 *
 * Every role: the token is looked up (a hint only), the password is hashed
 * OUTSIDE the transaction, and then, in one interactive transaction, the token
 * is CLAIMED with a conditional update { id, usedAt: null, expiresAt > now }
 * that must change exactly one row, followed by the password update. Two
 * requests with the same token: the second claim waits on the first one's row
 * lock and then matches nothing (usedAt is set), so only one succeeds. Any
 * failure after the claim rolls the claim back with everything else.
 *
 * Teacher and guardian: only the claim is new; their update is unchanged.
 *
 * Password rules (SP-7E.1), chosen by the role STORED IN THE TOKEN RECORD
 * (never by anything the client sends), checked before any bcrypt work and
 * before the claim (an invalid password never consumes the link):
 *  - STUDENT:  8–64 characters, <= 72 UTF-8 bytes (SP-5.6), and in the
 *              transaction not the registration number (SP-6C);
 *  - TEACHER:  8–64 characters, an upper-case letter, a lower-case letter
 *              and a digit, <= 72 UTF-8 bytes;
 *  - GUARDIAN: 8–64 characters, <= 72 UTF-8 bytes (bcrypt would otherwise
 *              silently ignore everything after byte 72).
 *
 * Student, in the same transaction after the claim: the student must exist
 * with status 0 or 1 (2 = deleted), the token's email must equal the
 * student's CURRENT email, and the new password must not be the registration
 * number; then password + sessionVersion + 1 in one UPDATE conditioned on
 * { id, status, the version just read } (exactly one row), and every other
 * unused student reset token is marked used. Before the transaction: the
 * SP-5.6 rules (8–64 characters, at most 72 UTF-8 bytes). After the commit
 * only: the number's login failures are cleared and a "password changed"
 * email goes to the current address; a mail failure is logged, never undoes
 * the reset and never changes the response. No session is issued here.
 */

const RESET_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;
/** 0 = active, 1 = inactive (may reset, as before); 2 = deleted (never). */
const STUDENT_RESET_STATUSES = [0, 1];

type ResetTokenRecord = { id: string; role: Role; userId: string; email: string };

/** The approved teacher password rule (as in the teacher UI and SP-7D); the message names what is required. */
export const TEACHER_RESET_PASSWORD_COMPLEXITY_MESSAGE = "Password must include an uppercase letter, a lowercase letter and a number.";

const lengthAndBytes = z
  .string({ error: PASSWORD_MESSAGES.newRequired })
  .min(STUDENT_PASSWORD_MIN_LENGTH, { message: PASSWORD_MESSAGES.tooShort, abort: true })
  .max(STUDENT_PASSWORD_MAX_LENGTH, { message: PASSWORD_MESSAGES.tooLong, abort: true });

const withinBcryptBytes = (value: string) => utf8ByteLength(value) <= STUDENT_PASSWORD_MAX_BYTES;

/** Per token role (SP-7E.1). The student schema is the SP-5.6 one, unchanged. */
const RESET_PASSWORD_SCHEMAS: Record<"STUDENT" | "TEACHER" | "GUARDIAN", z.ZodType<string>> = {
  STUDENT: studentNewPasswordSchema,
  TEACHER: lengthAndBytes
    .refine((value) => /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value), {
      message: TEACHER_RESET_PASSWORD_COMPLEXITY_MESSAGE,
      abort: true,
    })
    .refine(withinBcryptBytes, PASSWORD_MESSAGES.tooManyBytes),
  GUARDIAN: lengthAndBytes.refine(withinBcryptBytes, PASSWORD_MESSAGES.tooManyBytes),
};

class StudentResetConflictSignal extends Error {}

function invalidResetToken() {
  return new AppError("Reset link is invalid or expired.", 400, "INVALID_RESET_TOKEN");
}

function studentResetConflict() {
  return new AppError("Your password could not be reset. Please try again.", 409, "PASSWORD_RESET_CONFLICT");
}

/** The token's email and the current one name the same address (surrounding spaces and letter case ignored). */
function isSameEmail(tokenEmail: string, currentEmail: string | null | undefined): boolean {
  if (typeof currentEmail !== "string") return false;
  const current = currentEmail.trim().toLowerCase();
  return current.length > 0 && current === tokenEmail.trim().toLowerCase();
}

/** Marks the token used if, and only if, it is still unused and unexpired. Exactly one row, or INVALID_RESET_TOKEN. */
async function claimResetToken(tx: Prisma.TransactionClient, tokenId: string) {
  const now = new Date();
  const claimed = await tx.passwordResetToken.updateMany({
    where: { id: tokenId, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) throw invalidResetToken();
}

export async function confirmPasswordReset(token: string, newPassword: string) {
  const tokenHash = hashResetToken(token.trim());
  const resetRecord = await prisma.passwordResetToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: {
        gt: new Date(),
      },
    },
    select: {
      id: true,
      role: true,
      userId: true,
      email: true,
    },
  });

  if (!resetRecord) {
    throw invalidResetToken();
  }

  if (resetRecord.role !== "TEACHER" && resetRecord.role !== "STUDENT" && resetRecord.role !== "GUARDIAN") {
    throw new AppError("Password reset is not supported for this role.", 400, "ROLE_NOT_SUPPORTED");
  }

  // SP-7E.1: the rules of the role stored in the (server-side) token record,
  // before any bcrypt work and before the token is claimed, so an invalid
  // password never consumes the link.
  const parsed = RESET_PASSWORD_SCHEMAS[resetRecord.role].safeParse(newPassword);
  if (!parsed.success) {
    throw new AppError(parsed.error.issues[0]?.message ?? PASSWORD_MESSAGES.newRequired, 400, "VALIDATION_ERROR", { field: "newPassword" });
  }

  const passwordHash = await bcrypt.hash(newPassword, HASH_ROUNDS);

  if (resetRecord.role === "STUDENT") {
    await confirmStudentPasswordReset(resetRecord, newPassword, passwordHash);
    return;
  }

  await prisma.$transaction(async (tx) => {
    await claimResetToken(tx, resetRecord.id);

    if (resetRecord.role === "TEACHER") {
      await tx.teacher.update({
        where: { id: resetRecord.userId },
        data: { password: passwordHash },
      });
    } else {
      await tx.guardian.update({
        where: { id: resetRecord.userId },
        data: { password: passwordHash },
      });
    }
  }, RESET_TRANSACTION_OPTIONS);
}

async function confirmStudentPasswordReset(resetRecord: ResetTokenRecord, newPassword: string, passwordHash: string) {
  let committed: { email: string; registrationNumber: string | null };

  try {
    committed = await prisma.$transaction(async (tx) => {
      await claimResetToken(tx, resetRecord.id);

      const student = await tx.student.findUnique({
        where: { id: resetRecord.userId },
        select: { status: true, email: true, registrationNumber: true, sessionVersion: true },
      });

      // Missing, deleted, or the link was sent to an address the student no
      // longer has: one generic answer, the claim is rolled back.
      if (!student || !STUDENT_RESET_STATUSES.includes(student.status)) throw invalidResetToken();
      if (!student.email || !isSameEmail(resetRecord.email, student.email)) throw invalidResetToken();
      if (!isValidSessionVersion(student.sessionVersion)) {
        throw new Error("Invalid student session version in the database.");
      }

      // SP-6C: never the student's own registration number (a string
      // comparison; no bcrypt work inside the transaction).
      if (isRegistrationNumberPassword(newPassword, student.registrationNumber)) {
        throw new AppError(PASSWORD_MESSAGES.registrationNumber, 400, "VALIDATION_ERROR", { field: "newPassword" });
      }

      const updated = await tx.student.updateMany({
        where: { id: resetRecord.userId, status: student.status, sessionVersion: student.sessionVersion },
        data: { password: passwordHash, sessionVersion: { increment: 1 }, passwordSetupPending: false },
      });
      // Changed since it was read (deleted, deactivated, or another session
      // revocation committed first): roll everything back.
      if (updated.count !== 1) throw new StudentResetConflictSignal();

      await tx.passwordResetToken.updateMany({
        where: { role: "STUDENT", userId: resetRecord.userId, usedAt: null, id: { not: resetRecord.id } },
        data: { usedAt: new Date() },
      });

      return { email: student.email, registrationNumber: student.registrationNumber };
    }, RESET_TRANSACTION_OPTIONS);
  } catch (error) {
    if (error instanceof StudentResetConflictSignal) throw studentResetConflict();
    // A write conflict or deadlock with a concurrent change to the same
    // student (Prisma P2034): rolled back like the conflict above.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") throw studentResetConflict();
    throw error;
  }

  // ---- After the commit only ----

  if (committed.registrationNumber) {
    try {
      studentLoginRateLimiter().clearRegistrationFailures(committed.registrationNumber);
    } catch {
      // In-memory only; never affects the committed reset.
    }
  }

  try {
    await sendPasswordChangedEmail({ to: committed.email });
  } catch (error) {
    // The reset stands. No address, token or password is logged (sendEmail
    // has already logged the masked recipient).
    console.error(`[password-reset] Password-changed notification failed (${error instanceof Error ? error.name : "unknown error"}).`);
  }
}

export async function updatePasswordForAuthenticatedUser(input: {
  role: PasswordOwnerRole;
  userId: string;
  currentPassword: string;
  newPassword: string;
}) {
  // Runtime guard as well as the type: a student password never changes here.
  if ((input.role as string) !== "TEACHER" && (input.role as string) !== "GUARDIAN") {
    throw new AppError("Password change is not supported for this role here.", 400, "ROLE_NOT_SUPPORTED");
  }

  const passwordHash = await bcrypt.hash(input.newPassword, HASH_ROUNDS);

  if (input.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({
      where: { id: input.userId },
      select: { password: true },
    });

    if (!teacher) {
      throw new AppError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
    }

    const passwordMatches = await bcrypt.compare(input.currentPassword, teacher.password);

    if (!passwordMatches) {
      throw new AppError("Current password is incorrect.", 400, "INVALID_CURRENT_PASSWORD");
    }

    await prisma.teacher.update({
      where: { id: input.userId },
      data: { password: passwordHash },
    });
    return;
  }

  const guardian = await prisma.guardian.findUnique({
    where: { id: input.userId },
    select: { password: true },
  });

  if (!guardian || !guardian.password) {
    throw new AppError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
  }

  const passwordMatches = await bcrypt.compare(input.currentPassword, guardian.password);

  if (!passwordMatches) {
    throw new AppError("Current password is incorrect.", 400, "INVALID_CURRENT_PASSWORD");
  }

  await prisma.guardian.update({
    where: { id: input.userId },
    data: { password: passwordHash },
  });
}
