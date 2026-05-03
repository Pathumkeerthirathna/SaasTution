import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateQuizSchema } from "@/lib/lecture-validation";
import { deleteQuizForTeacher, updateQuizForTeacher } from "@/services/lecture-service";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: {
    params: { id: string; quizId: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const lectureId = context.params.id;
    const quizId = context.params.quizId;

    if (!lectureId?.trim() || !quizId?.trim()) {
      throw new AppError("Lecture id and quiz id are required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as {
      title?: string;
      questions?: Array<{
        id?: string;
        text?: string;
        answerType?: "SINGLE" | "MULTIPLE";
        options?: Array<{
          id?: string;
          text?: string;
          isCorrect?: boolean;
        }>;
      }>;
    };

    const parsed = updateQuizSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const quiz = await updateQuizForTeacher(session.teacherId, lectureId, quizId, parsed.data);

    return apiSuccess(
      {
        quiz,
      },
      {
        message: "Quiz updated successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: {
    params: { id: string; quizId: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const lectureId = context.params.id;
    const quizId = context.params.quizId;

    if (!lectureId?.trim() || !quizId?.trim()) {
      throw new AppError("Lecture id and quiz id are required.", 400, "VALIDATION_ERROR");
    }

    await deleteQuizForTeacher(session.teacherId, lectureId, quizId);

    return apiSuccess(
      {
        deleted: true,
      },
      {
        message: "Quiz deleted successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
