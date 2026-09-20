import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { getWhiteboardForStudent } from "@/services/lecture-whiteboard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/student/lectures/[lectureId]/whiteboards/[whiteboardId]
// One saved whiteboard, for read-only viewing.
export async function GET(
  _request: Request,
  context: { params: { lectureId: string; whiteboardId: string } }
) {
  try {
    const session = await requireStudentSession();
    const { lectureId, whiteboardId } = context.params;

    if (!lectureId?.trim() || !whiteboardId?.trim()) {
      throw new AppError("Lecture id and whiteboard id are required.", 400, "VALIDATION_ERROR");
    }

    const whiteboard = await getWhiteboardForStudent(session.studentId, lectureId, whiteboardId);
    return apiSuccess({ whiteboard });
  } catch (error) {
    return handleRouteError(error);
  }
}
