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

    const submission = await prisma.quizSubmission.findUnique({
      where: {
        quizId_studentId: {
          quizId,
          studentId: studentSession.studentId,
        },
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
            isCorrect: true,
          },
        },
        quiz: {
          select: {
            id: true,
            title: true,
            maxAttempts: true,
            dueDate: true,
            status: true,
            lecture: {
              select: {
                status: true,
                class: {
                  select: {
                    students: {
                      where: {
                        studentId: studentSession.studentId,
                        isActive: true,
                      },
                      select: { id: true },
                    },
                  },
                },
              },
            },
            questions: {
              orderBy: { orderIndex: "asc" },
              select: {
                id: true,
                text: true,
                orderIndex: true,
                answerType: true,
                options: {
                  orderBy: { orderIndex: "asc" },
                  select: {
                    id: true,
                    text: true,
                    isCorrect: true,
                    orderIndex: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!submission) {
      throw new AppError("No submission found for this quiz.", 404, "SUBMISSION_NOT_FOUND");
    }

    const enrolled = submission.quiz.lecture.class.students.length > 0;
    if (!enrolled) {
      throw new AppError("Quiz not found.", 404, "QUIZ_NOT_FOUND");
    }

    if (submission.quiz.status !== 0 || submission.quiz.lecture.status !== 0) {
      throw new AppError("Quiz not found.", 404, "QUIZ_NOT_FOUND");
    }

    const answerByQuestionId = new Map(
      submission.answers.map((answer) => [
        answer.questionId,
        { selectedOptionIds: answer.selectedOptionIds, isCorrect: answer.isCorrect },
      ])
    );

    return apiSuccess({
      quiz: {
        id: submission.quiz.id,
        title: submission.quiz.title,
        questions: submission.quiz.questions.map((question) => {
          const studentAnswer = answerByQuestionId.get(question.id);
          return {
            id: question.id,
            text: question.text,
            answerType: question.answerType,
            isCorrect: studentAnswer?.isCorrect ?? false,
            selectedOptionIds: studentAnswer?.selectedOptionIds ?? [],
            options: question.options.map((option) => ({
              id: option.id,
              text: option.text,
              isCorrect: option.isCorrect,
            })),
          };
        }),
      },
      submission: {
        id: submission.id,
        score: submission.score,
        totalQuestions: submission.totalQuestions,
        attemptCount: submission.attemptCount,
        submittedAt: submission.submittedAt,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
