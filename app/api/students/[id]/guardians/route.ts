import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { listGuardiansForTeacher } from "@/services/student-service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: { id: string } }
) {
  try {
    const session = await requireTeacherSession();
    const studentId = context.params.id;

    if (!studentId?.trim()) {
      throw new AppError("Student id is required.", 400, "VALIDATION_ERROR");
    }

    const guardians = await listGuardiansForTeacher(session.teacherId, studentId);
    return apiSuccess(guardians);
  } catch (error) {
    return handleRouteError(error);
  }
}
