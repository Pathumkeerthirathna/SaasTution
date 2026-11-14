import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { readLimitedJson, START_UPLOAD_BODY_MAX_BYTES } from "@/lib/recorded-lectures/request-body";
import { uploadErrorResponse } from "@/lib/recorded-lectures/upload-errors";
import { startRecordingUpload } from "@/services/recorded-lecture-upload-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Starts a recorded-lecture upload for the signed-in teacher's lecture
 * (Recorded Lectures RL-3.2). JSON body (at most 16 KiB):
 *   { title, partNumber, fileName, mimeType: "video/mp4", sizeBytes }
 * Any other field (teacherId, classId...) is ignored: the teacher is the
 * session's. 201 with the upload's status (services/recorded-lecture-upload-service.ts).
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  try {
    const session = await requireTeacherSession();
    const body = await readLimitedJson(request, START_UPLOAD_BODY_MAX_BYTES);
    const upload = await startRecordingUpload({ teacherId: session.teacherId, lectureId: context.params.id, body });
    return apiSuccess(upload, { status: 201, message: "Upload started." });
  } catch (error) {
    return uploadErrorResponse(error, request);
  }
}
