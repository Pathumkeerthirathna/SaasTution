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
  loginId: z.string().trim().min(1, "Email or registration number is required."),
  password: z.string().min(1, "Password is required."),
});

export const passwordResetRequestSchema = z.object({
  loginId: z.string().trim().min(1, "Email or registration number is required."),
});

export const passwordResetConfirmSchema = z.object({
  token: z.string().trim().min(1, "Reset token is required."),
  newPassword: passwordField,
});

export const passwordUpdateSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required."),
  newPassword: passwordField,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type PasswordResetRequestInput = z.infer<typeof passwordResetRequestSchema>;
export type PasswordResetConfirmInput = z.infer<typeof passwordResetConfirmSchema>;
export type PasswordUpdateInput = z.infer<typeof passwordUpdateSchema>;
