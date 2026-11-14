import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { uploadErrorResponse } from "@/lib/recorded-lectures/upload-errors";
import { cancelRecordingUpload } from "@/services/recorded-lecture-completion-service";
import { getRecordingUploadStatus } from "@/services/recorded-lecture-upload-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * Recorded-lecture uploads by id (Recorded Lectures RL-3).
 *
 * Deliberately OUTSIDE the middleware matcher (middleware.ts covers
 * /api/lectures/... but not /api/recorded-lectures/...): Next.js 14.2 buffers
 * the whole body of a POST / PUT that passes the middleware, which the chunk
 * route below this path (RL-3.3) must avoid. Every handler authenticates the
 * teacher itself (requireTeacherSession) and only ever touches the caller's
 * own uploads.
 */

/** The upload's status (RL-3.2); 404 for a missing upload and for another teacher's. */
export async function GET(request: Request, context: { params: { uploadId: string } }) {
  try {
    const session = await requireTeacherSession();
    const upload = await getRecordingUploadStatus({ teacherId: session.teacherId, uploadId: context.params.uploadId });
    return apiSuccess(upload);
  } catch (error) {
    return uploadErrorResponse(error, request);
  }
}

/**
 * Cancels the upload (RL-3.4); the database only, no file is deleted (RL-3.5
 * cleans up). 200 with the status (CANCELLED, or the state it already ended
 * in); 409 UPLOAD_BUSY while a chunk of it is being received (nothing
 * changed), 409 UPLOAD_COMPLETING while its completion is running, 409
 * UPLOAD_ALREADY_COMPLETED once completed. Allowed for a blocked owner.
 */
export async function DELETE(request: Request, context: { params: { uploadId: string } }) {
  try {
    const session = await requireTeacherSession();
    const upload = await cancelRecordingUpload({ teacherId: session.teacherId, uploadId: context.params.uploadId });
    return apiSuccess(upload, { message: "Upload cancelled." });
  } catch (error) {
    return uploadErrorResponse(error, request);
  }
}
