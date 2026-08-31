import { apiError, apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { submitQuizSchema } from "@/lib/quiz-submission-validation";

export const dynamic = "force-dynamic";

type QuestionShape = {
  id: string;
  answerType: "SINGLE" | "MULTIPLE";
  options: {
    id: string;
    isCorrect: boolean;
  }[];
};

function normalizeIds(ids: string[]) {
  return [...new Set(ids)].sort();
}

function sameSet(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((item, index) => item === right[index]);
}

function evaluateQuestion(question: QuestionShape, selectedOptionIds: string[]) {
  const validOptionIds = new Set(question.options.map((option) => option.id));

  if (selectedOptionIds.some((id) => !validOptionIds.has(id))) {
    throw new AppError("Submitted answer contains an invalid option.", 400, "VALIDATION_ERROR");
  }

  const normalizedSelected = normalizeIds(selectedOptionIds);

  if (question.answerType === "SINGLE" && normalizedSelected.length !== 1) {
    throw new AppError("Single-answer questions require exactly one option.", 400, "VALIDATION_ERROR");
  }

  if (question.answerType === "MULTIPLE" && normalizedSelected.length < 1) {
    throw new AppError("Multiple-answer questions require at least one option.", 400, "VALIDATION_ERROR");
  }

  const correctIds = normalizeIds(question.options.filter((option) => option.isCorrect).map((option) => option.id));
  const isCorrect = sameSet(normalizedSelected, correctIds);

  return {
    selectedOptionIds: normalizedSelected,
    isCorrect,
  };
}

export async function POST(
  request: Request,
  context: { params: { quizId: string } }
) {
  try {
    const studentSession = await requireStudentSession();
    const quizId = context.params.quizId;

    if (!quizId?.trim()) {
      throw new AppError("Quiz id is required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as {
      answers?: {
        questionId?: string;
        selectedOptionIds?: string[];
      }[];
    };

    const parsed = submitQuizSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
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
        maxAttempts: true,
        dueDate: true,
        questions: {
          orderBy: {
            orderIndex: "asc",
          },
          select: {
            id: true,
            answerType: true,
            options: {
              select: {
                id: true,
                isCorrect: true,
              },
            },
          },
        },
      },
    });

    if (!quiz) {
      throw new AppError("Quiz not found.", 404, "QUIZ_NOT_FOUND");
    }

    if (quiz.dueDate && new Date() > quiz.dueDate) {
      throw new AppError("This quiz is closed and no longer accepting submissions.", 403, "QUIZ_CLOSED");
    }

    if (quiz.questions.length === 0) {
      throw new AppError("Quiz has no questions.", 400, "QUIZ_HAS_NO_QUESTIONS");
    }

    const answerByQuestion = new Map(
      parsed.data.answers.map((answer) => [answer.questionId, answer.selectedOptionIds])
    );

    if (answerByQuestion.size !== parsed.data.answers.length) {
      throw new AppError("Duplicate question answers are not allowed.", 400, "VALIDATION_ERROR");
    }

    const evaluatedAnswers = quiz.questions.map((question) => {
      const selectedOptionIds = answerByQuestion.get(question.id);

      if (!selectedOptionIds) {
        throw new AppError("All questions must be answered.", 400, "VALIDATION_ERROR");
      }

      const evaluated = evaluateQuestion(question, selectedOptionIds);

      return {
        questionId: question.id,
        selectedOptionIds: evaluated.selectedOptionIds,
        isCorrect: evaluated.isCorrect,
      };
    });

    for (const answer of parsed.data.answers) {
      if (!quiz.questions.some((question) => question.id === answer.questionId)) {
        throw new AppError("Submitted answer contains an invalid question.", 400, "VALIDATION_ERROR");
      }
    }

    const score = evaluatedAnswers.filter((answer) => answer.isCorrect).length;
    const totalQuestions = quiz.questions.length;

    const submission = await prisma.$transaction(async (tx) => {
      const existing = await tx.quizSubmission.findUnique({
        where: {
          quizId_studentId: {
            quizId,
            studentId: studentSession.studentId,
          },
        },
        select: {
          id: true,
          attemptCount: true,
        },
      });

      if (quiz.maxAttempts !== null && existing && existing.attemptCount >= quiz.maxAttempts) {
        throw new AppError(
          `You have used all ${quiz.maxAttempts} attempt(s) for this quiz.`,
          403,
          "MAX_ATTEMPTS_REACHED"
        );
      }

      if (!existing) {
        return tx.quizSubmission.create({
          data: {
            quizId,
            studentId: studentSession.studentId,
            score,
            totalQuestions,
            attemptCount: 1,
            submittedAt: new Date(),
            answers: {
              createMany: {
                data: evaluatedAnswers,
              },
            },
          },
          select: {
            id: true,
            score: true,
            totalQuestions: true,
            attemptCount: true,
            submittedAt: true,
          },
        });
      }

      await tx.quizSubmissionAnswer.deleteMany({
        where: {
          submissionId: existing.id,
        },
      });

      return tx.quizSubmission.update({
        where: {
          id: existing.id,
        },
        data: {
          score,
          totalQuestions,
          attemptCount: { increment: 1 },
          submittedAt: new Date(),
          answers: {
            createMany: {
              data: evaluatedAnswers,
            },
          },
        },
        select: {
          id: true,
          score: true,
          totalQuestions: true,
          attemptCount: true,
          submittedAt: true,
        },
      });
    });

    return apiSuccess(
      {
        submission,
      },
      {
        status: 201,
        message: "Quiz submitted successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
