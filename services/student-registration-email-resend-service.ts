import { EmailDeliveryType, Prisma, StudentConfirmationStatus } from "@prisma/client";

import { isValidSessionVersion } from "@/lib/auth";
import { EmailPayloadKeyError, assertEmailPayloadEncryptionConfigured } from "@/lib/email-payload-crypto";
import { AppError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { wakeEmailDeliveryWorker } from "@/services/email-delivery-worker";
import { createCredentialResendDelivery } from "@/services/student-email-delivery-service";
import { issueTemporaryStudentPassword } from "@/services/student-welcome-credentials-service";

/**
 * Teacher-triggered "Resend Login Details": a FRESH temporary password in the
 * standard welcome email, through the common email outbox
 * (services/student-email-delivery-service.ts). No confirmation code and no
 * old registration email.
 *
 *   1. Ownership and eligibility, on the server: the teacher's own student
 *      (status active or inactive, never deleted), registration not declined,
 *      an email address and a registration number on file. Email
 *      confirmation status does not matter.
 *   2. Throttles: one resend REQUEST per student per RESEND_COOLDOWN_SECONDS
 *      (from the database), at most one unresolved resend per student
 *      (EmailDelivery.activeOperationKey, unique), one request in flight per
 *      student in this process; the route adds the teacher password-reset
 *      rate limits (per teacher / address / global).
 *   3. The new password is generated and hashed; the email record is written
 *      with the password ENCRYPTED and the new hash waiting
 *      (pendingPasswordHash). The student's CURRENT password is NOT changed.
 *   4. The background worker sends the email (retries reuse the same
 *      password). Only after the provider accepted it is the new password
 *      activated, in one transaction conditional on the account being
 *      unchanged since this request: then the previous password stops working
 *      and existing sessions end. Devices, approvals, enrolments, the teacher
 *      link and passwordSetupPending are never touched.
 *   5. Nothing secret is returned or logged; the answer says "queued".
 */

export const RESEND_COOLDOWN_SECONDS = 60;

/** 0 = active, 1 = inactive (may be resent, as before); 2 = deleted (never). */
const RESENDABLE_STATUSES = [0, 1];

/** Students whose resend request is being created (single Next process in production). */
const inFlight = new Set<string>();

/** Tests only. */
export function resetRegistrationEmailResendStateForTests() {
  inFlight.clear();
}

export type RegistrationEmailResendResult = {
  email: string;
  outcome: "QUEUED";
  deliveryId: string;
};

function logAttempt(fields: Record<string, string | number | boolean>) {
  const lines = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
  console.log(`[REGISTRATION_EMAIL_RESEND]\n${lines.join("\n")}`);
}

export async function resendStudentRegistrationEmails(
  teacherId: string,
  studentId: string,
  options: { now?: () => Date } = {}
): Promise<RegistrationEmailResendResult> {
  if (inFlight.has(studentId)) {
    throw new AppError("New login details are already being prepared for this student. Please wait.", 409, "RESEND_IN_PROGRESS");
  }

  inFlight.add(studentId);

  try {
    return await queueResend(teacherId, studentId, options.now ?? (() => new Date()));
  } finally {
    inFlight.delete(studentId);
  }
}

async function queueResend(teacherId: string, studentId: string, now: () => Date): Promise<RegistrationEmailResendResult> {
  const student = await prisma.student.findFirst({
    where: { id: studentId, teacherId, status: { in: RESENDABLE_STATUSES } },
    select: {
      id: true,
      status: true,
      sessionVersion: true,
      password: true,
      email: true,
      registrationNumber: true,
      confirmationStatus: true,
    },
  });

  if (!student) {
    throw new AppError("Student not found.", 404, "STUDENT_NOT_FOUND");
  }
  if (!isValidSessionVersion(student.sessionVersion)) {
    throw new Error("Invalid student session version in the database.");
  }
  if (student.confirmationStatus === StudentConfirmationStatus.REJECTED) {
    throw new AppError("This student's registration was declined.", 409, "STUDENT_REGISTRATION_DECLINED");
  }

  const email = student.email?.trim() ?? "";
  if (!email) {
    throw new AppError("This student has no email address. Add one before sending login details.", 400, "STUDENT_EMAIL_MISSING");
  }
  if (!student.registrationNumber?.trim()) {
    throw new AppError("This student has no registration number, so they cannot sign in yet.", 409, "STUDENT_REGISTRATION_NUMBER_MISSING");
  }

  try {
    assertEmailPayloadEncryptionConfigured();
  } catch (error) {
    if (error instanceof EmailPayloadKeyError) {
      console.error("[REGISTRATION_EMAIL_RESEND] EMAIL_PAYLOAD_ENCRYPTION_KEY is not configured; nothing was queued.");
      throw new AppError(
        "Login details cannot be sent right now: the server's email encryption is not configured. Nothing was changed; the student's current password still works. Please contact the administrator.",
        503,
        "EMAIL_ENCRYPTION_NOT_CONFIGURED"
      );
    }
    throw error;
  }

  const recent = await prisma.emailDelivery.findFirst({
    where: {
      studentId: student.id,
      emailType: EmailDeliveryType.STUDENT_CREDENTIAL_RESEND,
      createdAt: { gt: new Date(now().getTime() - RESEND_COOLDOWN_SECONDS * 1000) },
    },
    select: { id: true },
  });
  if (recent) {
    logAttempt({ teacherId, studentId: student.id, outcome: "THROTTLED" });
    throw new AppError(
      "New login details were requested for this student moments ago. Please wait a minute before requesting them again.",
      429,
      "RESEND_THROTTLED"
    );
  }

  const credentials = await issueTemporaryStudentPassword();

  let delivery: { id: string };
  try {
    delivery = await createCredentialResendDelivery(
      {
        studentId: student.id,
        teacherId,
        recipientEmail: email,
        temporaryPassword: credentials.temporaryPassword,
        passwordHash: credentials.passwordHash,
        currentPasswordHash: student.password,
        currentSessionVersion: student.sessionVersion,
      },
      { now: now() }
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(
        "New login details for this student are still being sent. Check the email delivery history before requesting new ones.",
        409,
        "RESEND_IN_PROGRESS"
      );
    }
    throw error;
  }

  logAttempt({ teacherId, studentId: student.id, outcome: "QUEUED", deliveryId: delivery.id });
  wakeEmailDeliveryWorker();

  return { email, outcome: "QUEUED", deliveryId: delivery.id };
}
