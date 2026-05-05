import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: { id: string; quizId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const lectureId = context.params.id;
    const quizId = context.params.quizId;

    if (!lectureId?.trim() || !quizId?.trim()) {
      throw new AppError("Lecture id and quiz id are required.", 400, "VALIDATION_ERROR");
    }

    const quiz = await prisma.quiz.findFirst({
      where: {
        id: quizId,
        lectureId,
        lecture: {
          class: {
            teacherId: session.teacherId,
          },
        },
      },
      select: {
        id: true,
        title: true,
        maxAttempts: true,
        dueDate: true,
        questions: { select: { id: true } },
        submissions: {
          orderBy: { submittedAt: "desc" },
          select: {
            id: true,
            score: true,
            totalQuestions: true,
            attemptCount: true,
            submittedAt: true,
            student: {
              select: {
                id: true,
                name: true,
                registrationNumber: true,
              },
            },
          },
        },
      },
    });

    if (!quiz) {
      throw new AppError("Quiz not found.", 404, "QUIZ_NOT_FOUND");
    }

    const totalQuestions = quiz.questions.length;
    const enrolledCount = await prisma.classStudent.count({
      where: {
        class: {
          lectures: {
            some: { id: lectureId },
          },
        },
        isActive: true,
      },
    });

    return apiSuccess({
      quiz: {
        id: quiz.id,
        title: quiz.title,
        maxAttempts: quiz.maxAttempts,
        dueDate: quiz.dueDate,
        totalQuestions,
      },
      stats: {
        totalEnrolled: enrolledCount,
        totalSubmissions: quiz.submissions.length,
        averageScore:
          quiz.submissions.length > 0
            ? Math.round(
                (quiz.submissions.reduce((sum, sub) => sum + sub.score, 0) / quiz.submissions.length) * 10
              ) / 10
            : null,
      },
      submissions: quiz.submissions.map((sub) => ({
        studentId: sub.student.id,
        studentName: sub.student.name,
        registrationNumber: sub.student.registrationNumber,
        score: sub.score,
        totalQuestions: sub.totalQuestions,
        percentage: sub.totalQuestions > 0 ? Math.round((sub.score / sub.totalQuestions) * 100) : 0,
        attemptCount: sub.attemptCount,
        submittedAt: sub.submittedAt,
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
