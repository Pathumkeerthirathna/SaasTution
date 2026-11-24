import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { assertClassAccessForStudent } from "@/services/class-access-service";
import { parseNotesLectureParam } from "@/services/class-notes-service";
import { listStudentClassYouTubeLives } from "@/services/student-class-youtube-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/student/classes/[id]/youtube-lives[?lectureId=&page=&pageSize=]
 *
 * Student, read-only: the YouTube live broadcasts of a class the student is
 * actively enrolled in (404 CLASS_NOT_FOUND otherwise), across the class or
 * for one of its normal lectures (404 LECTURE_NOT_FOUND). A payment-restricted
 * class is 403 CLASS_ACCESS_RESTRICTED (the dashboard's live feed never hands
 * out its watch link either). Only broadcasts that went live (live now, or
 * finished: the replay) and that are PUBLIC or UNLISTED on YouTube; never a
 * PRIVATE one (services/student-class-youtube-service.ts).
 *
 * 200 { class: { id, name }, lecture: { id, title, date } | null,
 *       broadcasts: [{ id, videoId, youtubeUrl, isLive, startedAt, endedAt, createdAt,
 *                      lecture: { id, title, date } }],
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

    // Payment-due access control (services/class-access-service.ts): no watch links for a restricted class.
    await assertClassAccessForStudent(session.studentId, classId);
    const listing = await listStudentClassYouTubeLives({ studentId: session.studentId, classId, lectureId, skip, take });

    return apiSuccess({
      class: listing.class,
      lecture: listing.lecture,
      broadcasts: listing.broadcasts,
      pagination: buildPaginationMeta(listing.total, page, pageSize),
    });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
