import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { listSessionsForLectureForTeacher } from "@/services/lecture-service";
import { startSessionForLectureForTeacher } from "@/services/session-service";

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

    const sessions = await listSessionsForLectureForTeacher(
      session.teacherId,
      lectureId
    );

    return apiSuccess(sessions);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
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

    const result = await startSessionForLectureForTeacher(
      session.teacherId,
      lectureId
    );

    return apiSuccess({ session: result.session }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
