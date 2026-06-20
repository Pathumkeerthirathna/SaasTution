import { z } from "zod";

const registrationNumber = z
  .string()
  .trim()
  .min(1, "Registration number is required.")

const studentName = z
  .string()
  .trim()
  .min(2, "Student name must be at least 2 characters long.")
  .max(120, "Student name must be at most 120 characters long.");

  const gradeId = z
  .number()
  .int()
  .positive()
  .refine((value) => value > 0, {
    message: "Grade is required.",
  });

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

const studentEmail = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === ""
      ? undefined
      : value,
  z
    .string()
    .trim()
    .email("Invalid email format.")
    .max(120, "Email must be at most 120 characters long.")
    .optional()
);

const entityId = z.string().trim().uuid("Invalid id format.");

export const createStudentSchema = z.object({
  registrationNumber:registrationNumber,
  name: studentName,
  gradeId: gradeId,
  contact01: studentContact,
  contact02: studentContact,
  email: studentEmail,
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
  email: studentEmail,
});

export type CreateStudentInput = z.infer<typeof createStudentSchema>;
export type AssignStudentInput = z.infer<typeof assignStudentSchema>;
export type RemoveStudentFromClassInput = z.infer<typeof removeStudentFromClassSchema>;
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;
