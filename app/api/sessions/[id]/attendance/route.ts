import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { listSessionAttendanceForTeacher } from "@/services/session-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
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

    const result = await listSessionAttendanceForTeacher({
      teacherId: session.teacherId,
      sessionId,
    });

    return apiSuccess({
      session: result.session,
      joinedStudents: result.joinedStudents,
      notJoinedStudents: result.notJoinedStudents,
    });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
