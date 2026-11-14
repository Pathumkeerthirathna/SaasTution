import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { readLimitedJson, START_UPLOAD_BODY_MAX_BYTES } from "@/lib/recorded-lectures/request-body";
import { uploadErrorResponse } from "@/lib/recorded-lectures/upload-errors";
import { deleteTeacherRecording, updateTeacherRecording } from "@/services/recorded-lecture-teacher-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * One recorded lecture, for its teacher. Outside the middleware matcher like
 * the other /api/recorded-lectures routes: every handler authenticates the
 * teacher itself and only touches the teacher's own recordings (404 otherwise).
 *
 *   PATCH  { title?, partNumber? }  -> the updated recording (409 PART_NUMBER_IN_USE)
 *   DELETE                          -> soft delete (status 2, purge pending);
 *                                      an active upload is cancelled first
 */
export async function PATCH(request: Request, context: { params: { recordingId: string } }) {
  try {
    const session = await requireTeacherSession();
    const body = await readLimitedJson(request, START_UPLOAD_BODY_MAX_BYTES);
    const recording = await updateTeacherRecording({ teacherId: session.teacherId, recordingId: context.params.recordingId, body });
    return apiSuccess({ recording }, { message: "Recording updated." });
  } catch (error) {
    return uploadErrorResponse(error, request);
  }
}

export async function DELETE(request: Request, context: { params: { recordingId: string } }) {
  try {
    const session = await requireTeacherSession();
    await deleteTeacherRecording({ teacherId: session.teacherId, recordingId: context.params.recordingId });
    return apiSuccess({ deleted: true }, { message: "Recording deleted." });
  } catch (error) {
    return uploadErrorResponse(error, request);
  }
}
