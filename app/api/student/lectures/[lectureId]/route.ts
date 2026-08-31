import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/student/lectures/[lectureId]
// Full lecture detail for an enrolled student: notes (preview/download),
// assignments (+ this student's submission) and published recordings.
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
        status: 0,
        class: {
          status: 0,
          students: {
            some: { studentId: session.studentId, isActive: true },
          },
        },
      },
      select: {
        id: true,
        title: true,
        date: true,
        class: { select: { id: true, name: true } },
        notes: {
          where: { status: 0 },
          orderBy: [{ kind: "asc" }, { title: "asc" }],
          select: {
            id: true,
            title: true,
            kind: true,
            mimeType: true,
            sizeBytes: true,
          },
        },
        assignments: {
          where: { status: 0 },
          orderBy: { dueDate: "asc" },
          select: {
            id: true,
            title: true,
            description: true,
            dueDate: true,
            submissions: {
              where: { studentId: session.studentId },
              take: 1,
              select: {
                id: true,
                notes: true,
                fileName: true,
                fileUrl: true,
                mimeType: true,
                sizeBytes: true,
                submittedAt: true,
              },
            },
          },
        },
        youtubeRecordings: {
          where: { visibility: "PUBLIC" },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            videoId: true,
            youtubeUrl: true,
            status: true,
            access: true,
            startedAt: true,
            endedAt: true,
            createdAt: true,
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
        assignments: lecture.assignments.map((a) => {
          const sub = a.submissions[0] ?? null;
          return {
            id: a.id,
            title: a.title,
            description: a.description,
            dueDate: a.dueDate.toISOString(),
            submission: sub
              ? {
                  id: sub.id,
                  notes: sub.notes,
                  fileName: sub.fileName,
                  fileUrl: sub.fileUrl,
                  mimeType: sub.mimeType,
                  sizeBytes: sub.sizeBytes,
                  submittedAt: sub.submittedAt.toISOString(),
                }
              : null,
          };
        }),
        recordings: lecture.youtubeRecordings.map((r) => ({
          id: r.id,
          videoId: r.videoId,
          youtubeUrl: r.youtubeUrl,
          status: r.status,
          access: r.access,
          startedAt: r.startedAt ? r.startedAt.toISOString() : null,
          endedAt: r.endedAt ? r.endedAt.toISOString() : null,
          createdAt: r.createdAt.toISOString(),
        })),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
