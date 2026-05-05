import { z } from "zod";

const uuid = z.string().trim().uuid("Invalid id format.");

export const submitQuizSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: uuid,
        selectedOptionIds: z.array(uuid),
      })
    )
    .min(1, "At least one answer is required."),
});

export type SubmitQuizInput = z.infer<typeof submitQuizSchema>;
