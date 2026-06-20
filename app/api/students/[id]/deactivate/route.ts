import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { deactivateStudentForTeacher } from "@/services/student-service";

export async function PUT(
  _request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const studentId = context.params.id;

    if (!studentId?.trim()) {
      throw new AppError(
        "Student id is required.",
        400,
        "VALIDATION_ERROR"
      );
    }

    await deactivateStudentForTeacher(
      session.teacherId,
      studentId
    );

    return apiSuccess(
      null,
      {
        message: "Student activated successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}