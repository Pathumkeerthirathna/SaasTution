import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { POST as uploadLectureNote } from "@/app/api/lectures/[id]/notes/route";
import { listClassNotesForTeacher, parseNotesLectureParam, resolveDefaultLectureForTeacher } from "@/services/class-notes-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function classIdOf(context: { params: { id: string } }): string {
  const classId = context.params.id?.trim();
  if (!classId) throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
  return classId;
}

/**
 * GET /api/classes/[id]/notes[?lectureId=]
 *
 * Teacher, own active class only (404 CLASS_NOT_FOUND otherwise). Without
 * lectureId: the class's General Notes (its default lecture; 409
 * DEFAULT_LECTURE_MISSING when the class has none). With lectureId: that
 * NORMAL lecture's notes; another class's lecture, a default lecture or a
 * removed one is 404 LECTURE_NOT_FOUND. Newest upload first
 * (services/class-notes-service.ts).
 *
 * 200 { class: { id, name }, section: "GENERAL" | "LECTURE",
 *       lecture: { id, title, date, isDefault },
 *       notes: [{ id, lectureId, title, kind, mimeType, sizeBytes, downloadCount,
 *                 lastDownloadedAt, visibility, access, uploadedAt }] }
 * Files: the existing GET /api/lectures/notes/[noteId]/preview | download.
 * Edit / delete: the existing PUT / DELETE /api/lectures/[lectureId]/notes/[noteId].
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const session = await requireTeacherSession();
    const classId = classIdOf(context);
    const lectureId = parseNotesLectureParam(new URL(request.url).searchParams.get("lectureId"));
    return apiSuccess(await listClassNotesForTeacher(session.teacherId, classId, { lectureId }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

/**
 * POST /api/classes/[id]/notes — upload a General Note (multipart: title,
 * kind, file; any lecture id sent by the client is ignored).
 *
 * Same-origin first (403), then the teacher session (401), then the class's
 * default lecture, resolved on the server from the class (404
 * CLASS_NOT_FOUND, 409 DEFAULT_LECTURE_MISSING). The upload itself is the
 * existing pipeline, unchanged: POST /api/lectures/[id]/notes with that
 * lecture (validation, ownership, storage quota reservation, stored file,
 * Note row with uploadedAt, NoteStudent rows, cleanup on failure) and its
 * response: 201 { note }.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) {
    return apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  }

  try {
    const session = await requireTeacherSession();
    const { lecture } = await resolveDefaultLectureForTeacher(session.teacherId, classIdOf(context));
    // The body is still unread: the existing upload route reads it.
    return await uploadLectureNote(request, { params: { id: lecture.id } });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
