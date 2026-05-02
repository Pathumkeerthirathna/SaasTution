import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { createQuizSchema } from "@/lib/lecture-validation";
import { addQuizToLectureForTeacher, listQuizzesForLectureForTeacher } from "@/services/lecture-service";

export const dynamic = "force-dynamic";

export async function GET(
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

    const quizzes = await listQuizzesForLectureForTeacher(session.teacherId, lectureId);
    return apiSuccess(quizzes);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
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
    };

    const parsed = createQuizSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const quiz = await addQuizToLectureForTeacher(session.teacherId, lectureId, parsed.data);

    return apiSuccess(
      {
        quiz,
      },
      {
        status: 201,
        message: "Quiz added successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
