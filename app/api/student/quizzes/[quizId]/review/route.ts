import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { reviewQuestionsFromAnswers, STORED_QUIZ_ANSWER_SELECT } from "@/lib/quiz-answer-snapshot";
import { assertContentAccessForStudent } from "@/services/class-access-service";

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
    // Payment-due access control (services/class-access-service.ts).
    await assertContentAccessForStudent(studentSession.studentId, { quizId });

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
        // The submitted answers with their snapshots: the review is built from
        // these only (lib/quiz-answer-snapshot.ts), never from the quiz's
        // current questions, which a later edit may have replaced.
        answers: {
          select: STORED_QUIZ_ANSWER_SELECT,
        },
        quiz: {
          select: {
            id: true,
            title: true,
            maxAttempts: true,
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

    return apiSuccess({
      quiz: {
        id: submission.quiz.id,
        title: submission.quiz.title,
        // Exactly the questions of the submitted attempt, as they were answered.
        questions: reviewQuestionsFromAnswers(submission.answers),
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
    return handleRouteError(error, { request: _request });
  }
}
