import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateStudentSchema } from "@/lib/student-validation";
import { getStudentProfileForTeacher, updateStudentForTeacher } from "@/services/student-service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
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

    const profile = await getStudentProfileForTeacher(session.teacherId, studentId);
    return apiSuccess(profile);
  } catch (error) {
    return handleRouteError(error);
  }
}

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

    const body = (await request.json()) as {
      name?: string;
      grade?: string;
      contact01?: string;
      contact02?: string;
      email?: string;
    };

    const parsed = updateStudentSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const student = await updateStudentForTeacher(session.teacherId, studentId, parsed.data);

    return apiSuccess(
      {
        student,
      },
      {
        message: "Student updated successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
