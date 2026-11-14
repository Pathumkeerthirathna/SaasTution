import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { getStudentRecordedLecture } from "@/services/recorded-lecture-student-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * One recorded lecture's metadata for the signed-in student (Recorded
 * Lectures RL-4.2). 404 RECORDED_LECTURE_NOT_FOUND, identical, for a missing
 * recording and for one the student may not see. Playback (/stream) is RL-4.3.
 */
export async function GET(request: Request, context: { params: { recordingId: string } }) {
  try {
    const session = await requireStudentSession();
    const recordedLecture = await getStudentRecordedLecture({
      studentId: session.studentId,
      recordingId: context.params.recordingId,
    });
    return apiSuccess({ recordedLecture });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
