import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { listWhiteboardsForLectureForStudent } from "@/services/lecture-whiteboard-service";
import { prisma } from "@/lib/prisma";
import { billingMonthOf, loadStudentResourceAccess, resourceLockFor } from "@/services/resource-access-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/student/lectures/[lectureId]/whiteboards
// Saved whiteboards of a lecture the student is enrolled in (view only).
// Each carries `access` (services/resource-access-service.ts): a whiteboard
// of a locked billing month is listed locked and its own route refuses it.
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
    const whiteboards = await listWhiteboardsForLectureForStudent(session.studentId, lectureId);
    const lecture = await prisma.lecture.findUnique({ where: { id: lectureId }, select: { classId: true } });
    const access = lecture ? await loadStudentResourceAccess(session.studentId, { classIds: [lecture.classId] }) : null;
    return apiSuccess(
      whiteboards.map((board) => {
        const month = billingMonthOf(new Date(board.createdAt));
        return {
          ...board,
          resourceAccess: access && lecture ? resourceLockFor(access, lecture.classId, month) : { locked: false, ...month },
        };
      })
    );
  } catch (error) {
    return handleRouteError(error, { request: _request });
  }
}
