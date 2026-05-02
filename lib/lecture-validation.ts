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
});

export const updateQuizSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(2, "Quiz title must be at least 2 characters long.")
      .max(150, "Quiz title must be at most 150 characters long.")
      .optional(),
  })
  .refine((value) => value.title !== undefined, {
    message: "At least one field is required.",
  });

export const noteKindSchema = z.enum(["NOTE", "SUPPORTING_MATERIAL"]);

export const updateNoteSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(2, "Note title must be at least 2 characters long.")
      .max(150, "Note title must be at most 150 characters long.")
      .optional(),
    kind: noteKindSchema.optional(),
  })
  .refine((value) => value.title !== undefined || value.kind !== undefined, {
    message: "At least one field is required.",
  });

export type CreateLectureInput = z.infer<typeof createLectureSchema>;
export type UpdateLectureInput = z.infer<typeof updateLectureSchema>;
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type UpdateAssignmentInput = z.infer<typeof updateAssignmentSchema>;
export type CreateQuizInput = z.infer<typeof createQuizSchema>;
export type UpdateQuizInput = z.infer<typeof updateQuizSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
