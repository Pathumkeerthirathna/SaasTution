import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { deactivateStudentForTeacher } from "@/services/student-service";

export async function PUT(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const studentId = context.params.id;

    if (!studentId?.trim()) {
      throw new AppError("Student id is required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    const reason = typeof body.reason === "string" ? body.reason : "";

    await deactivateStudentForTeacher(session.teacherId, studentId, reason);

    return apiSuccess(null, {
      message: "Student deactivated successfully.",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
