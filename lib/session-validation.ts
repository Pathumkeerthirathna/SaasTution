import { z } from "zod";

const uuid = z.string().trim().uuid("Invalid id format.");

export const studentSessionActionSchema = z.object({
  studentId: uuid,
});

export const classSessionQuerySchema = z.object({
  classId: uuid,
});

export const startClassSessionSchema = z.object({
  lectureId: uuid,
});

export const sessionNotifySchema = z
  .object({
    email: z.boolean().optional().default(false),
    whatsapp: z.boolean().optional().default(false),
    notificationType: z.enum(["started", "restarted"]).optional().default("started"),
  })
  .refine((value) => value.email || value.whatsapp, {
    message: "Select at least one notify channel.",
    path: ["email"],
  });

export type StudentSessionActionInput = z.infer<typeof studentSessionActionSchema>;
