import { apiError } from "@/lib/api-response";

export class AppError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, statusCode = 400, code?: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "An unexpected error occurred.";
}

export function handleRouteError(error: unknown) {
  if (error instanceof AppError) {
    return apiError(error.message, error.statusCode, error.code, error.details);
  }

  if (error instanceof SyntaxError) {
    return apiError("Invalid JSON payload.", 400, "INVALID_JSON");
  }

  console.error("Unhandled route error", error);
  return apiError(getErrorMessage(error), 500, "INTERNAL_SERVER_ERROR");
}
