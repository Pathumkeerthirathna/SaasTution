import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/student/dashboard/performance
// Overall attendance rate and overall quiz score for the logged-in student,
// both as whole-number percentages across every active enrolled class.
export async function GET() {
  try {
    const session = await requireStudentSession();
    const studentId = session.studentId;

    const enrolled = {
      status: 0,
      class: { status: 0, students: { some: { studentId, isActive: true } } },
    } as const;

    const [lectures, submissions] = await Promise.all([
      prisma.lecture.findMany({
        where: enrolled,
        select: {
          id: true,
          sessions: {
            select: {
              attendance: { where: { studentId }, select: { id: true }, take: 1 },
            },
          },
        },
      }),
      prisma.quizSubmission.findMany({
        where: {
          studentId,
          quiz: {
            status: 0,
            lecture: {
              status: 0,
              class: { status: 0, students: { some: { studentId, isActive: true } } },
            },
          },
        },
        select: { score: true, totalQuestions: true },
      }),
    ]);

    const totalLectures = lectures.length;
    const attendedLectures = lectures.filter((l) =>
      l.sessions.some((s) => s.attendance.length > 0)
    ).length;
    const attendancePercent =
      totalLectures === 0 ? 0 : Math.round((attendedLectures / totalLectures) * 100);

    const quizzesAttempted = submissions.length;
    const quizPercent =
      quizzesAttempted === 0
        ? 0
        : Math.round(
            submissions.reduce(
              (sum, s) => sum + (s.totalQuestions > 0 ? (s.score / s.totalQuestions) * 100 : 0),
              0
            ) / quizzesAttempted
          );

    return apiSuccess({
      attendance: {
        percent: attendancePercent,
        attended: attendedLectures,
        total: totalLectures,
      },
      quiz: {
        percent: quizPercent,
        attempted: quizzesAttempted,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
