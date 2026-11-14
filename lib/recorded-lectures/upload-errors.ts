import { AppError, handleRouteError } from "@/lib/error-handler";
import { isStorageError, type StorageErrorCode } from "@/lib/file-storage/types";

import { MP4_REJECTION_MESSAGES, type Mp4RejectionCode } from "./mp4-inspect";
import type { ChunkHeaderProblem, UploadDeclarationProblem } from "./validation";

/*
 * Recorded Lectures (RL-3.1): the upload APIs' error codes and the mapping of
 * every lower-level failure (RL-1 validation, StorageError, MP4 inspection,
 * Prisma / PostgreSQL, the in-process mutex) to an AppError.
 *
 * Every client-facing message is a fixed text from this file (or the RL-1
 * validation / MP4 messages, which are fixed texts too). No message, detail
 * or header ever contains a storage key, a filesystem path, a lease token,
 * a teacher / class id or a raw database or storage error message.
 * Anything not recognized here stays unknown: handleRouteError then answers
 * 500 with the generic message and logs it (sanitized).
 */

export const UPLOAD_ERRORS = {
  RECORDED_LECTURES_NOT_CONFIGURED: { status: 503, message: "Recorded lecture uploads are not available right now." },
  TEACHER_ACCOUNT_INACTIVE: { status: 403, message: "Your account cannot upload recordings right now." },
  LECTURE_NOT_FOUND: { status: 404, message: "Lecture not found." },
  LECTURE_NOT_ACTIVE: { status: 409, message: "This lecture is no longer available for uploads." },
  UPLOAD_NOT_FOUND: { status: 404, message: "Upload not found." },
  UPLOAD_DECLARATION_INVALID: { status: 400, message: "The upload details are not valid." },
  JSON_CONTENT_TYPE_REQUIRED: { status: 415, message: "The request body must be JSON (application/json)." },
  INVALID_JSON: { status: 400, message: "Invalid JSON payload." },
  REQUEST_TOO_LARGE: { status: 413, message: "The request body is too large." },
  PART_NUMBER_IN_USE: { status: 409, message: "This lecture already has a recording with that part number." },
  TOO_MANY_ACTIVE_UPLOADS: { status: 409, message: "You have too many uploads in progress. Finish or cancel one first." },
  INSUFFICIENT_STORAGE: { status: 507, message: "There is not enough storage space for this upload right now." },
  INFLIGHT_CHUNK_CAP: { status: 503, message: "The server is busy receiving other uploads. Please retry shortly." },
  UPLOAD_BUSY: { status: 503, message: "The upload is busy. Please retry shortly." },
  CHUNK_IN_PROGRESS: { status: 409, message: "Another part of this upload is still being received. Please retry shortly." },
  LEASE_LOST: { status: 409, message: "This chunk could not be saved. Check the upload's status and send it again." },
  CONTENT_TYPE_INVALID: { status: 415, message: "Upload chunks must be sent as application/octet-stream." },
  OFFSET_REQUIRED: { status: 400, message: "The Upload-Offset header is required." },
  OFFSET_INVALID: { status: 400, message: "The Upload-Offset header is not valid." },
  OFFSET_MISMATCH: { status: 409, message: "The upload offset does not match the bytes already received." },
  LENGTH_REQUIRED: { status: 411, message: "The Content-Length header is required." },
  LENGTH_INVALID: { status: 400, message: "The Content-Length header is not valid." },
  CHUNK_TOO_LARGE: { status: 413, message: "The chunk is larger than allowed." },
  CHUNK_EXCEEDS_REMAINING: { status: 413, message: "The chunk is larger than the rest of the file." },
  UPLOAD_ALREADY_COMPLETE: { status: 409, message: "All bytes of this upload were already received." },
  CHUNK_INCOMPLETE: { status: 400, message: "The chunk did not have the declared size." },
  CHUNK_TIMEOUT: { status: 408, message: "The chunk was not received in time." },
  CHUNK_ABORTED: { status: 400, message: "The chunk transfer was interrupted." },
  UPLOAD_EXPIRED: { status: 410, message: "This upload has expired. Please start it again." },
  UPLOAD_NOT_ACTIVE: { status: 409, message: "This upload is no longer accepting data." },
  UPLOAD_COMPLETING: { status: 409, message: "This upload is being verified." },
  UPLOAD_INCOMPLETE: { status: 409, message: "Not all bytes of this upload have been received yet." },
  UPLOAD_ALREADY_COMPLETED: { status: 409, message: "This upload has already been completed." },
  MP4_REJECTED: { status: 422, message: "The video could not be accepted." },
  DURATION_INVALID: { status: 422, message: "The video duration is missing or longer than 48 hours." },
  UPLOAD_VERIFICATION_FAILED: { status: 422, message: "The uploaded file could not be verified. Please upload it again." },
  STORAGE_ERROR: { status: 500, message: "A storage error occurred. Please try again." },
} as const satisfies Record<string, { status: number; message: string }>;

