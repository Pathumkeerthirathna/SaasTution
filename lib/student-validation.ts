import { z } from "zod";

import { optionalGradeIdSchema } from "@/lib/grade";

/**
 * Longest registration number (Student Profile SP-6G): the single source of
 * truth for creating, editing and importing students and for the student
 * login (lib/student-login-rate-limit.ts). Measured on the normalized form
 * (trimmed, upper case) — the form that is stored and looked up — because
 * upper-casing can lengthen a string (e.g. "ß" -> "SS").
 */
export const REGISTRATION_NUMBER_MAX_LENGTH = 64;

export const REGISTRATION_NUMBER_TOO_LONG_MESSAGE = `Registration number must be at most ${REGISTRATION_NUMBER_MAX_LENGTH} characters long.`;

/** True when the normalized (trimmed, upper-case) registration number is longer than the limit. Never truncates. */
export function isRegistrationNumberTooLong(value: string): boolean {
  return value.trim().toUpperCase().length > REGISTRATION_NUMBER_MAX_LENGTH;
}

const registrationNumber = z
  .string()
  .trim()
  .min(1, "Registration number is required.")
  .refine((value) => !isRegistrationNumberTooLong(value), REGISTRATION_NUMBER_TOO_LONG_MESSAGE)

const studentName = z
  .string()
  .trim()
  .min(2, "Student name must be at least 2 characters long.")
  .max(120, "Student name must be at most 120 characters long.");

// Grade 0 (lib/grade.ts) is a real grade: an id of 0 is valid, never "empty".
// Adding a student: no grade -> Grade 0. Editing: the grade is always sent.
const gradeId = z
  .number({ error: "Grade is required." })
  .int("Grade is required.")
  .min(0, "Grade is required.");

const studentContact = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === ""
      ? undefined
      : value,
  z
    .string()
    .trim()
    .max(60, "Contact must be at most 60 characters long.")
    .optional()
);

// Every student needs an email to log in (and to reset their password), so it
// is required when adding a student and can be changed but never cleared.
const requiredStudentEmail = z
  .string({ error: "Email is required." })
  .trim()
  .min(1, "Email is required.")
  .email("Invalid email format.")
  .max(120, "Email must be at most 120 characters long.");

const entityId = z.string().trim().uuid("Invalid id format.");

export const createStudentSchema = z.object({
  registrationNumber:registrationNumber,
  name: studentName,
  gradeId: optionalGradeIdSchema,
  contact01: studentContact,
  contact02: studentContact,
  email: requiredStudentEmail,
});

export const assignStudentSchema = z.object({
  classId: entityId,
  studentId: entityId,
});

export const removeStudentFromClassSchema = z.object({
  classId: entityId,
  studentId: entityId,
  reason: z
    .string()
    .trim()
    .max(400, "Reason must be at most 400 characters long.")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
});

export const updateStudentSchema = z.object({
  registrationNumber:registrationNumber,
  name: studentName,
  gradeId: gradeId,
  contact01: studentContact,
  contact02: studentContact,
  email: requiredStudentEmail,
});

export type CreateStudentInput = z.infer<typeof createStudentSchema>;
export type AssignStudentInput = z.infer<typeof assignStudentSchema>;
export type RemoveStudentFromClassInput = z.infer<typeof removeStudentFromClassSchema>;
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;
