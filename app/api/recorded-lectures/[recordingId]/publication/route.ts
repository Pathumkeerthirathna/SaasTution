import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { readLimitedJson, START_UPLOAD_BODY_MAX_BYTES } from "@/lib/recorded-lectures/request-body";
import { uploadErrorResponse } from "@/lib/recorded-lectures/upload-errors";
import { updateRecordingPublicationForTeacher } from "@/services/recorded-lecture-publication-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * A recorded lecture's public-page settings, for its teacher only (outside
 * the middleware matcher like the other /api/recorded-lectures routes: the
 * handler authenticates the teacher and the service checks ownership).
 *
 *   PUT { visibility?: "PUBLIC" | "PRIVATE", access?: "FREE" | "LOCKED" }
 *     -> { recording: { id, visibility, access } }
 *   401 without a teacher session; 404 for a recording that is not the
 *   teacher's own active one; 400 for invalid values.
 */
export async function PUT(request: Request, context: { params: { recordingId: string } }) {
  try {
    const session = await requireTeacherSession();
    const body = await readLimitedJson(request, START_UPLOAD_BODY_MAX_BYTES);
    const recording = await updateRecordingPublicationForTeacher({
      teacherId: session.teacherId,
      recordingId: context.params.recordingId,
      body,
    });
    const response = apiSuccess({ recording }, { message: "Recording settings updated." });
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) {
    return uploadErrorResponse(error, request);
  }
}
