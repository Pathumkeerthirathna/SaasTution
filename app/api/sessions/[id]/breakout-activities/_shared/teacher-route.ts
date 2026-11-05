// Shared helpers of the teacher breakout activity routes
// (/api/sessions/[id]/breakout-activities/...). The "_shared" folder is
// private: Next.js never serves it as a route.
//
// Every teacher route is an exported `async function METHOD(request, context)`
// whose try block starts with requireBreakoutTeacher() and whose catch block
// is `return handleRouteError(error, { request })` (the project convention,
// checked by tests/error-logging/review-fixes.test.cjs). In that order:
//   1. the feature flag: off -> 404 NOT_FOUND, before anything else (an
//      unauthenticated caller learns nothing either);
//   2. the teacher from the signed login cookie (requireTeacherSession, the
//      existing convention): none or not a teacher -> 401;
//   3. request validation, then the service, which checks ownership
//      (another teacher's session = 404), parent ids and state;
//   4. errors: AppError -> its status and code, a malformed JSON body ->
//      400 INVALID_JSON, anything else -> 500 (logged; generic in production).
// Ids, roles and room data are never taken from the request body; the
// teacher id passed to services is always the one from the login session.

import type { z } from "zod";

import { requireTeacherSession } from "@/lib/auth-session";
import { breakoutError } from "@/lib/breakout-activities/errors";
import { assertBreakoutActivitiesEnabled } from "@/lib/breakout-activities/flag";
import { breakoutPdfDownloadHeaders } from "@/lib/breakout-activities/storage";

/** Steps 1 and 2: the feature flag, then the logged-in teacher's id. */
export async function requireBreakoutTeacher(): Promise<string> {
  assertBreakoutActivitiesEnabled();
  const teacher = await requireTeacherSession();
  return teacher.teacherId;
}

/** Validates with a zod schema; 400 VALIDATION_ERROR with the first issue's message otherwise. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Invalid request payload.";
    throw breakoutError(
      "VALIDATION_ERROR",
      first,
      parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    );
  }
  return parsed.data;
}

/** The request's media type (no parameters), lower-cased. */
export function mediaType(request: Request): string {
  return (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

/** One optional query parameter; sent more than once is a validation error. */
export function singleQueryParam(request: Request, name: string): string | undefined {
  const values = new URL(request.url).searchParams.getAll(name);
  if (values.length > 1) throw breakoutError("VALIDATION_ERROR", `The query parameter "${name}" was sent more than once.`);
  return values[0];
}

/** A PDF download: attachment, nosniff, no caching, the sanitized display name. */
export function pdfResponse(download: { bytes: Uint8Array; displayName: string; sizeBytes: number }): Response {
  // readBreakoutFile returns bytes over a plain ArrayBuffer.
  return new Response(download.bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: breakoutPdfDownloadHeaders(download.displayName, download.sizeBytes),
  });
}
