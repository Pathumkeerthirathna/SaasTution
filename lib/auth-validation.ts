import { z } from "zod";

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email("Please enter a valid email address.");

const passwordField = z
  .string()
  .min(8, "Password must be at least 8 characters long.")
  .max(64, "Password must be at most 64 characters long.");

export const registerSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters long.").max(80),
  email: emailField,
  password: passwordField,
});

export const loginSchema = z.object({
  email: z.string().trim().min(1, "Email or username is required."),
  password: z.string().min(1, "Password is required."),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
