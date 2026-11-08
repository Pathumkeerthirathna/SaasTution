import { z } from "zod";

import { MAX_FIXED_FEE_WAIVER } from "@/lib/fee-waiver";

const wholeNumber = (label: string) =>
  z.coerce
    .number({ message: `${label} must be a number.` })
    .refine(Number.isInteger, `${label} must be a whole number.`);

/** A joining-waiver rule: a whole percentage (1–100) or a fixed LKR amount. */
export const feeWaiverRuleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("PERCENTAGE"),
    value: wholeNumber("Percentage")
      .refine((v) => v >= 1, "Percentage must be at least 1.")
      .refine((v) => v <= 100, "Percentage must be at most 100."),
  }),
  z.object({
    type: z.literal("FIXED_AMOUNT"),
    value: wholeNumber("Amount")
      .refine((v) => v >= 1, "Amount must be at least 1.")
      .refine((v) => v <= MAX_FIXED_FEE_WAIVER, `Amount must be at most ${MAX_FIXED_FEE_WAIVER}.`),
  }),
]);

export type FeeWaiverRuleInput = z.infer<typeof feeWaiverRuleSchema>;
