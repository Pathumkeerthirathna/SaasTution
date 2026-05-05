import { z } from "zod";

const classId = z.string().trim().uuid("Invalid class id format.");

const content = z
  .string()
  .trim()
  .min(1, "Message content is required.")
  .max(2000, "Message content must be at most 2000 characters long.");

export const bulkMessageSchema = z.object({
  classId,
  content,
  channel: z.enum(["email", "whatsapp"]).default("email"),
});

export const listMessagesQuerySchema = z.object({
  classId,
  dateFrom: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "dateFrom must be in YYYY-MM-DD format.")
    .optional(),
  dateTo: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "dateTo must be in YYYY-MM-DD format.")
    .optional(),
});

export const messageDeliveryWebhookSchema = z.object({
  providerMessageId: z
    .string()
    .trim()
    .min(1, "providerMessageId is required."),
  status: z.enum(["QUEUED", "SENT", "FAILED"]),
  error: z
    .string()
    .trim()
    .max(500, "Error must be at most 500 characters long.")
    .optional(),
});

export type BulkMessageInput = z.infer<typeof bulkMessageSchema>;
