import { z } from "zod";

const guardianFullName = z
  .string()
  .trim()
  .min(2, "Guardian full name must be at least 2 characters long.")
  .max(120, "Guardian full name must be at most 120 characters long.");

const guardianRelation = z
  .string()
  .trim()
  .min(2, "Relation is required.")
  .max(80, "Relation must be at most 80 characters long.");

const guardianPhone = z
  .string()
  .trim()
  .min(5, "Phone number is required.")
  .max(30, "Phone number must be at most 30 characters long.");

const studentId = z.string().trim().uuid("Invalid student id format.");
const guardianId = z.string().trim().uuid("Invalid guardian id format.");

const email = z
  .string()
  .trim()
  .toLowerCase()
  .email("Please provide a valid email address.");

const password = z
  .string()
  .min(8, "Password must be at least 8 characters long.")
  .max(100, "Password must be at most 100 characters long.");

/** Teacher creates a brand-new guardian account and links it to a student. */
export const createGuardianSchema = z.object({
  studentId,
  fullName: guardianFullName,
  email,
  phone: guardianPhone,
  relation: guardianRelation,
});

/** Teacher links an already-existing guardian account to a student. */
export const linkGuardianSchema = z.object({
  guardianId,
  studentId,
  relation: guardianRelation,
});

export const guardianSearchSchema = z.object({
  q: z.string().trim().min(1, "Enter a name or email to search.").max(120),
});

/** Teacher edits the relation on one guardian<->student link. */
export const updateGuardianLinkSchema = z.object({
  studentId,
  relation: guardianRelation,
});

/** Teacher edits shared guardian account details. */
export const updateGuardianDetailsSchema = z.object({
  fullName: guardianFullName,
  email,
  phone: guardianPhone,
});

export const guardianLoginSchema = z.object({
  email,
  password,
});

export type CreateGuardianInput = z.infer<typeof createGuardianSchema>;
export type LinkGuardianInput = z.infer<typeof linkGuardianSchema>;
export type GuardianSearchInput = z.infer<typeof guardianSearchSchema>;
export type UpdateGuardianLinkInput = z.infer<typeof updateGuardianLinkSchema>;
export type UpdateGuardianDetailsInput = z.infer<typeof updateGuardianDetailsSchema>;
export type GuardianLoginInput = z.infer<typeof guardianLoginSchema>;
