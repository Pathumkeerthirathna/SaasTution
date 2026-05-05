import { z } from "zod";

const className = z
  .string()
  .trim()
  .min(2, "Class name must be at least 2 characters long.")
  .max(100, "Class name must be at most 100 characters long.");

const classDescription = z
  .string()
  .trim()
  .max(500, "Description must be at most 500 characters long.")
  .optional()
  .transform((value) => (value === "" ? undefined : value));

const classSchedule = z
  .string()
  .trim()
  .min(3, "Schedule is required.")
  .max(120, "Schedule must be at most 120 characters long.");

const classMonthlyFee = z
  .number({ invalid_type_error: "Monthly fee must be a number." })
  .int("Monthly fee must be a whole number.")
  .min(0, "Monthly fee cannot be negative.")
  .max(1_000_000_000, "Monthly fee is too large.");

const classPaymentDueWeek = z
  .number({ invalid_type_error: "Payment due week must be a number." })
  .int("Payment due week must be a whole number.")
  .min(1, "Payment due week must be between 1 and 4.")
  .max(4, "Payment due week must be between 1 and 4.");

const weekDayEnum = z.enum([
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
]);

const timeField = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Time must be in HH:MM format.");

const classScheduleItemSchema = z
  .object({
    dayOfWeek: weekDayEnum,
    startTime: timeField,
    endTime: timeField,
  })
  .refine((value) => value.startTime < value.endTime, {
    message: "End time must be later than start time.",
    path: ["endTime"],
  });

const classSchedulesSchema = z
  .array(classScheduleItemSchema)
  .min(1, "At least one class schedule is required.");

export const createClassSchema = z.object({
  name: className,
  description: classDescription,
  monthlyFee: classMonthlyFee,
  paymentDueWeek: classPaymentDueWeek,
  schedule: classSchedule.optional(),
  schedules: classSchedulesSchema,
});

export const updateClassSchema = z
  .object({
    name: className.optional(),
    description: classDescription,
    monthlyFee: classMonthlyFee.optional(),
    paymentDueWeek: classPaymentDueWeek.optional(),
    schedule: classSchedule.optional(),
    schedules: classSchedulesSchema.optional(),
  })
  .refine((value) => value.name || value.description !== undefined || value.monthlyFee !== undefined || value.paymentDueWeek !== undefined || value.schedule || value.schedules, {
    message: "At least one field is required to update the class.",
  });

export type CreateClassInput = z.infer<typeof createClassSchema>;
export type UpdateClassInput = z.infer<typeof updateClassSchema>;
