import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/student/lectures/[lectureId]/notes
// Returns lecture details + all notes for a lecture the student is enrolled in.
export async function GET(
  _request: Request,
  context: { params: { lectureId: string } }
) {
  try {
    const session = await requireStudentSession();
    const { lectureId } = context.params;

    if (!lectureId?.trim()) {
      throw new AppError("Lecture id is required.", 400, "VALIDATION_ERROR");
    }

    const lecture = await prisma.lecture.findFirst({
      where: {
        id: lectureId,
        class: {
          students: {
            some: {
              studentId: session.studentId,
              isActive: true,
            },
          },
        },
      },
      select: {
        id: true,
        title: true,
        date: true,
        class: {
          select: { id: true, name: true },
        },
        notes: {
          orderBy: [{ kind: "asc" }, { title: "asc" }],
          select: {
            id: true,
            title: true,
            kind: true,
            mimeType: true,
            sizeBytes: true,
          },
        },
      },
    });

    if (!lecture) {
      throw new AppError("Lecture not found.", 404, "LECTURE_NOT_FOUND");
    }

    return apiSuccess({
      lecture: {
        id: lecture.id,
        title: lecture.title,
        date: lecture.date,
        className: lecture.class.name,
        classId: lecture.class.id,
        notes: lecture.notes.map((n) => ({
          id: n.id,
          title: n.title,
          kind: n.kind,
          mimeType: n.mimeType,
          sizeBytes: n.sizeBytes,
        })),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
