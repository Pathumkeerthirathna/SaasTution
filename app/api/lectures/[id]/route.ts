import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateLectureSchema } from "@/lib/lecture-validation";
import { deleteLectureForTeacher, updateLectureForTeacher } from "@/services/lecture-service";

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

    const body = (await request.json()) as {
      title?: string;
      date?: string;
    };

    const parsed = updateLectureSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const lecture = await updateLectureForTeacher(session.teacherId, lectureId, parsed.data);

    return apiSuccess(
      {
        lecture,
      },
      {
        message: "Lecture updated successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  _request: Request,
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

    await deleteLectureForTeacher(session.teacherId, lectureId);

    return apiSuccess(
      {
        deleted: true,
      },
      {
        message: "Lecture deleted successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
