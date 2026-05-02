import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { endClassSessionForTeacher } from "@/services/session-service";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      throw new AppError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    const result = await endClassSessionForTeacher(session.teacherId, sessionId);

    return apiSuccess(result, {
      message: "Class session ended successfully.",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
