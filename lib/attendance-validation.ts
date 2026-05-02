import { z } from "zod";

const uuid = z.string().trim().uuid("Invalid id format.");

export const attendanceCreateSchema = z.object({
  sessionId: uuid,
  studentId: uuid,
  classId: uuid.optional(),
});

export const attendanceListQuerySchema = z.object({
  classId: uuid,
});

export type AttendanceCreateInput = z.infer<typeof attendanceCreateSchema>;
