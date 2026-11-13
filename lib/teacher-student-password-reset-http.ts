import { NextResponse } from "next/server";
import { z } from "zod";

import { AppError } from "@/lib/error-handler";
import {
  PASSWORD_MESSAGES,
  STUDENT_PASSWORD_MAX_BYTES,
  STUDENT_PASSWORD_MAX_LENGTH,
  STUDENT_PASSWORD_MIN_LENGTH,
  utf8ByteLength,
} from "@/lib/student-password-validation";

/*
 * HTTP helpers of POST /api/students/[id]/resetpassword (Student Profile
 * SP-7D). The response contract the teacher UI reads
 * (app/student/Components/StudentProfileHeader.tsx: `result.success`,
 * `result.message`) is kept: every answer is `{ success, message }` (plus a
 * `code` on errors). Every answer is no-store.
 */

export const TEACHER_STUDENT_PASSWORD_RESET_MAX_BODY_BYTES = 1024;

/** The rule the teacher UI and this endpoint have always used (kept unchanged). */
export const TEACHER_PASSWORD_COMPLEXITY_MESSAGE =
  "Password must be at least 8 characters and include an uppercase letter, a lowercase letter and a number.";
export const PASSWORD_REQUIRED_MESSAGE = "Password is required.";

/**
 * A password a teacher sets for a student: required (not only spaces), 8–64
 * characters, at least one upper-case letter, one lower-case letter and one
 * digit (the existing teacher rule), and at most 72 UTF-8 bytes (bcrypt
 * ignores the rest). The registration-number rule needs the student and is
 * checked by the service.
 */
export const teacherSetStudentPasswordSchema = z
  .string({ error: PASSWORD_REQUIRED_MESSAGE })
  .refine((value) => value.trim().length > 0, PASSWORD_REQUIRED_MESSAGE)
  .refine((value) => value.length >= STUDENT_PASSWORD_MIN_LENGTH, { message: TEACHER_PASSWORD_COMPLEXITY_MESSAGE, abort: true })
  .refine((value) => value.length <= STUDENT_PASSWORD_MAX_LENGTH, { message: PASSWORD_MESSAGES.tooLong, abort: true })
  .refine((value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value), {
    message: TEACHER_PASSWORD_COMPLEXITY_MESSAGE,
    abort: true,
  })
  .refine((value) => utf8ByteLength(value) <= STUDENT_PASSWORD_MAX_BYTES, PASSWORD_MESSAGES.tooManyBytes);

/** Exactly `{ password }` — what the teacher UI sends; anything else is refused. */
export const teacherStudentPasswordResetBodySchema = z.object({ password: teacherSetStudentPasswordSchema }).strict();

const NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "X-Content-Type-Options": "nosniff",
};

/** `{ success, message, code? }` with the no-store headers. */
export function resetResponse(
  init: { status: number; headers?: Record<string, string> },
  body: { success: boolean; message: string; code?: string }
) {
  const response = NextResponse.json(body, { status: init.status });
  for (const [name, value] of Object.entries({ ...NO_STORE_HEADERS, ...init.headers })) response.headers.set(name, value);
  return response;
}

export async function readSmallJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d{1,15}$/.test(declared.trim()) || Number(declared.trim()) > TEACHER_STUDENT_PASSWORD_RESET_MAX_BODY_BYTES)
  ) {
    throw new AppError("The request is too large.", 413, "REQUEST_TOO_LARGE");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > TEACHER_STUDENT_PASSWORD_RESET_MAX_BODY_BYTES) {
    throw new AppError("The request is too large.", 413, "REQUEST_TOO_LARGE");
  }
  if (text.trim() === "") throw new SyntaxError("Empty JSON body.");
  return JSON.parse(text) as unknown;
}

/** The answer for an expected error (AppError, malformed JSON), or null for an unexpected one. */
export function expectedErrorResponse(error: unknown) {
  if (error instanceof AppError) {
    return resetResponse({ status: error.statusCode }, { success: false, message: error.message, code: error.code });
  }
  if (error instanceof SyntaxError) {
    return resetResponse({ status: 400 }, { success: false, message: "Invalid request.", code: "INVALID_JSON" });
  }
  return null;
}
