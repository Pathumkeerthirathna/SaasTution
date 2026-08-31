import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: { quizId: string } }
) {
  try {
    const studentSession = await requireStudentSession();
    const quizId = context.params.quizId;

    if (!quizId?.trim()) {
      throw new AppError("Quiz id is required.", 400, "VALIDATION_ERROR");
    }

    const quiz = await prisma.quiz.findFirst({
      where: {
        id: quizId,
        status: 0,
        lecture: {
          status: 0,
          class: {
            students: {
              some: {
                studentId: studentSession.studentId,
                isActive: true,
              },
            },
          },
        },
      },
      select: {
        id: true,
        title: true,
        maxAttempts: true,
        dueDate: true,
        questions: {
          orderBy: {
            orderIndex: "asc",
          },
          select: {
            id: true,
            text: true,
            orderIndex: true,
            answerType: true,
            options: {
              orderBy: {
                orderIndex: "asc",
              },
              select: {
                id: true,
                text: true,
                orderIndex: true,
              },
            },
          },
        },
        submissions: {
          where: {
            studentId: studentSession.studentId,
          },
          select: {
            id: true,
            score: true,
            totalQuestions: true,
            attemptCount: true,
            submittedAt: true,
            answers: {
              select: {
                questionId: true,
                selectedOptionIds: true,
              },
            },
          },
          take: 1,
        },
      },
    });

    if (!quiz) {
      throw new AppError("Quiz not found.", 404, "QUIZ_NOT_FOUND");
    }

    return apiSuccess({
      quiz: {
        id: quiz.id,
        title: quiz.title,
        maxAttempts: quiz.maxAttempts,
        dueDate: quiz.dueDate,
        questions: quiz.questions,
      },
      submission: quiz.submissions[0] ?? null,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
