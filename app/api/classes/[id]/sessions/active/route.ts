import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { getActiveClassSessionForTeacher } from "@/services/session-service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const classId = context.params.id;

    if (!classId?.trim()) {
      throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
    }

    const activeSession = await getActiveClassSessionForTeacher(session.teacherId, classId);

    return apiSuccess({
      session: activeSession,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
