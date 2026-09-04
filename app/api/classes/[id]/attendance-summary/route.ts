import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { getClassAttendanceSummaryForTeacher } from "@/services/student-service";

export const dynamic = "force-dynamic";

// GET /api/classes/[id]/attendance-summary
// Per-student attendance percentage for the class, for the teacher's in-session
// Attendance panel.
export async function GET(
  _request: Request,
  context: { params: { id: string } }
) {
  try {
    const session = await requireTeacherSession();
    const classId = context.params.id;

    if (!classId?.trim()) {
      throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
    }

    const students = await getClassAttendanceSummaryForTeacher({
      teacherId: session.teacherId,
      classId,
    });

    return apiSuccess({ students });
  } catch (error) {
    return handleRouteError(error);
  }
}
