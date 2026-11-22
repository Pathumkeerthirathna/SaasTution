import { z } from "zod";

/*
 * Teacher payment accounts (Payment Details): input validation for the
 * owner's create / update requests. The teacher id never comes from the
 * request (it is the signed-in teacher), and status / ids / timestamps are
 * not accepted: unknown keys are rejected.
 */

export const PAYMENT_ACCOUNT_TYPES = ["SAVINGS", "CURRENT", "OTHER"] as const;
export type PaymentAccountType = (typeof PAYMENT_ACCOUNT_TYPES)[number];

/** Upper bound of accounts per teacher (a sanity limit, not a business rule). */
export const MAX_PAYMENT_ACCOUNTS_PER_TEACHER = 10;

const requiredText = (label: string, max: number) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be at most ${max} characters long.`);

const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters long.`)
    .nullable()
    .optional()
    .transform((value) => (value === undefined ? undefined : value === null || value === "" ? null : value));

/** Digits, with optional spaces or hyphens between groups; 4 to 30 digits. */
const accountNumber = z
  .string({ error: "Account number is required." })
  .trim()
  .max(34, "Account number must be at most 34 characters long.")
  .regex(/^[0-9][0-9 -]*[0-9]$|^[0-9]$/, "Account number may contain only digits, spaces and hyphens.")
  .refine((value) => {
    const digits = value.replace(/[^0-9]/g, "").length;
    return digits >= 4 && digits <= 30;
  }, "Account number must have between 4 and 30 digits.")
  .transform((value) => value.replace(/\s+/g, " "));

const fields = {
  label: optionalText("Display name", 60),
  accountHolderName: requiredText("Account holder name", 120),
  bankName: requiredText("Bank name", 120),
  branchName: optionalText("Branch name", 120),
  accountNumber,
  accountType: z.enum(PAYMENT_ACCOUNT_TYPES, { error: "Choose a valid account type." }),
  isPrimary: z.boolean({ error: "isPrimary must be true or false." }),
  isPublic: z.boolean({ error: "isPublic must be true or false." }),
  isActive: z.boolean({ error: "isActive must be true or false." }),
};

export const createPaymentAccountSchema = z
  .object({
    ...fields,
    accountType: fields.accountType.default("SAVINGS"),
    isPrimary: fields.isPrimary.default(false),
    isPublic: fields.isPublic.default(true),
    isActive: fields.isActive.default(true),
  })
  .strict();

export const updatePaymentAccountSchema = z
  .object({
    label: fields.label,
    accountHolderName: fields.accountHolderName.optional(),
    bankName: fields.bankName.optional(),
    branchName: fields.branchName,
    accountNumber: fields.accountNumber.optional(),
    accountType: fields.accountType.optional(),
    isPrimary: fields.isPrimary.optional(),
    isPublic: fields.isPublic.optional(),
    isActive: fields.isActive.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((v) => v !== undefined), "Nothing to update.");

export type CreatePaymentAccountInput = z.infer<typeof createPaymentAccountSchema>;
export type UpdatePaymentAccountInput = z.infer<typeof updatePaymentAccountSchema>;
