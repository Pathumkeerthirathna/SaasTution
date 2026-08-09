import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { listStudentsForClassroom } from "@/services/student-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();

    const classId = context.params.id;

    if (!classId?.trim()) {
      throw new AppError(
        "Class id is required.",
        400,
        "VALIDATION_ERROR"
      );
    }

    const students = await listStudentsForClassroom({
      teacherId: session.teacherId,
      classId,
    });

    return apiSuccess(students);

  } catch (error) {
    return handleRouteError(error);
  }
}