import { z } from "zod";

import { LECTURE_END_DATE_MESSAGES, lectureEndDateProblem } from "@/lib/lecture-schedule";
import { isLocalDateTimeString, parseSriLankaLocalDateTime } from "@/lib/time";

const uuid = z.string().trim().uuid("Invalid id format.");

/**
 * The Sri Lankan lecture time rule. A timezone-less datetime-local value
 * ("YYYY-MM-DDTHH:MM") is Sri Lankan time, whatever the server's timezone;
 * anything else (ISO strings with "Z" or an offset, Date objects) is coerced
 * exactly as before. Malformed values still fail as "Invalid date"; so does a
 * datetime-local value that is not a real date (e.g. February 30th), instead
 * of being rolled over and read in the server's timezone.
 */
function toSriLankaInstant(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();

    if (isLocalDateTimeString(trimmed)) {
      return parseSriLankaLocalDateTime(trimmed) ?? new Date(Number.NaN);
    }
  }

  return value;
}

/** Lecture start date/time (Lecture.date). */
const lectureDate = z.preprocess(toSriLankaInstant, z.coerce.date());

/**
 * Lecture end date/time (Lecture.endDate): the same Sri Lankan rule as the
 * start. `null` or an empty / blank string (an empty form field) means "no
 * end time" and clears it; it is never coerced to 1970. Omitted leaves it
 * unchanged.
 */
const lectureEndDate = z
  .preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : toSriLankaInstant(value)),
    z.coerce.date({ error: "The end time must be a valid date and time." }).nullable()
  )
  .optional();

/** End after start, at most 12 hours (lib/lecture-schedule.ts), when both are in the request. */
function checkEndAgainstStart(value: { date?: Date; endDate?: Date | null }, ctx: z.RefinementCtx) {
  if (!value.date || !value.endDate) return;

  const problem = lectureEndDateProblem(value.date, value.endDate);

  if (problem) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endDate"], message: LECTURE_END_DATE_MESSAGES[problem] });
  }
}

/** Assignment due date: exactly the same Sri Lankan rule as lecture dates. */
const assignmentDueDate = lectureDate;

export const createLectureSchema = z
  .object({
    classId: uuid,
    title: z
      .string()
      .trim()
      .min(2, "Lecture title must be at least 2 characters long.")
      .max(150, "Lecture title must be at most 150 characters long."),
    date: lectureDate,
    endDate: lectureEndDate,
  })
  .superRefine(checkEndAgainstStart);

/**
 * When only one of date / endDate is sent, the other is the stored value:
 * the lecture service checks the pair (updateLectureForTeacher).
 */
export const updateLectureSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(2, "Lecture title must be at least 2 characters long.")
      .max(150, "Lecture title must be at most 150 characters long.")
      .optional(),
    date: lectureDate.optional(),
    endDate: lectureEndDate,
  })
  .refine((value) => value.title !== undefined || value.date !== undefined || value.endDate !== undefined, {
    message: "At least one field is required.",
  })
  .superRefine(checkEndAgainstStart);

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
  dueDate: assignmentDueDate,
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
    dueDate: assignmentDueDate.optional(),
  })
  .refine(
    (value) => value.title !== undefined || value.description !== undefined || value.dueDate !== undefined,
    {
      message: "At least one field is required.",
    }
  );

export const createQuizSchema = z
  .object({
  title: z
    .string()
    .trim()
    .min(2, "Quiz title must be at least 2 characters long.")
    .max(150, "Quiz title must be at most 150 characters long."),
  maxAttempts: z.number().int().min(1, "Max attempts must be at least 1.").max(100).nullable().optional(),
  startDateTime: z.coerce.date(),
  endDateTime: z.coerce.date(),
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
  })
  .refine((value) => value.endDateTime.getTime() > value.startDateTime.getTime(), {
    message: "End date/time must be after the start date/time.",
    path: ["endDateTime"],
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

const whiteboardTitle = z
  .string()
  .trim()
  .min(2, "Whiteboard title must be at least 2 characters long.")
  .max(150, "Whiteboard title must be at most 150 characters long.");

// `data` is checked and normalised by `sanitizeWhiteboardScene` (lib/whiteboard-data.ts).
export const createWhiteboardSchema = z.object({
  title: whiteboardTitle,
  data: z.unknown(),
});

export const updateWhiteboardSchema = z
  .object({
    title: whiteboardTitle.optional(),
    data: z.unknown().optional(),
  })
  .refine((value) => value.title !== undefined || value.data !== undefined, {
    message: "At least one field is required.",
  });
