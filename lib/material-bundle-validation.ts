import { z } from "zod";

const uuid = z.string().trim().uuid("Invalid id format.");

export const materialBundleQuerySchema = z.object({
  classId: uuid.optional(),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

export const createMaterialBundleSchema = z.object({
  classId: uuid,
  title: z
    .string()
    .trim()
    .min(2, "Bundle title must be at least 2 characters.")
    .max(150, "Bundle title must be at most 150 characters."),
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

export const updateMaterialBundleSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(2, "Bundle title must be at least 2 characters.")
      .max(150, "Bundle title must be at most 150 characters.")
      .optional(),
    year: z.coerce.number().int().min(2020).max(2100).optional(),
    month: z.coerce.number().int().min(1).max(12).optional(),
  })
  .refine((value) => value.title !== undefined || value.year !== undefined || value.month !== undefined, {
    message: "At least one field is required.",
  });

export const materialBundleItemTypeSchema = z.enum(["TUTE", "PAPER"]);

export const createMaterialBundleItemSchema = z
  .object({
    type: materialBundleItemTypeSchema,
    title: z
      .string()
      .trim()
      .min(2, "Title must be at least 2 characters long.")
      .max(150, "Title must be at most 150 characters long."),
    description: z
      .string()
      .trim()
      .max(2000, "Description must be at most 2000 characters long.")
      .optional(),
    paperStartAt: z.coerce.date().optional(),
    paperEndAt: z.coerce.date().optional(),
  })
  .refine(
    (value) =>
      value.type !== "PAPER" || (value.paperStartAt !== undefined && value.paperEndAt !== undefined),
    {
      message: "Paper start and end time are required for paper items.",
      path: ["paperStartAt"],
    }
  )
  .refine(
    (value) =>
      value.type !== "PAPER" ||
      value.paperStartAt === undefined ||
      value.paperEndAt === undefined ||
      value.paperStartAt < value.paperEndAt,
    {
      message: "Paper end time must be after start time.",
      path: ["paperEndAt"],
    }
  );

export const updateMaterialBundleItemSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(2, "Title must be at least 2 characters long.")
      .max(150, "Title must be at most 150 characters long.")
      .optional(),
    description: z
      .string()
      .trim()
      .max(2000, "Description must be at most 2000 characters long.")
      .optional(),
    paperStartAt: z.coerce.date().nullable().optional(),
    paperEndAt: z.coerce.date().nullable().optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.description !== undefined ||
      value.paperStartAt !== undefined ||
      value.paperEndAt !== undefined,
    {
      message: "At least one field is required.",
    }
  )
  .refine(
    (value) =>
      value.paperStartAt === undefined ||
      value.paperEndAt === undefined ||
      value.paperStartAt === null ||
      value.paperEndAt === null ||
      value.paperStartAt < value.paperEndAt,
    {
      message: "Paper end time must be after start time.",
      path: ["paperEndAt"],
    }
  );

export const saveMaterialBundleRecipientsSchema = z.object({
  selectedStudentIds: z.array(uuid).default([]),
});

export const teacherPaperConfigSchema = z.object({
  countdownLeadMinutes: z.coerce.number().int().min(1).max(1440),
  submissionGraceMinutes: z.coerce.number().int().min(1).max(1440),
});

export const paperLateReasonSchema = z.object({
  message: z
    .string()
    .trim()
    .min(10, "Reason must be at least 10 characters.")
    .max(2000, "Reason must be at most 2000 characters."),
});

export type CreateMaterialBundleInput = z.infer<typeof createMaterialBundleSchema>;
export type UpdateMaterialBundleInput = z.infer<typeof updateMaterialBundleSchema>;
export type CreateMaterialBundleItemInput = z.infer<typeof createMaterialBundleItemSchema>;
export type UpdateMaterialBundleItemInput = z.infer<typeof updateMaterialBundleItemSchema>;
export type SaveMaterialBundleRecipientsInput = z.infer<typeof saveMaterialBundleRecipientsSchema>;
export type TeacherPaperConfigInput = z.infer<typeof teacherPaperConfigSchema>;
export type PaperLateReasonInput = z.infer<typeof paperLateReasonSchema>;
