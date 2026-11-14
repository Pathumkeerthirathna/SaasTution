import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { uploadErrorResponse } from "@/lib/recorded-lectures/upload-errors";
import { completeRecordingUpload } from "@/services/recorded-lecture-completion-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Completes a recorded-lecture upload (Recorded Lectures RL-3.4): asynchronous.
 *
 *   POST /api/recorded-lectures/uploads/[uploadId]/complete   (no body)
 *
 * 202 with the upload's status (uploadState COMPLETING, recordingState
 * VERIFYING): the verification, assembly, MP4 inspection and READY transition
 * run in the background (services/recorded-lecture-completion-service.ts).
 * Poll GET /api/recorded-lectures/uploads/[uploadId] until uploadState is
 * COMPLETED (recordingState READY) or FAILED (failureCode). While COMPLETING,
 * completionStalled: true means the completion stopped (e.g. a restart): call
 * this endpoint again to resume it. Repeating the call while it runs only
 * returns the status again.
 */
export async function POST(request: Request, context: { params: { uploadId: string } }) {
  try {
    const session = await requireTeacherSession();
    const status = await completeRecordingUpload({ teacherId: session.teacherId, uploadId: context.params.uploadId });
    return apiSuccess(status, { status: 202, message: "The upload is being verified." });
  } catch (error) {
    return uploadErrorResponse(error, request);
  }
}
