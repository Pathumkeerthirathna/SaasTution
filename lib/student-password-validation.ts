import { z } from "zod";

/*
 * Student password change rules (Student Profile SP-5.6). Shared by the
 * server (lib/student-password-change-http.ts) and the account security form,
 * so the browser checks exactly what the server enforces.
 *
 * Length only, no character-class rules: 8–64 characters (the project's
 * existing password rule) and at most 72 UTF-8 bytes, because bcrypt ignores
 * everything after byte 72 (a Sinhala or Tamil character is 3 bytes, so a
 * long password in those scripts could otherwise be silently shortened).
 * The byte count is the same measure bcryptjs's `truncates()` uses
 * (tests/security/student-password-change.test.cjs checks the parity).
 */

export const STUDENT_PASSWORD_MIN_LENGTH = 8;
export const STUDENT_PASSWORD_MAX_LENGTH = 64;
export const STUDENT_PASSWORD_MAX_BYTES = 72;
export const CURRENT_PASSWORD_MAX_LENGTH = 256;
/** Request body cap for the student password change (three short fields fit easily). */
export const STUDENT_PASSWORD_CHANGE_MAX_BODY_BYTES = 1024;

export const PASSWORD_MESSAGES = {
  currentRequired: "Enter your current password.",
  currentTooLong: "Current password is too long.",
  newRequired: "Enter a new password.",
  tooShort: "Password must be at least 8 characters long.",
  tooLong: "Password must be at most 64 characters long.",
  tooManyBytes: "Password is too long. Use fewer special or non-English characters.",
  confirmRequired: "Confirm your new password.",
  mismatch: "Passwords do not match.",
  unchanged: "Your new password must be different from your current password.",
  registrationNumber: "Your new password must not be your registration number.",
} as const;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * True when `password` IS the registration number (Student Profile SP-6C):
 * the whole value, ignoring surrounding whitespace and letter case. Only
 * equality counts — a password that merely contains the number, or similar
 * characters, is not affected. A missing registration number never matches.
 */
export function isRegistrationNumberPassword(password: string, registrationNumber: string | null | undefined): boolean {
  if (typeof registrationNumber !== "string") return false;
  const number = registrationNumber.trim().toUpperCase();
  return number.length > 0 && password.trim().toUpperCase() === number;
}

export const studentNewPasswordSchema = z
  .string({ error: PASSWORD_MESSAGES.newRequired })
  .min(1, PASSWORD_MESSAGES.newRequired)
  .min(STUDENT_PASSWORD_MIN_LENGTH, PASSWORD_MESSAGES.tooShort)
  .max(STUDENT_PASSWORD_MAX_LENGTH, PASSWORD_MESSAGES.tooLong)
  .refine((value) => utf8ByteLength(value) <= STUDENT_PASSWORD_MAX_BYTES, PASSWORD_MESSAGES.tooManyBytes);

/** The whole request: exactly these three fields (unknown fields are refused). */
export const studentPasswordChangeSchema = z
  .object({
    currentPassword: z
      .string({ error: PASSWORD_MESSAGES.currentRequired })
      .min(1, PASSWORD_MESSAGES.currentRequired)
      .max(CURRENT_PASSWORD_MAX_LENGTH, PASSWORD_MESSAGES.currentTooLong),
    newPassword: studentNewPasswordSchema,
    confirmPassword: z.string({ error: PASSWORD_MESSAGES.confirmRequired }).min(1, PASSWORD_MESSAGES.confirmRequired),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.confirmPassword !== data.newPassword) {
      ctx.addIssue({ code: "custom", path: ["confirmPassword"], message: PASSWORD_MESSAGES.mismatch });
    }
    // Once the current password is verified, string equality is exactly "the same password".
    if (data.newPassword === data.currentPassword) {
      ctx.addIssue({ code: "custom", path: ["newPassword"], message: PASSWORD_MESSAGES.unchanged });
    }
  });

export type StudentPasswordChangeInput = z.infer<typeof studentPasswordChangeSchema>;