export type UploadErrorCode = keyof typeof UPLOAD_ERRORS;

export type UploadErrorDetails = {
  /** Seconds a client should wait before retrying (routes send it as Retry-After). */
  retryAfterSeconds?: number;
  /** The server's received byte count (offset problems: where to resume). */
  receivedBytes?: number;
  /** A finer reason: an RL-1 validation / MP4 rejection code. */
  reason?: string;
};

export function uploadError(code: UploadErrorCode, details?: UploadErrorDetails, message?: string): AppError {
  const spec = UPLOAD_ERRORS[code];
  const clean = details ? sanitizeDetails(details) : undefined;
  return new AppError(message ?? spec.message, spec.status, code, clean);
}

function sanitizeDetails(details: UploadErrorDetails): UploadErrorDetails | undefined {
  const out: UploadErrorDetails = {};
  if (details.retryAfterSeconds !== undefined) {
    out.retryAfterSeconds = Math.max(1, Math.ceil(Number(details.retryAfterSeconds) || 1));
  }
  if (details.receivedBytes !== undefined && Number.isSafeInteger(details.receivedBytes) && details.receivedBytes >= 0) {
    out.receivedBytes = details.receivedBytes;
  }
  if (typeof details.reason === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(details.reason)) out.reason = details.reason;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 409 UPLOAD_BUSY: another request of this process is working on the upload
 * (its upload mutex could not be acquired in time); nothing was changed.
 * (The same code with 503 means a database lock wait timed out.)
 */
export function uploadBusyConflict(): AppError {
  return new AppError(UPLOAD_ERRORS.UPLOAD_BUSY.message, 409, "UPLOAD_BUSY", { retryAfterSeconds: 1 });
}

/** The Retry-After header value for an upload AppError, or null. */
export function retryAfterHeader(error: unknown): string | null {
  if (!(error instanceof AppError)) return null;
  const seconds = (error.details as UploadErrorDetails | undefined)?.retryAfterSeconds;
  return typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0 ? String(seconds) : null;
}

// ---- RL-1 validation / inspection results ----------------------------------------------------------

/** validateUploadDeclaration problem -> 400 with its own (fixed) message. */
export function declarationError(problem: UploadDeclarationProblem, message: string): AppError {
  return uploadError("UPLOAD_DECLARATION_INVALID", { reason: problem }, message);
}

const CHUNK_HEADER_ERRORS: Record<ChunkHeaderProblem, UploadErrorCode> = {
  OFFSET_REQUIRED: "OFFSET_REQUIRED",
  OFFSET_INVALID: "OFFSET_INVALID",
  OFFSET_MISMATCH: "OFFSET_MISMATCH",
  LENGTH_REQUIRED: "LENGTH_REQUIRED",
  LENGTH_INVALID: "LENGTH_INVALID",
  CHUNK_TOO_LARGE: "CHUNK_TOO_LARGE",
  CHUNK_EXCEEDS_REMAINING: "CHUNK_EXCEEDS_REMAINING",
  UPLOAD_ALREADY_COMPLETE: "UPLOAD_ALREADY_COMPLETE",
};

/** parseChunkRequestHeaders problem -> AppError carrying the server's received byte count. */
export function chunkHeaderError(problem: ChunkHeaderProblem, receivedBytes: number): AppError {
  return uploadError(CHUNK_HEADER_ERRORS[problem], { receivedBytes });
}

/** MP4 inspection rejection -> 422 with the RL-1 user message. */
export function mp4RejectionError(code: Mp4RejectionCode): AppError {
  return uploadError("MP4_REJECTED", { reason: code }, MP4_REJECTION_MESSAGES[code]);
}

// ---- StorageError ------------------------------------------------------------------------------------

const ROOT_PROBLEMS = new Set<StorageErrorCode>([
  "ROOT_MISSING",
  "ROOT_NOT_DIRECTORY",
  "ROOT_INSIDE_APPLICATION",
  "ROOT_WORLD_WRITABLE",
  "ROOT_NOT_WRITABLE",
]);

/**
 * StorageError -> AppError. "chunk-write" is streaming a request body into a
 * scratch file (size / deadline / abort are the client's doing); "default"
 * is any other storage operation (there they are server faults).
 * StorageError's own message is never used.
 */
export function storageErrorToAppError(code: StorageErrorCode, context: "chunk-write" | "default" = "default"): AppError {
  if (code === "NO_SPACE") return uploadError("INSUFFICIENT_STORAGE");
  if (ROOT_PROBLEMS.has(code)) return uploadError("RECORDED_LECTURES_NOT_CONFIGURED");
  if (context === "chunk-write") {
    if (code === "LIMIT_EXCEEDED" || code === "SIZE_MISMATCH") return uploadError("CHUNK_INCOMPLETE");
    if (code === "DEADLINE_EXCEEDED") return uploadError("CHUNK_TIMEOUT");
    if (code === "ABORTED") return uploadError("CHUNK_ABORTED");
  }
  return uploadError("STORAGE_ERROR");
}

// ---- Prisma / PostgreSQL -------------------------------------------------------------------------

type KnownRequestError = Error & { code?: unknown; meta?: Record<string, unknown> | null };

// Matched by name, not instanceof, so a second copy of the Prisma runtime is still recognized
// (as lib/breakout-activities/errors.ts).
function knownRequestError(error: unknown): KnownRequestError | null {
  return error instanceof Error && error.name === "PrismaClientKnownRequestError" ? (error as KnownRequestError) : null;
}

// lock_not_available (lock_timeout), deadlock_detected, serialization_failure.
const RETRYABLE_SQLSTATES = new Set(["55P03", "40P01", "40001"]);

/**
 * A lock wait timed out, a deadlock was lost or a write conflicted: safe to
 * retry. Only P2034 and P2010 (raw query) with a retryable SQLSTATE, as
 * isRetryableLockError in lib/breakout-activities/errors.ts; nothing else
 * (P2028 etc. can hide real faults).
 */
export function isRetryableDatabaseError(error: unknown): boolean {
  const e = knownRequestError(error);
  if (!e) return false;
  if (e.code === "P2034") return true;
  const sqlState = e.meta?.code;
  return e.code === "P2010" && typeof sqlState === "string" && RETRYABLE_SQLSTATES.has(sqlState);
}

/**
 * True when a failure inside an upload transaction certainly rolled it back:
 * our own refusal (AppError), an integer conversion error, or a database error raised
 * by a statement (constraint, lock). Anything else (a broken connection, an
 * expired / unknown transaction state) leaves the commit's outcome unknown.
 */
export function isDefiniteRollback(error: unknown): boolean {
  if (error instanceof AppError) return true;
  if (error instanceof Error && error.name === "RecordedLectureIntegerError") return true;
  if (isRetryableDatabaseError(error)) return true;
  if (error instanceof Error && error.name === "PrismaClientKnownRequestError") {
    const code = (error as Error & { code?: unknown }).code;
    return code === "P2002" || code === "P2003" || code === "P2004" || code === "P2010" || code === "P2025";
  }
  return false;
}

export const PART_NUMBER_INDEX = "RecordedLecture_active_part_number_key";

/**
 * A unique violation of the active part-number index (P2002). Prisma reports
 * the target as field names or as the index name depending on how the index
 * is known to it (this one is hand-written, absent from the schema), so both
 * shapes are accepted: an array naming partNumber, or a string naming the
 * index. Any other unique violation is NOT a part-number conflict.
 */
export function isPartNumberConflict(error: unknown): boolean {
  const e = knownRequestError(error);
  if (!e || e.code !== "P2002") return false;
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.includes("partNumber") && target.includes("lectureId");
  return typeof target === "string" && target.includes(PART_NUMBER_INDEX);
}

// ---- Normalization ------------------------------------------------------------------------------------

/**
 * Normalizes what the upload services throw:
 *   AppError                    -> unchanged
 *   StorageError                -> its mapped AppError (default context)
 *   lock timeout / deadlock     -> 503 UPLOAD_BUSY (retry in 1 s)
 *   in-process mutex timeout    -> 503 UPLOAD_BUSY (retry in 1 s)
 *   part-number unique conflict -> 409 PART_NUMBER_IN_USE
 * Anything else (CHECK violations, unsafe integers, unknown errors) is
 * returned unchanged: an unexpected fault, 500 and logged by handleRouteError.
 */
export function toUploadAppError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (isStorageError(error)) return storageErrorToAppError(error.code);
  if (isRetryableDatabaseError(error)) return uploadError("UPLOAD_BUSY", { retryAfterSeconds: 1 });
  if (error instanceof Error && error.name === "UploadMutexTimeoutError") return uploadError("UPLOAD_BUSY", { retryAfterSeconds: 1 });
  if (isPartNumberConflict(error)) return uploadError("PART_NUMBER_IN_USE");
  return error;
}

/**
 * The upload routes' error response: toUploadAppError, then the standard
 * handleRouteError (unknown errors: 500, generic message, logged), plus a
 * Retry-After header when the error carries one.
 */
export function uploadErrorResponse(error: unknown, request: Request): Response {
  const normalized = toUploadAppError(error);
  const response = handleRouteError(normalized, { request });
  const retryAfter = retryAfterHeader(normalized);
  if (retryAfter) response.headers.set("Retry-After", retryAfter);
  const receivedBytes = normalized instanceof AppError ? (normalized.details as UploadErrorDetails | undefined)?.receivedBytes : undefined;
  if (typeof receivedBytes === "number") response.headers.set("Upload-Offset", String(receivedBytes));
  return response;
}
