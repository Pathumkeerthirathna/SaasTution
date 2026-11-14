import { AppError, handleRouteError } from "@/lib/error-handler";
import { requireStudentSession } from "@/lib/auth-session";
import {
  STREAM_LIMIT_CODES,
  STREAM_RETRY_AFTER_SECONDS,
  streamStudentRecordedLecture,
} from "@/services/recorded-lecture-stream-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * Student playback of one recorded lecture (Recorded Lectures RL-4.3).
 *
 *   GET  -> 200 (whole file) / 206 (one byte range) / 416, video/mp4
 *   HEAD -> the same status and headers, no body; the file is never opened
 *           and no stream slot is taken
 *
 * HEAD is exported explicitly: Next.js 14.2 would otherwise answer HEAD with
 * the GET handler, which opens the file. Outside the middleware matcher like
 * the other /api/student routes; every request authenticates
 * (requireStudentSession) and is authorised again by the service.
 *
 * Error responses: JSON (no body for HEAD), never cached; 429
 * STREAM_LIMIT_REACHED and 503 STREAMING_BUSY carry Retry-After.
 */

async function handle(request: Request, recordingId: string): Promise<Response> {
  try {
    const session = await requireStudentSession();
    return await streamStudentRecordedLecture({ studentId: session.studentId, recordingId, request });
  } catch (error) {
    const response = handleRouteError(error, { request });
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
}

export async function GET(request: Request, context: { params: { recordingId: string } }) {
  return handle(request, context.params.recordingId);
}

export async function HEAD(request: Request, context: { params: { recordingId: string } }) {
  return handle(request, context.params.recordingId);
}
