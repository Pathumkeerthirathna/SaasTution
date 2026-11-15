import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { readLimitedJson, START_UPLOAD_BODY_MAX_BYTES } from "@/lib/recorded-lectures/request-body";
import { uploadErrorResponse } from "@/lib/recorded-lectures/upload-errors";
import { deleteTeacherRecordingPermanently, updateTeacherRecording } from "@/services/recorded-lecture-teacher-service";

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
    // Stage 3.6: PERMANENT. 200 only when the stored file is gone; 202 while its deletion is pending (retried by maintenance).
    const state = await deleteTeacherRecordingPermanently({ teacherId: session.teacherId, recordingId: context.params.recordingId });
    if (state === "PENDING") {
      return apiSuccess(
        { deleted: false, pending: true },
        { message: "The recording was removed. Its video file is still being deleted and will be removed automatically.", status: 202 }
      );
    }
    return apiSuccess({ deleted: true, pending: false }, { message: "Recording deleted permanently." });
  } catch (error) {
    return uploadErrorResponse(error, request);
  }
}
