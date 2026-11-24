import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError } from "@/lib/error-handler";
import { readLimitedJson, START_UPLOAD_BODY_MAX_BYTES } from "@/lib/recorded-lectures/request-body";
import { uploadErrorResponse } from "@/lib/recorded-lectures/upload-errors";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { parseNotesLectureParam } from "@/services/class-notes-service";
import { startClassRecordingUpload } from "@/services/class-recordings-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/classes/[id]/recorded-lectures/uploads[?lectureId=]
 *
 * Starts a recorded-lecture upload into the class's General Recordings (no
 * lectureId: the class's default lecture, resolved on the server) or into
 * one NORMAL lecture of the class. Same-origin first (403), then the teacher
 * session (401), then the class / lecture (404 CLASS_NOT_FOUND,
 * 409 DEFAULT_LECTURE_MISSING, 404 LECTURE_NOT_FOUND), then exactly the
 * existing upload start (POST /api/lectures/[id]/recorded-lectures/uploads):
 * the same JSON body { title, partNumber, fileName, mimeType: "video/mp4",
 * sizeBytes } (at most 16 KiB; any lectureId / classId in it is ignored), the
 * same validation, storage quota and upload lifecycle, and the same 201
 * upload status. Chunks, completion, status and cancel: the existing
 * /api/recorded-lectures/uploads/[uploadId] routes.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) {
    return apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  }

  try {
    const session = await requireTeacherSession();
    const classId = context.params.id?.trim();
    if (!classId) throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
    const lectureId = parseNotesLectureParam(new URL(request.url).searchParams.get("lectureId"));
    const body = await readLimitedJson(request, START_UPLOAD_BODY_MAX_BYTES);
    const upload = await startClassRecordingUpload({ teacherId: session.teacherId, classId, lectureId, body });
    return apiSuccess(upload, { status: 201, message: "Upload started." });
  } catch (error) {
    return uploadErrorResponse(error, request);
  }
}
