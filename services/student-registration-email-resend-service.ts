import { StudentConfirmationStatus, StudentRegistrationSource } from "@prisma/client";

import { AppError, getErrorMessage } from "@/lib/error-handler";
import { sendStudentRegistrationEmail } from "@/lib/mailer";
import { prisma } from "@/lib/prisma";
import { sendEmailConfirmationCode } from "@/services/auth-service";

/**
 * Teacher-triggered resend of the two emails a student receives at
 * registration (services/student-service.ts: createStudent and
 * RegisterStudentViaPublicClasses):
 *
 *   1. the "Welcome to SLClassroom" email (sendStudentRegistrationEmail), and
 *   2. the email confirmation code (sendEmailConfirmationCode).
 *
 * Purely additive: it calls those same senders and templates and changes
 * nothing about registration, verification or login. Sending a new code
 * invalidates the earlier unused one, exactly like the existing
 * "resend code" flow (resendEmailConfirmationCode).
 */

/**
 * Same window as lib/email-verification.ts uses to throttle new codes. Checked
 * here *before* anything is sent, so a repeated click inside the window never
 * resends the welcome email and then fails on the code.
 */
export const RESEND_COOLDOWN_SECONDS = 60;

/** Matches createStudent's className for a teacher-added student. */
const NO_CLASS_LABEL = "No classes assigned yet";

/** Students whose resend is currently running (single Next process in production). */
const inFlight = new Set<string>();

export type RegistrationEmailResendOutcome = "SENT" | "PARTIAL";

export type RegistrationEmailResendResult = {
  email: string;
  outcome: RegistrationEmailResendOutcome;
  registrationEmailSent: boolean;
  confirmationCodeSent: boolean;
};

function logAttempt(fields: Record<string, string | number | boolean>) {
  const lines = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
  console.log(`[REGISTRATION_EMAIL_RESEND]\n${lines.join("\n")}`);
}

export async function resendStudentRegistrationEmails(
  teacherId: string,
  studentId: string
): Promise<RegistrationEmailResendResult> {
  if (inFlight.has(studentId)) {
    throw new AppError(
      "Registration emails are already being resent for this student. Please wait.",
      409,
      "RESEND_IN_PROGRESS"
    );
  }

  inFlight.add(studentId);

  try {
    return await resend(teacherId, studentId);
  } finally {
    inFlight.delete(studentId);
  }
}

async function resend(teacherId: string, studentId: string): Promise<RegistrationEmailResendResult> {
  // Ownership and every eligibility rule are checked here, on the server,
  // regardless of whether the page showed the button.
  const student = await prisma.student.findFirst({
    where: {
      id: studentId,
      teacherId,
      status: { not: 2 },
    },
    select: {
      id: true,
      name: true,
      email: true,
      registrationNumber: true,
      registrationSource: true,
      confirmationStatus: true,
      emailConfirmed: true,
      registeredAt: true,
      publicClass: { select: { name: true } },
      teacher: { select: { name: true } },
    },
  });

  if (!student) {
    throw new AppError("Student not found.", 404, "STUDENT_NOT_FOUND");
  }

  if (student.emailConfirmed) {
    throw new AppError(
      "This student's email is already verified.",
      409,
      "EMAIL_ALREADY_VERIFIED"
    );
  }

  if (student.confirmationStatus === StudentConfirmationStatus.REJECTED) {
    throw new AppError(
      "This student's registration was declined.",
      409,
      "STUDENT_REGISTRATION_DECLINED"
    );
  }

  const email = student.email?.trim() ?? "";

  if (!email) {
    throw new AppError(
      "This student has no email address.",
      400,
      "STUDENT_EMAIL_MISSING"
    );
  }

  const recentCode = await prisma.emailVerificationCode.findFirst({
    where: {
      role: "STUDENT",
      userId: student.id,
      usedAt: null,
      createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_SECONDS * 1000) },
    },
    select: { id: true },
  });

  if (recentCode) {
    logAttempt({ teacherId, studentId: student.id, outcome: "THROTTLED" });
    throw new AppError(
      "Registration emails were sent to this student moments ago. Please wait a minute before resending.",
      429,
      "RESEND_THROTTLED"
    );
  }

  // Same inputs the original registration used.
  const className =
    student.registrationSource === StudentRegistrationSource.PUBLIC_CLASS && student.publicClass
      ? student.publicClass.name
      : NO_CLASS_LABEL;

  let registrationEmailSent = false;
  let registrationEmailError = "";

  try {
    await sendStudentRegistrationEmail({
      to: email,
      studentName: student.name,
      registrationNumber: student.registrationNumber ?? "",
      teacherName: student.teacher.name,
      className,
      registrationDate: student.registeredAt.toLocaleDateString(),
    });
    registrationEmailSent = true;
  } catch (error) {
    registrationEmailError = getErrorMessage(error);
  }

  let confirmationCodeSent = false;
  let confirmationCodeError = "";

  try {
    await sendEmailConfirmationCode("STUDENT", student.id, email);
    confirmationCodeSent = true;
  } catch (error) {
    confirmationCodeError = getErrorMessage(error);
  }

  const outcome = registrationEmailSent && confirmationCodeSent
    ? "SENT"
    : registrationEmailSent || confirmationCodeSent
    ? "PARTIAL"
    : "FAILED";

  logAttempt({
    teacherId,
    studentId: student.id,
    outcome,
    registrationEmailSent,
    confirmationCodeSent,
    ...(registrationEmailError ? { registrationEmailError: JSON.stringify(registrationEmailError) } : {}),
    ...(confirmationCodeError ? { confirmationCodeError: JSON.stringify(confirmationCodeError) } : {}),
  });

  if (outcome === "FAILED") {
    throw new AppError(
      "Neither registration email could be sent. Please try again later.",
      502,
      "REGISTRATION_EMAILS_FAILED"
    );
  }

  return { email, outcome, registrationEmailSent, confirmationCodeSent };
}
