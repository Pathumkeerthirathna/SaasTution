import { z } from "zod";

const classId = z.string().trim().uuid("Invalid class id format.");

const content = z
  .string()
  .trim()
  .min(1, "Message content is required.")
  .max(2000, "Message content must be at most 2000 characters long.");

const channel = z.enum(["email", "whatsapp"]);

export const bulkMessageSchema = z
  .object({
    classId,
    content,
    // Outbound channels on top of the always-on in-app delivery. An empty list
    // (or nothing at all) means "post in the app only". Legacy callers may still
    // send a single `channel` string.
    channels: z.array(channel).optional(),
    channel: channel.optional(),
  })
  .transform((value) => ({
    classId: value.classId,
    content: value.content,
    channels: value.channels ?? (value.channel ? [value.channel] : []),
  }));

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
