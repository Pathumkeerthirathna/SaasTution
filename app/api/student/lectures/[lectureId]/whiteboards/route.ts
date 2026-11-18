import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { listWhiteboardsForLectureForStudent } from "@/services/lecture-whiteboard-service";
import { assertContentAccessForStudent } from "@/services/class-access-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/student/lectures/[lectureId]/whiteboards
// Saved whiteboards of a lecture the student is enrolled in (view only).
export async function GET(
  _request: Request,
  context: { params: { lectureId: string } }
) {
  try {
    const session = await requireStudentSession();
    const { lectureId } = context.params;

    if (!lectureId?.trim()) {
      throw new AppError("Lecture id is required.", 400, "VALIDATION_ERROR");
    }
    // Payment-due access control (services/class-access-service.ts).
    await assertContentAccessForStudent(session.studentId, { lectureId });

    const whiteboards = await listWhiteboardsForLectureForStudent(session.studentId, lectureId);
    return apiSuccess(whiteboards);
  } catch (error) {
    return handleRouteError(error, { request: _request });
  }
}
