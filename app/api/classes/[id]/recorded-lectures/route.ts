import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError } from "@/lib/error-handler";
import { uploadErrorResponse } from "@/lib/recorded-lectures/upload-errors";
import { listClassRecordingsForTeacher } from "@/services/class-recordings-service";
import { parseNotesLectureParam } from "@/services/class-notes-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/classes/[id]/recorded-lectures[?lectureId=]
 *
 * Teacher, own active class only (404 CLASS_NOT_FOUND otherwise). Without
 * lectureId: the class's General Recordings (its default lecture, resolved on
 * the server; 409 DEFAULT_LECTURE_MISSING when the class has none). With
 * lectureId: that NORMAL lecture's recordings; another class's lecture, a
 * default lecture or a removed one is 404 LECTURE_NOT_FOUND
 * (services/class-recordings-service.ts).
 *
 * 200 { class: { id, name }, section: "GENERAL" | "LECTURE",
 *       lecture: { id, title, date, isDefault },
 *       recordings, nextPartNumber, limits }   (recordings, nextPartNumber and
 * limits exactly as GET /api/lectures/[id]/recorded-lectures).
 * Edit / delete / preview / publication: the existing
 * /api/recorded-lectures/[recordingId] routes.
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const session = await requireTeacherSession();
    const classId = context.params.id?.trim();
    if (!classId) throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
    const lectureId = parseNotesLectureParam(new URL(request.url).searchParams.get("lectureId"));
    return apiSuccess(await listClassRecordingsForTeacher(session.teacherId, classId, { lectureId }));
  } catch (error) {
    return uploadErrorResponse(error, request);
  }
}
