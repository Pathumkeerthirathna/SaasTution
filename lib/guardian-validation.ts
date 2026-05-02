import { z } from "zod";

const guardianName = z
  .string()
  .trim()
  .min(2, "Guardian name must be at least 2 characters long.")
  .max(120, "Guardian name must be at most 120 characters long.");

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

export const createGuardianSchema = z.object({
  studentId,
  name: guardianName,
  relation: guardianRelation,
  phone: guardianPhone,
});

export const updateGuardianSchema = z.object({
  name: guardianName,
  relation: guardianRelation,
  phone: guardianPhone,
});

export const guardianRegisterSchema = z.object({
  guardianId,
  phone: guardianPhone,
  email,
  password,
});

export const guardianLoginSchema = z.object({
  email,
  password,
});

export type CreateGuardianInput = z.infer<typeof createGuardianSchema>;
export type UpdateGuardianInput = z.infer<typeof updateGuardianSchema>;
export type GuardianRegisterInput = z.infer<typeof guardianRegisterSchema>;
export type GuardianLoginInput = z.infer<typeof guardianLoginSchema>;
