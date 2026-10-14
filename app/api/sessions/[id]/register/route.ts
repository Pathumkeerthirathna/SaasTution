import { apiError, apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { getClassRegisterForStudent } from "@/services/session-service";

export const dynamic = "force-dynamic";

/**
 * Student Class Register: the class's students (names only) for a student
 * enrolled in this live session's class. Teachers keep their own register
 * (GET /api/classes/[id]/ClassParticipants).
 */
export async function GET(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const studentSession = await requireStudentSession();
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      return apiError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    const register = await getClassRegisterForStudent({
      sessionId,
      studentId: studentSession.studentId,
    });

    return apiSuccess(register);
  } catch (error) {
    return handleRouteError(error);
  }
}
