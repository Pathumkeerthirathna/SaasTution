import { z } from "zod";

const studentName = z
  .string()
  .trim()
  .min(2, "Student name must be at least 2 characters long.")
  .max(120, "Student name must be at most 120 characters long.");

const studentGrade = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .enum([
      "GRADE_01",
      "GRADE_02",
      "GRADE_03",
      "GRADE_04",
      "GRADE_05",
      "GRADE_06",
      "GRADE_07",
      "GRADE_08",
      "GRADE_09",
      "GRADE_10",
      "GRADE_11",
      "GRADE_12",
      "GRADE_13",
    ])
    .optional()
);

const studentContact = z
  .string()
  .trim()
  .min(5, "Contact is required.")
  .max(60, "Contact must be at most 60 characters long.");

const studentEmail = z
  .string()
  .trim()
  .email("Invalid email format.")
  .max(120, "Email must be at most 120 characters long.");

const entityId = z.string().trim().uuid("Invalid id format.");

export const createStudentSchema = z.object({
  name: studentName,
  grade: studentGrade,
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
  name: studentName,
  grade: studentGrade,
  contact01: studentContact,
  contact02: studentContact,
  email: studentEmail,
});

export type CreateStudentInput = z.infer<typeof createStudentSchema>;
export type AssignStudentInput = z.infer<typeof assignStudentSchema>;
export type RemoveStudentFromClassInput = z.infer<typeof removeStudentFromClassSchema>;
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;
