import { z } from "zod";

const uuid = z.string().trim().uuid("Invalid id format.");

export const createLectureSchema = z.object({
  classId: uuid,
  title: z
    .string()
    .trim()
    .min(2, "Lecture title must be at least 2 characters long.")
    .max(150, "Lecture title must be at most 150 characters long."),
  date: z.coerce.date(),
});

export const updateLectureSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(2, "Lecture title must be at least 2 characters long.")
      .max(150, "Lecture title must be at most 150 characters long.")
      .optional(),
    date: z.coerce.date().optional(),
  })
  .refine((value) => value.title !== undefined || value.date !== undefined, {
    message: "At least one field is required.",
  });

export const lectureListQuerySchema = z.object({
  classId: uuid.optional(),
});

export const updateLectureClassStatusSchema = z.object({
  classStatus: z.enum(["COMPLETED", "CANCELLED"]),
});

export const updateLiveBroadcastPrivacySchema = z.object({
  privacy: z.enum(["public", "unlisted", "private"]),
});

export const updateRecordingAccessSchema = z
  .object({
    visibility: z.enum(["PUBLIC", "PRIVATE"]).optional(),
    access: z.enum(["FREE", "LOCKED"]).optional(),
  })
  .refine((value) => value.visibility !== undefined || value.access !== undefined, {
    message: "At least one field is required.",
  });

export const createAssignmentSchema = z.object({
  title: z
    .string()
    .trim()
    .min(2, "Assignment title must be at least 2 characters long.")
    .max(150, "Assignment title must be at most 150 characters long."),
  description: z
    .string()
    .trim()
    .min(5, "Assignment description must be at least 5 characters long.")
    .max(2000, "Assignment description must be at most 2000 characters long."),
  dueDate: z.coerce.date(),
});

export const updateAssignmentSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(2, "Assignment title must be at least 2 characters long.")
      .max(150, "Assignment title must be at most 150 characters long.")
      .optional(),
    description: z
      .string()
      .trim()
      .min(5, "Assignment description must be at least 5 characters long.")
      .max(2000, "Assignment description must be at most 2000 characters long.")
      .optional(),
    dueDate: z.coerce.date().optional(),
  })
  .refine(
    (value) => value.title !== undefined || value.description !== undefined || value.dueDate !== undefined,
    {
      message: "At least one field is required.",
    }
  );

export const createQuizSchema = z.object({
  title: z
    .string()
    .trim()
    .min(2, "Quiz title must be at least 2 characters long.")
    .max(150, "Quiz title must be at most 150 characters long."),
  maxAttempts: z.number().int().min(1, "Max attempts must be at least 1.").max(100).nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  questions: z
    .array(
      z
        .object({
          id: uuid.optional(),
          text: z
            .string()
            .trim()
            .min(2, "Question must be at least 2 characters long.")
            .max(500, "Question must be at most 500 characters long."),
          answerType: z.enum(["SINGLE", "MULTIPLE"]),
          options: z
            .array(
              z.object({
                id: uuid.optional(),
                text: z
                  .string()
                  .trim()
                  .min(1, "Answer option cannot be empty.")
                  .max(300, "Answer option must be at most 300 characters long."),
                isCorrect: z.boolean(),
              })
            )
            .min(2, "Each question requires at least 2 answers."),
        })
        .refine((question) => question.options.some((option) => option.isCorrect), {
          message: "Mark at least one correct answer.",
          path: ["options"],
        })
        .refine(
          (question) =>
            question.answerType !== "SINGLE" || question.options.filter((option) => option.isCorrect).length === 1,
          {
            message: "Single-answer questions must have exactly one correct answer.",
            path: ["options"],
          }
        )
    )
    .min(1, "Quiz must contain at least one question."),
});

export const updateQuizSchema = createQuizSchema;

export const noteKindSchema = z.enum(["NOTE", "SUPPORTING_MATERIAL"]);

export const noteVisibilitySchema = z.enum(["PUBLIC", "PRIVATE"]);
export const noteAccessSchema = z.enum(["FREE", "LOCKED"]);

export const updateNoteSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(2, "Note title must be at least 2 characters long.")
      .max(150, "Note title must be at most 150 characters long.")
      .optional(),
    kind: noteKindSchema.optional(),
    visibility: noteVisibilitySchema.optional(),
    access: noteAccessSchema.optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.kind !== undefined ||
      value.visibility !== undefined ||
      value.access !== undefined,
    {
      message: "At least one field is required.",
    }
  );

export const submitAssignmentSchema = z.object({
  notes: z
    .string()
    .trim()
    .max(3000, "Submission notes must be at most 3000 characters long.")
    .optional(),
});

export type CreateLectureInput = z.infer<typeof createLectureSchema>;
export type UpdateLectureInput = z.infer<typeof updateLectureSchema>;
export type UpdateLectureClassStatusInput = z.infer<typeof updateLectureClassStatusSchema>;
export type UpdateLiveBroadcastPrivacyInput = z.infer<typeof updateLiveBroadcastPrivacySchema>;
export type UpdateRecordingAccessInput = z.infer<typeof updateRecordingAccessSchema>;
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type UpdateAssignmentInput = z.infer<typeof updateAssignmentSchema>;
export type CreateQuizInput = z.infer<typeof createQuizSchema>;
export type UpdateQuizInput = z.infer<typeof updateQuizSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
export type SubmitAssignmentInput = z.infer<typeof submitAssignmentSchema>;
