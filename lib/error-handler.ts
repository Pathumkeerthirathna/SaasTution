import { apiError } from "@/lib/api-response";
import { logErrorEntry } from "@/lib/error-logging/server-logger";
import { createRateLimiter } from "@/lib/error-logging/rate-limit";
import { scrubText, summarizeError } from "@/lib/error-logging/sanitize";

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

export type RouteErrorContext = {
  /** The incoming request: its path, method and User-Agent go into the error log. */
  request: Request;
};

export type ReportRouteErrorContext = RouteErrorContext & {
  /** The status the route responds with, recorded in the log (default 500). */
  statusCode?: number;
  label?: string;
};

/**
 * What an unexpected error's 500 response says in production: the raw
 * message can hold internal details (SQL, file paths, hostnames). The full,
 * sanitized error is in the API error log. Development keeps the raw message.
 */
export const INTERNAL_ERROR_MESSAGE = "An unexpected error occurred. Please try again.";

function unexpectedErrorMessage(error: unknown) {
  return process.env.NODE_ENV === "production" ? INTERNAL_ERROR_MESSAGE : getErrorMessage(error);
}

/**
 * For routes that build their own error response: `value` in development,
 * undefined in production (JSON then leaves the field out). Raw errors and
 * their messages never reach clients in production.
 *
 *   { message: developmentOnly(error instanceof Error ? error.message : undefined) ?? "Failed to load mediums" }
 */
export function developmentOnly<T>(value: T): T | undefined {
  return process.env.NODE_ENV === "production" ? undefined : value;
}

function recordedStatus(statusCode: number | undefined) {
  return statusCode !== undefined && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : 500;
}

// ---- Console output (PM2 log) ----------------------------------------------------

/** Console lines for unexpected route errors, per minute; the file log is not limited by this. */
export const ROUTE_ERROR_CONSOLE_LINES_PER_MINUTE = 30;

function createConsoleGate(now?: () => number) {
  const limiter = createRateLimiter({
    perKey: ROUTE_ERROR_CONSOLE_LINES_PER_MINUTE,
    global: ROUTE_ERROR_CONSOLE_LINES_PER_MINUTE,
    windowMs: 60_000,
    now,
  });

  return { limiter, suppressed: 0 };
}

let consoleGate = createConsoleGate();

/** Tests only: a fresh console limit, optionally on a test clock. */
export function resetRouteErrorConsoleForTests(now?: () => number) {
  consoleGate = createConsoleGate(now);
}

// Errors Next.js throws on purpose (redirect(), notFound(), dynamic rendering
// bailouts during `next build`): not failures, never written to the error log.
function isNextControlFlowError(error: unknown) {
  const digest = (error as { digest?: unknown } | null)?.digest;

  return (
    typeof digest === "string" &&
    (digest.startsWith("NEXT_REDIRECT") ||
      digest === "NEXT_NOT_FOUND" ||
      digest === "DYNAMIC_SERVER_USAGE" ||
      digest === "BAILOUT_TO_CLIENT_SIDE_RENDERING")
  );
}

/**
 * Writes an unexpected route error to the API error log (lib/error-logging)
 * and prints one sanitized line to the console (PM2 log): never the raw
 * error, whose message or stack can hold secrets or personal data. The full,
 * sanitized details are in the log entry the line points to.
 *
 * Console lines are limited (ROUTE_ERROR_CONSOLE_LINES_PER_MINUTE): during an
 * error burst the rest are counted, not printed, and the next printed line
 * says how many were skipped. Every error is still written to the file log.
 * Server only, like this module. Never throws.
 */
function logUnexpectedRouteError(
  error: unknown,
  label: string,
  kind: string,
  context: ReportRouteErrorContext | undefined,
  statusCode: number
) {
  try {
    // The context is required by the types; `?.` keeps a caller compiled
    // without one (plain JS, an unchecked build) logging rather than failing.
    const entry =
      !isNextControlFlowError(error) && process.env.NEXT_PHASE !== "phase-production-build"
        ? logErrorEntry(error, { source: "api", kind, statusCode, request: context?.request })
        : null;

    if (!consoleGate.limiter.allow(null)) {
      consoleGate.suppressed += 1;
      return;
    }

    // The entry's name and message are already sanitized: no second normalization.
    const summary = entry ? scrubText(`${entry.name}: ${entry.message.split("\n")[0] ?? ""}`, 300) : summarizeError(error);
    const skipped = consoleGate.suppressed;

    consoleGate.suppressed = 0;
    console.error(
      `${label}: ${summary}${entry ? ` (error log ${entry.id})` : ""}` +
        (skipped > 0 ? ` [${skipped} earlier route error line(s) not printed: console limit; all are in the error log]` : "")
    );
  } catch {
    // Logging never breaks the response.
  }
}

/**
 * For routes that keep their own catch block and response: logs the error
 * if it is unexpected (not an AppError, not Next.js control flow), with a
 * sanitized console line instead of the raw error. Never changes the response.
 * Pass the status the route responds with, so the log records it.
 *
 *   } catch (error) {
 *     reportRouteError(error, { request, statusCode: 400 });
 *     return NextResponse.json(..., { status: 400 });   // unchanged
 *   }
 */
export function reportRouteError(error: unknown, context: ReportRouteErrorContext) {
  if (error instanceof AppError) return;

  logUnexpectedRouteError(error, context?.label ?? "Route error", "route-catch", context, recordedStatus(context?.statusCode));
}

/**
 * The API routes' shared exception handler:
 * AppError -> its message, status and code, SyntaxError -> 400 INVALID_JSON,
 * anything else -> 500 INTERNAL_SERVER_ERROR, written to the API error log.
 * In production that 500 carries a generic message, never the raw one.
 */
export function handleRouteError(error: unknown, context: RouteErrorContext) {
  if (error instanceof AppError) {
    return apiError(error.message, error.statusCode, error.code, error.details);
  }

  if (error instanceof SyntaxError) {
    return apiError("Invalid JSON payload.", 400, "INVALID_JSON");
  }

  logUnexpectedRouteError(error, "Unhandled route error", "unhandled-route-error", context, 500);

  return apiError(unexpectedErrorMessage(error), 500, "INTERNAL_SERVER_ERROR");
}

/**
 * Wraps a route handler so anything it throws goes through handleRouteError
 * (with the request, for the log). For new routes:
 *
 *   export const POST = withApiErrorHandling(async (request) => { ... });
 */
export function withApiErrorHandling<Context>(
  handler: (request: Request, context: Context) => Response | Promise<Response>
) {
  return async (request: Request, context: Context): Promise<Response> => {
    try {
      return await handler(request, context);
    } catch (error) {
      return handleRouteError(error, { request });
    }
  };
}
