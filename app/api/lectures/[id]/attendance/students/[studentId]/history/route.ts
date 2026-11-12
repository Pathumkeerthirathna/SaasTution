import { apiSuccess } from "@/lib/api-response";
import { parseHistoryQuery, parseLectureId, parseStudentId, studentHistoryResponse, withNoStore } from "@/lib/attendance-http";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { getStudentAttendanceHistory } from "@/services/lecture-attendance-history-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/lectures/[id]/attendance/students/[studentId]/history (Stage
 * 5.6b) — one student's immutable attendance-record audit history for one of
 * the signed-in teacher's lectures, through getStudentAttendanceHistory
 * (read only: no transaction, lock or write).
 *
 * Authorization (the service): the lecture must be the teacher's (404
 * LECTURE_NOT_FOUND otherwise), and the student must be the teacher's (404
 * STUDENT_NOT_FOUND otherwise, the same as an unknown id). An inactive or
 * deleted student of the teacher stays readable: history is read only, so
 * Stage 5.6a's active-student rule for actions does not apply.
 *
 * Query: `cursor`, `limit` (1–100, default 50), each at most once; oldest
 * first, keyset paged by the record's audit version. No record: recordExists
 * false, no entries. Explicit field list (no row ids; actors as SYSTEM or
 * TEACHER with isCurrentTeacher). Always no-store.
 */
export async function GET(request: Request, context: { params: { id: string; studentId: string } }) {
  try {
    const { teacherId } = await requireTeacherSession();
    const lectureId = parseLectureId(context.params?.id);
    const studentId = parseStudentId(context.params?.studentId);
    const { cursor, limit } = parseHistoryQuery(request.url);
    const page = await getStudentAttendanceHistory(teacherId, lectureId, studentId, { cursor, limit });
    return withNoStore(apiSuccess(studentHistoryResponse(page, teacherId)));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
