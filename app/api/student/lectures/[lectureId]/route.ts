import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { NORMAL_LECTURE_WHERE } from "@/lib/default-lecture";
import { prisma } from "@/lib/prisma";
import { STUDENT_VISIBLE_PRIVACY_WHERE } from "@/lib/youtube-student-privacy";
import { getClassAccessRestrictions } from "@/services/class-access-service";
import { billingMonthOf, loadStudentResourceAccess, noteBillingMonth, resourceLockFor } from "@/services/resource-access-service";

export const dynamic = "force-dynamic";

// GET /api/student/lectures/[lectureId]
// Full lecture detail for an enrolled student: notes (preview/download),
// assignments (+ this student's submission) and published recordings.
//
// Payment-based access:
//  - notes, saved whiteboards and YouTube recordings are resources, locked
//    per billing month (services/resource-access-service.ts): a locked item is
//    listed with `resourceAccess.locked` and never carries its YouTube link (the
//    note / whiteboard routes refuse it too);
//  - assignments keep the class-level overdue rule
//    (services/class-access-service.ts): while the class is restricted they
//    are not sent (assignmentsRestricted), as before.
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
        ...NORMAL_LECTURE_WHERE,
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
            uploadedAt: true,
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
                mimeType: true,
                sizeBytes: true,
                submittedAt: true,
              },
            },
          },
        },
        whiteboards: {
          where: { status: 0 },
          orderBy: { createdAt: "asc" },
          select: { id: true, title: true, createdAt: true },
        },
        youtubeRecordings: {
          // Never a YouTube-PRIVATE recording: no id, link or playback (lib/youtube-student-privacy.ts).
          where: { visibility: "PUBLIC", ...STUDENT_VISIBLE_PRIVACY_WHERE },
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

    // One batched resource-access load for every item of this lecture's class.
    const classId = lecture.class.id;
    const [access, classRestrictions] = await Promise.all([
      loadStudentResourceAccess(session.studentId, { classIds: [classId] }),
      getClassAccessRestrictions(session.studentId, [classId]),
    ]);
    const assignmentsRestricted = classRestrictions.length > 0;
    const recordings = lecture.youtubeRecordings.map((r) => ({ r, lock: resourceLockFor(access, classId, billingMonthOf(r.createdAt)) }));

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
          resourceAccess: resourceLockFor(access, classId, noteBillingMonth({ uploadedAt: n.uploadedAt, lecture: { date: lecture.date } })),
        })),
        assignmentsRestricted,
        assignments: (assignmentsRestricted ? [] : lecture.assignments).map((a) => {
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
                  mimeType: sub.mimeType,
                  sizeBytes: sub.sizeBytes,
                  submittedAt: sub.submittedAt.toISOString(),
                }
              : null,
          };
        }),
        whiteboards: lecture.whiteboards.map((w) => ({
          id: w.id,
          title: w.title,
          createdAt: w.createdAt.toISOString(),
          resourceAccess: resourceLockFor(access, classId, billingMonthOf(w.createdAt)),
        })),
        // A locked month's recording never carries its YouTube link.
        recordings: recordings.map(({ r, lock }) => ({
          id: r.id,
          videoId: lock.locked ? null : r.videoId,
          youtubeUrl: lock.locked ? null : r.youtubeUrl,
          resourceAccess: lock,
          status: r.status,
          access: r.access,
          startedAt: r.startedAt ? r.startedAt.toISOString() : null,
          endedAt: r.endedAt ? r.endedAt.toISOString() : null,
          createdAt: r.createdAt.toISOString(),
        })),
      },
    });
  } catch (error) {
    return handleRouteError(error, { request: _request });
  }
}
