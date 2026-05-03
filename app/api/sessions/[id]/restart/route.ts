import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { restartClassSessionForTeacher } from "@/services/session-service";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const teacherSession = await requireTeacherSession();
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      throw new AppError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    const result = await restartClassSessionForTeacher(teacherSession.teacherId, sessionId);

    return apiSuccess(result, {
      status: 201,
      message: "Session restarted successfully.",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
