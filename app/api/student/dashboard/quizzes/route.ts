import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/student/dashboard/quizzes?from=YYYY-MM-DD&to=YYYY-MM-DD
// Quizzes for the student's classes whose start time falls in the window.
export async function GET(request: Request) {
  try {
    const session = await requireStudentSession();
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from")?.trim() ?? "";
    const to = searchParams.get("to")?.trim() ?? "";

    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      throw new AppError("`from` and `to` must be YYYY-MM-DD dates.", 400, "VALIDATION_ERROR");
    }

    const fromDate = new Date(`${from}T00:00:00.000`);
    const toDate = new Date(`${to}T23:59:59.999`);

    const rows = await prisma.quiz.findMany({
      where: {
        status: 0,
        startDateTime: { gte: fromDate, lte: toDate },
        lecture: {
          status: 0,
          class: { status: 0, students: { some: { studentId: session.studentId, isActive: true } } },
        },
      },
      orderBy: { startDateTime: "asc" },
      select: {
        id: true,
        title: true,
        startDateTime: true,
        endDateTime: true,
        lectureId: true,
        lecture: { select: { class: { select: { id: true, name: true } } } },
        submissions: {
          where: { studentId: session.studentId },
          select: { id: true },
          take: 1,
        },
      },
    });

    const quizzes = rows.map((q) => ({
      id: q.id,
      title: q.title,
      startDateTime: q.startDateTime.toISOString(),
      endDateTime: q.endDateTime.toISOString(),
      lectureId: q.lectureId,
      classId: q.lecture.class.id,
      className: q.lecture.class.name,
      attempted: q.submissions.length > 0,
    }));

    return apiSuccess({ quizzes });
  } catch (error) {
    return handleRouteError(error);
  }
}
