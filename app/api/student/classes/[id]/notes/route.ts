import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { listClassNotesForStudent, parseNotesLectureParam } from "@/services/class-notes-service";
import { loadStudentResourceAccess, noteBillingMonth, resourceLockFor } from "@/services/resource-access-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/student/classes/[id]/notes[?lectureId=]
 *
 * Student, an ACTIVE class they are ACTIVELY enrolled in (404
 * CLASS_NOT_FOUND otherwise, nothing revealed). Without lectureId: the
 * class's General Notes (its default lecture; 409 DEFAULT_LECTURE_MISSING
 * when the class has none). With lectureId: that NORMAL lecture of this class;
 * another class's lecture, a default lecture or a removed one is 404
 * LECTURE_NOT_FOUND. Newest upload first (services/class-notes-service.ts).
 *
 * Every note carries `resourceAccess` (services/resource-access-service.ts):
 * its billing month (upload instant, else its lecture's date) locked or not,
 * General Notes included. `fileUrl` is the existing file route
 * (/api/student/lectures/[lectureId]/notes/[noteId]/file, which makes the
 * monthly check itself: assertResourceAccessForStudent); null when locked.
 *
 * 200 { class: { id, name }, section: "GENERAL" | "LECTURE",
 *       lecture: { id, title, date, isDefault },
 *       notes: [{ id, lectureId, title, kind, mimeType, sizeBytes, uploadedAt,
 *                 resourceAccess: { locked, year, month }, fileUrl }] }
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const session = await requireStudentSession();
    const classId = context.params.id?.trim();
    if (!classId) throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
    const lectureId = parseNotesLectureParam(new URL(request.url).searchParams.get("lectureId"));

    const result = await listClassNotesForStudent(session.studentId, classId, { lectureId });
    const access = await loadStudentResourceAccess(session.studentId, { classIds: [result.class.id] });

    return apiSuccess({
      ...result,
      notes: result.notes.map((note) => {
        const resourceAccess = resourceLockFor(access, result.class.id, noteBillingMonth({ ...note, lecture: { date: result.lecture.date } }));
        return {
          ...note,
          resourceAccess,
          fileUrl: resourceAccess.locked ? null : `/api/student/lectures/${note.lectureId}/notes/${note.id}/file`,
        };
      }),
    });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
