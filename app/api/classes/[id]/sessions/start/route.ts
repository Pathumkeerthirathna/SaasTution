import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { startClassSessionForTeacher } from "@/services/session-service";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const classId = context.params.id;

    if (!classId?.trim()) {
      throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
    }

    const result = await startClassSessionForTeacher(session.teacherId, classId);

    return apiSuccess(result, {
      status: 201,
      message: "Class session started successfully.",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
