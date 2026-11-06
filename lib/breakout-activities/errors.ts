// Error codes of the Breakout Activities API: one table, so every route
// answers the same code with the same HTTP status and message. Routes throw
// AppError (lib/error-handler.ts) and handleRouteError turns it into the
// usual { success: false, message, code } response.
//
// Aligned with the approved v2 error table, with two later decisions kept:
// - BREAKOUT_EXPORT_REQUIRED replaces v2's BREAKOUT_ACTIVITIES_PENDING;
// - while room resolution fails closed (until Phase 2b), a student whose
//   room cannot be resolved gets 404 NOT_FOUND (room-resolver.ts), not
//   ROOM_UNKNOWN. ROOM_UNKNOWN and NOT_IN_TARGET_ROOM are listed for Phase 2b.
//
// The pure Phase 1 modules keep their own result codes: submission-rules.mjs
// and marking.mjs codes are API codes as they are; pdf-file.ts check codes
// map through pdfCheckError().

import { AppError } from "@/lib/error-handler";

type ErrorSpec = { status: number; message: string };

export const BREAKOUT_ERRORS = {
  // Not found / not visible. A student also gets these for activities that
  // exist but are not for them (draft, other room, other session).
  NOT_FOUND: { status: 404, message: "Not found." },
  SESSION_NOT_FOUND: { status: 404, message: "Session not found." },
  ASSIGNMENT_NOT_FOUND: { status: 404, message: "Assignment not found." },
  QUIZ_NOT_FOUND: { status: 404, message: "Quiz not found." },
  FILE_NOT_FOUND: { status: 404, message: "The file is not available." },

  // Room (Phase 2b; see the header).
  ROOM_UNKNOWN: { status: 409, message: "Your breakout room could not be determined. Please wait a moment and try again." },
  NOT_IN_TARGET_ROOM: { status: 403, message: "This activity is for another room." },

  // State conflicts.
  SESSION_NOT_ACTIVE: { status: 409, message: "This class session is not active." },
  ACTIVITY_NOT_PUBLISHED: { status: 409, message: "This activity is not published." },
  // Editing or deleting a PUBLISHED activity (approved decision). On a
  // CLOSED one, ASSIGNMENT_CLOSED / QUIZ_CLOSED apply instead.
  ACTIVITY_NOT_DRAFT: { status: 409, message: "Only draft activities can be changed or deleted." },
  ASSIGNMENT_CLOSED: { status: 409, message: "This assignment is closed." },
  QUIZ_CLOSED: { status: 409, message: "This quiz is closed." },
  QUIZ_ALREADY_SUBMITTED: { status: 409, message: "This quiz has already been submitted." },
  // Grading override on an attempt that is still IN_PROGRESS (approved decision).
  QUIZ_NOT_SUBMITTED: { status: 409, message: "This attempt has not been submitted yet." },
  // Saving or submitting answers before starting the attempt (approved decision Q2).
  QUIZ_NOT_STARTED: { status: 409, message: "Start the quiz first." },
  QUIZ_TIME_UP: { status: 409, message: "The time for this quiz is over." },
  REVISION_CONFLICT: { status: 409, message: "This was changed somewhere else. Reload and try again." },
  SUBMISSION_LIMIT_REACHED: { status: 409, message: "The maximum number of submissions has been reached." },
  BREAKOUT_BUSY: { status: 409, message: "Another change is in progress. Please try again." },

  // Ending or replacing a session that holds breakout data.
  BREAKOUT_EXPORT_REQUIRED: {
    status: 409,
    message: "This session has breakout activity results. Review or export them before ending the session.",
  },
  BREAKOUT_DATA_CHANGED: {
    status: 409,
    message: "Breakout activity results changed since you reviewed them. Review them again before ending the session.",
  },

  // Invalid input. (A missing or malformed idempotency key is
  // VALIDATION_ERROR, as the approved v3 contract says.)
  VALIDATION_ERROR: { status: 400, message: "Invalid request payload." },
  SUBMISSION_EMPTY: { status: 400, message: "Write an answer or attach a PDF." },
  ANSWER_TEXT_TOO_LONG: { status: 400, message: "The answer is too long." },
  INVALID_PDF: { status: 400, message: "Only valid, non-empty PDF files are allowed." },
  FILE_TOO_LARGE: { status: 413, message: "PDF file exceeds size limit of 25 MB." },

  // Marking (BreakoutMarkingError codes).
  INVALID_MARKS: { status: 400, message: "Invalid marks." },
  INVALID_QUESTION: { status: 400, message: "Invalid question." },
  INVALID_OVERRIDE: { status: 400, message: "Invalid mark override." },
  UNKNOWN_QUESTION: { status: 400, message: "That question is not in this quiz." },
  DUPLICATE_OVERRIDE: { status: 400, message: "The same question is overridden twice." },
  OVERRIDE_OUT_OF_RANGE: { status: 400, message: "Override marks must be between 0 and the question's marks." },
} as const satisfies Record<string, ErrorSpec>;

