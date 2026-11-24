import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { courseworkLectureView } from "@/lib/coursework-lecture";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const studentSession = await requireStudentSession();

    const quizzes = await prisma.quiz.findMany({
      where: {
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
      orderBy: [{ endDateTime: "desc" }, { title: "asc" }],
      select: {
        id: true,
        title: true,
        maxAttempts: true,
        startDateTime: true,
        endDateTime: true,
        lecture: {
          select: {
            id: true,
            title: true,
            date: true,
            isDefault: true,
            class: {
              select: {
                name: true,
              },
            },
          },
        },
        questions: {
          select: {
            id: true,
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
          },
          take: 1,
        },
      },
    });

    return apiSuccess(
      quizzes.map((quiz) => ({
        id: quiz.id,
        title: quiz.title,
        className: quiz.lecture.class.name,
        // General Quizzes: isGeneral, the General label, no lecture date (lib/coursework-lecture.ts).
        ...courseworkLectureView("quiz", quiz.lecture),
        totalQuestions: quiz.questions.length,
        maxAttempts: quiz.maxAttempts,
        startDateTime: quiz.startDateTime,
        endDateTime: quiz.endDateTime,
        submission: quiz.submissions[0] ?? null,
      }))
    );
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
