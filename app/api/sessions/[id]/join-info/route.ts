import { apiError, apiSuccess } from "@/lib/api-response";
import { requireStudentSession, requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { ensureSessionAccessForTeacher, getSessionJoinInfo, getSessionJoinInfoForTeacher } from "@/services/session-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const sessionId = context.params.id;
    const { searchParams } = new URL(request.url);
    const role = searchParams.get("role")?.trim();
    const studentId = searchParams.get("studentId")?.trim();

    if (!sessionId?.trim()) {
      return apiError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    if (role === "teacher") {
      const teacherSession = await requireTeacherSession();
      await ensureSessionAccessForTeacher(teacherSession.teacherId, sessionId);
      const joinInfo = await getSessionJoinInfoForTeacher(sessionId);
      return apiSuccess(joinInfo);
    }

    const studentSession = await requireStudentSession();

    if (studentId && studentId !== studentSession.studentId) {
      return apiError("studentId does not match the logged in student.", 403, "FORBIDDEN");
    }

    const joinInfo = await getSessionJoinInfo(sessionId, studentSession.studentId);

    return apiSuccess(joinInfo);
  } catch (error) {
    return handleRouteError(error);
  }
}
