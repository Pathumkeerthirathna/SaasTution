import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { STREAM_LIMIT_CODES, STREAM_RETRY_AFTER_SECONDS } from "@/services/recorded-lecture-stream-service";
import { streamTeacherRecording } from "@/services/recorded-lecture-teacher-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * Owner preview of a READY recorded lecture (teacher only): the same Range
 * streaming, headers, slots and cleanup as the student stream (RL-4.3), with
 * ownership checked on every request. HEAD exported explicitly (never opens
 * the file). Other teachers and students get 401 / 404.
 */
async function handle(request: Request, recordingId: string): Promise<Response> {
  try {
    const session = await requireTeacherSession();
    return await streamTeacherRecording({ teacherId: session.teacherId, recordingId, request });
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