export type BreakoutErrorCode = keyof typeof BREAKOUT_ERRORS;

export function isBreakoutErrorCode(value: unknown): value is BreakoutErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BREAKOUT_ERRORS, value);
}

/** The AppError for a code, with its standard status and (unless given) message. */
export function breakoutError(code: BreakoutErrorCode, message?: string, details?: unknown): AppError {
  const spec = BREAKOUT_ERRORS[code];
  return new AppError(message ?? spec.message, spec.status, code, details);
}

/** pdf-file.ts check codes (validatePdfUpload) -> the API error. */
export function pdfCheckError(code: "FILE_EMPTY" | "FILE_TOO_LARGE" | "FILE_NOT_PDF"): AppError {
  return breakoutError(code === "FILE_TOO_LARGE" ? "FILE_TOO_LARGE" : "INVALID_PDF");
}

// PostgreSQL SQLSTATEs that mean "try again": lock_not_available
// (lock_timeout), deadlock_detected, serialization_failure.
const RETRYABLE_SQLSTATES = new Set(["55P03", "40P01", "40001"]);

/**
 * A lock wait timed out, the transaction lost a deadlock or a serialization
 * check: safe to retry. Only two Prisma 5.22 shapes are recognized, and only
 * on a PrismaClientKnownRequestError (matched by name, not instanceof, so a
 * second copy of the Prisma runtime is still recognized):
 *   - P2010 "Raw query failed" with meta.code = the SQLSTATE (every breakout
 *     lock statement is a raw query: locks.ts);
 *   - P2034 "Transaction failed due to a write conflict or a deadlock".
 * Everything else is NOT retryable here, deliberately:
 *   - P2028 (transaction expired / could not start): can hide a real fault;
 *     lock waits are kept far below the transaction timeout instead (locks.ts);
 *   - PrismaClientUnknownRequestError (a model query's database error): its
 *     message format is unverified, so it is not classified;
 *   - any object with a bare SQLSTATE `code`: not a Prisma shape.
 */
export function isRetryableLockError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "PrismaClientKnownRequestError") return false;
  const e = error as Error & { code?: unknown; meta?: { code?: unknown } | null };
  if (e.code === "P2034") return true;
  return e.code === "P2010" && typeof e.meta?.code === "string" && RETRYABLE_SQLSTATES.has(e.meta.code);
}

/**
 * A BreakoutMarkingError (marking.mjs), recognized by name and code rather
 * than instanceof: the .mjs module can be loaded twice (ESM import and the
 * CommonJS loader), giving two different classes with the same name.
 */
function isMarkingError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && error.name === "BreakoutMarkingError" && typeof (error as { code?: unknown }).code === "string";
}

/**
 * Normalizes what breakout services throw into an AppError when it is a
 * known, expected failure:
 * - AppError: unchanged
 * - BreakoutMarkingError (marking.mjs): its code, 400
 * - lock timeout / deadlock: 409 BREAKOUT_BUSY
 * Anything else is returned unchanged (an unexpected error: 500 and logged
 * by handleRouteError).
 */
export function toBreakoutAppError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (isMarkingError(error)) {
    const code = isBreakoutErrorCode(error.code) ? error.code : "VALIDATION_ERROR";
    return breakoutError(code, error.message);
  }
  if (isRetryableLockError(error)) return breakoutError("BREAKOUT_BUSY");
  return error;
}
