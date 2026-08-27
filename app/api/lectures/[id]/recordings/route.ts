import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { listRecordingsForLectureForTeacher } from "@/services/lecture-service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const lectureId = context.params.id;

    if (!lectureId?.trim()) {
      throw new AppError("Lecture id is required.", 400, "VALIDATION_ERROR");
    }

    const recordings = await listRecordingsForLectureForTeacher(session.teacherId, lectureId);
    return apiSuccess(recordings);
  } catch (error) {
    return handleRouteError(error);
  }
}
