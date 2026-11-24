import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { loadStudentResourceAccess, noteBillingMonth, resourceLockFor } from "@/services/resource-access-service";

export const dynamic = "force-dynamic";

// GET /api/student/lectures/[lectureId]/notes
// Returns lecture details + all notes for a lecture the student is enrolled in.
// Each note carries `access` (services/resource-access-service.ts): a note of
// a locked billing month is listed locked and its file route refuses it.
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
          where: { status: 0 },
          orderBy: [{ kind: "asc" }, { title: "asc" }],
          select: {
            id: true,
            title: true,
            kind: true,
            mimeType: true,
            sizeBytes: true,
            uploadedAt: true,
          },
        },
      },
    });

    if (!lecture) {
      throw new AppError("Lecture not found.", 404, "LECTURE_NOT_FOUND");
    }

    const access = await loadStudentResourceAccess(session.studentId, { classIds: [lecture.class.id] });

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
          resourceAccess: resourceLockFor(access, lecture.class.id, noteBillingMonth({ uploadedAt: n.uploadedAt, lecture: { date: lecture.date } })),
        })),
      },
    });
  } catch (error) {
    return handleRouteError(error, { request: _request });
  }
}
