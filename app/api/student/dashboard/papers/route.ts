import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/student/dashboard/papers?from=YYYY-MM-DD&to=YYYY-MM-DD
// ClassPapers assigned to the student whose start time falls in the window.
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

    const rows = await prisma.classPaperStudent.findMany({
      where: {
        studentId: session.studentId,
        classPaper: {
          status: 0,
          class: { status: 0 },
          startTime: { gte: fromDate, lte: toDate },
        },
      },
      orderBy: { classPaper: { startTime: "asc" } },
      select: {
        submitted: true,
        submittedAt: true,
        marks: true,
        classPaper: {
          select: {
            id: true,
            name: true,
            startTime: true,
            endTime: true,
            class: { select: { id: true, name: true } },
          },
        },
      },
    });

    const papers = rows.map((r) => ({
      paperId: r.classPaper.id,
      name: r.classPaper.name,
      startTime: r.classPaper.startTime.toISOString(),
      endTime: r.classPaper.endTime.toISOString(),
      classId: r.classPaper.class.id,
      className: r.classPaper.class.name,
      submitted: r.submitted,
      marks: r.marks ? r.marks.toNumber() : null,
    }));

    return apiSuccess({ papers });
  } catch (error) {
    return handleRouteError(error);
  }
}
