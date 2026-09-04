import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/student/dashboard/notes
// Lecture notes (kind = NOTE) from the student's active classes that they have
// not viewed yet. A note counts as unviewed when there is no NoteStudent row or
// its `viewed` flag is false. Tutes, papers and material-bundle items are not
// included here.
export async function GET() {
  try {
    const session = await requireStudentSession();
    const studentId = session.studentId;

    const rows = await prisma.note.findMany({
      where: {
        status: 0,
        kind: "NOTE",
        lecture: {
          status: 0,
          class: {
            status: 0,
            students: { some: { studentId, isActive: true } },
          },
        },
        noteStudents: { none: { studentId, viewed: true } },
      },
      orderBy: { lecture: { date: "desc" } },
      take: 20,
      select: {
        id: true,
        title: true,
        mimeType: true,
        sizeBytes: true,
        lecture: {
          select: {
            id: true,
            title: true,
            date: true,
            class: { select: { name: true } },
          },
        },
      },
    });

    const notes = rows.map((n) => ({
      id: n.id,
      title: n.title,
      mimeType: n.mimeType,
      sizeBytes: n.sizeBytes,
      lectureId: n.lecture.id,
      lectureTitle: n.lecture.title,
      className: n.lecture.class.name,
      date: n.lecture.date.toISOString(),
    }));

    return apiSuccess({ notes });
  } catch (error) {
    return handleRouteError(error);
  }
}
