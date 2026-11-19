import { AppError, handleRouteError } from "@/lib/error-handler";
import { STREAM_LIMIT_CODES, STREAM_RETRY_AFTER_SECONDS } from "@/services/recorded-lecture-stream-service";
import { streamPublicRecordedLecture } from "@/services/recorded-lecture-public-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * Public playback of an uploaded recorded lecture from a public class page
 * (anyone, no session):
 *
 *   GET  -> 200 (whole file) / 206 (one byte range) / 416, video/mp4
 *   HEAD -> the same status and headers, no body; the file is never opened
 *           and no stream slot is taken
 *
 * Only a recording that is PUBLIC + Unlocked (FREE), READY, active, of an
 * active lecture and class, of a teacher whose public profile is enabled, is
 * played; every other case is the same 404 RECORDED_LECTURE_NOT_FOUND. The
 * rule is re-checked on every request (services/recorded-lecture-public-service.ts).
 * HEAD is exported explicitly (Next.js 14.2 would otherwise run GET).
 * Outside the middleware matcher (/api/public). Error responses: JSON (no
 * body for HEAD), never cached; 429 / 503 carry Retry-After.
 */

/** The route error response, made uncacheable; Retry-After for the slot refusals; no body for HEAD. */
function streamErrorResponse(error: unknown, response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("X-Content-Type-Options", "nosniff");
  if (error instanceof AppError && error.code && STREAM_LIMIT_CODES.has(error.code)) {
    headers.set("Retry-After", String(STREAM_RETRY_AFTER_SECONDS));
  }
  if (request.method.toUpperCase() === "HEAD") {
    headers.delete("Content-Length");
    return new Response(null, { status: response.status, headers });
  }
  return new Response(response.body, { status: response.status, headers });
}

export async function GET(request: Request, context: { params: { recordingId: string } }) {
  try {
    return await streamPublicRecordedLecture({ recordingId: context.params.recordingId, request });
  } catch (error) {
    return streamErrorResponse(error, handleRouteError(error, { request }), request);
  }
}

export async function HEAD(request: Request, context: { params: { recordingId: string } }) {
  try {
    return await streamPublicRecordedLecture({ recordingId: context.params.recordingId, request });
  } catch (error) {
    return streamErrorResponse(error, handleRouteError(error, { request }), request);
  }
}
