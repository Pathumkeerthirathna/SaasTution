import { z } from "zod";

const uuid = z.string().trim().uuid("Invalid id format.");

export const studentSessionActionSchema = z.object({
  studentId: uuid,
});

export const classSessionQuerySchema = z.object({
  classId: uuid,
});

export type StudentSessionActionInput = z.infer<typeof studentSessionActionSchema>;
