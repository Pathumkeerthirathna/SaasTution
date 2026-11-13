import { z } from "zod";

/**
 * Validation for the student's own profile edits (Student Profile SP-3).
 *
 * Phone number (`contact01`, the student's own phone): the project's
 * existing phone rule, the one registration uses for a phone number
 * (lib/auth-validation.ts `contactField`: trimmed, 9-20 characters, digits,
 * spaces, + and - only), with the same messages. A test keeps the two in
 * step; registration itself is not changed.
 *
 * Empty is NOT allowed: the column is nullable, but no existing path clears
 * `contact01` (the teacher's student form treats an empty value as
 * "unchanged"), so a self-service edit may replace the number, never remove
 * it.
 */
export const STUDENT_PHONE_MIN_LENGTH = 9;
export const STUDENT_PHONE_MAX_LENGTH = 20;

export const studentPhoneSchema = z
  .string({ error: "Enter a phone number." })
  .trim()
  .min(1, "Enter a phone number.")
  .min(STUDENT_PHONE_MIN_LENGTH, "Please enter a valid phone number.")
  .max(STUDENT_PHONE_MAX_LENGTH, "Phone number is too long.")
  .regex(/^[0-9+\-\s]+$/, "Phone number can only contain digits, spaces, + and -.");

/** Profile updates per student per window, plus a server-wide cap (in memory: one process). */
export const PROFILE_UPDATE_RATE_LIMIT = { perStudent: 10, global: 600, windowMs: 10 * 60_000 } as const;

/** A profile-edit body is a few dozen bytes; anything over this is refused (413). */
export const PROFILE_UPDATE_MAX_BODY_BYTES = 1024;

/** PATCH /api/students/me/profile body: exactly { contact01 } (any other field is refused). */
export const studentProfileUpdateSchema = z.object({ contact01: studentPhoneSchema }).strict();
