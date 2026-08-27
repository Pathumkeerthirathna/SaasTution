import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateLectureClassStatusSchema } from "@/lib/lecture-validation";
import { updateLectureClassStatusForTeacher } from "@/services/lecture-service";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const lectureId = context.params.id;

    if (!lectureId?.trim()) {
      throw new AppError("Lecture id is required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as { classStatus?: string };

    const parsed = updateLectureClassStatusSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const lecture = await updateLectureClassStatusForTeacher(
      session.teacherId,
      lectureId,
      parsed.data.classStatus
    );

    return apiSuccess(
      {
        lecture,
      },
      {
        message: "Lecture status updated successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
