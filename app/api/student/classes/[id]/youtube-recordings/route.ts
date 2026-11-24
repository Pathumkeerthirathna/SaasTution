import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { parseNotesLectureParam } from "@/services/class-notes-service";
import { billingMonthOf, loadStudentResourceAccess, resourceLockFor } from "@/services/resource-access-service";
import { listStudentClassYouTubeRecordings } from "@/services/student-class-youtube-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/student/classes/[id]/youtube-recordings[?lectureId=&page=&pageSize=]
 *
 * Student, read-only: the YouTube classroom recordings of a class the student
 * is actively enrolled in (404 CLASS_NOT_FOUND otherwise), across the class or
 * for one of its normal lectures (404 LECTURE_NOT_FOUND for another class's,
 * a default or a removed lecture). The same student rules as the lecture
 * detail route (GET /api/student/lectures/[id]): the teacher's visibility
 * PUBLIC only, and each recording carries its monthly resource lock; a locked
 * month's recording never carries its YouTube link. YouTube-PRIVATE videos are
 * never listed (services/student-class-youtube-service.ts).
 *
 * 200 { class: { id, name }, lecture: { id, title, date } | null,
 *       recordings: [{ id, videoId, youtubeUrl, resourceAccess, status, access,
 *                      startedAt, endedAt, createdAt, lecture: { id, title, date } }],
 *       pagination }
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const session = await requireStudentSession();
    const classId = context.params.id?.trim();
    if (!classId) throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
    const searchParams = new URL(request.url).searchParams;
    const lectureId = parseNotesLectureParam(searchParams.get("lectureId"));
    const { page, pageSize, skip, take } = parsePaginationParams(searchParams);

    const listing = await listStudentClassYouTubeRecordings({ studentId: session.studentId, classId, lectureId, skip, take });
    const access = await loadStudentResourceAccess(session.studentId, { classIds: [listing.class.id] });

    return apiSuccess({
      class: listing.class,
      lecture: listing.lecture,
      // A locked month's recording never carries its YouTube link (as on the lecture page).
      recordings: listing.rows.map((r) => {
        const lock = resourceLockFor(access, listing.class.id, billingMonthOf(r.createdAt));
        return {
          id: r.id,
          videoId: lock.locked ? null : r.videoId,
          youtubeUrl: lock.locked ? null : r.youtubeUrl,
          resourceAccess: lock,
          status: r.status,
          access: r.access,
          startedAt: r.startedAt ? r.startedAt.toISOString() : null,
          endedAt: r.endedAt ? r.endedAt.toISOString() : null,
          createdAt: r.createdAt.toISOString(),
          lecture: { id: r.lecture.id, title: r.lecture.title, date: r.lecture.date.toISOString() },
        };
      }),
      pagination: buildPaginationMeta(listing.total, page, pageSize),
    });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
