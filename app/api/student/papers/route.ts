import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/student/papers?classId=
// Papers assigned to the logged-in student, newest first, with their own
// submission + marks.
export async function GET(request: Request) {
  try {
    const session = await requireStudentSession();
    const { searchParams } = new URL(request.url);
    const classId = searchParams.get("classId")?.trim() || undefined;

    const rows = await prisma.classPaperStudent.findMany({
      where: {
        studentId: session.studentId,
        classPaper: {
          status: 0,
          class: { status: 0 },
          ...(classId ? { classId } : {}),
        },
      },
      orderBy: { classPaper: { createdAt: "desc" } },
      select: {
        id: true,
        submitted: true,
        submittedAt: true,
        submissionFileName: true,
        marks: true,
        markedAt: true,
        classPaper: {
          select: {
            id: true,
            name: true,
            description: true,
            pdfName: true,
            pdfMimeType: true,
            maxMarks: true,
            startTime: true,
            endTime: true,
            createdAt: true,
            class: {
              select: { id: true, name: true, teacher: { select: { name: true } } },
            },
          },
        },
      },
    });

    const classesMap = new Map<string, string>();
    const papers = rows.map((r) => {
      const p = r.classPaper;
      classesMap.set(p.class.id, p.class.name);
      return {
        submissionId: r.id,
        paperId: p.id,
        name: p.name,
        description: p.description,
        pdfName: p.pdfName,
        pdfMimeType: p.pdfMimeType,
        maxMarks: p.maxMarks ? p.maxMarks.toNumber() : null,
        startTime: p.startTime.toISOString(),
        endTime: p.endTime.toISOString(),
        createdAt: p.createdAt.toISOString(),
        classId: p.class.id,
        className: p.class.name,
        teacherName: p.class.teacher.name,
        submitted: r.submitted,
        submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
        submissionFileName: r.submissionFileName,
        marks: r.marks ? r.marks.toNumber() : null,
        markedAt: r.markedAt ? r.markedAt.toISOString() : null,
      };
    });

    const classes = Array.from(classesMap, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    return apiSuccess({ papers, classes });
  } catch (error) {
    return handleRouteError(error);
  }
}
