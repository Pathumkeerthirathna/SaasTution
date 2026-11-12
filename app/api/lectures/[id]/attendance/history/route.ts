import { apiSuccess } from "@/lib/api-response";
import { parseHistoryQuery, parseLectureId, registerHistoryResponse, withNoStore } from "@/lib/attendance-http";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { getRegisterHistory } from "@/services/lecture-attendance-history-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/lectures/[id]/attendance/history (Stage 5.6b) — the register's
 * immutable audit history (created, grace changed, schedule synced,
 * finalized) and the QR closure, for one of the signed-in teacher's lectures,
 * through getRegisterHistory (read only: no transaction, lock or write).
 *
 * Query: `cursor` (the previous page's nextCursor), `limit` (1–100, default
 * 50), each at most once; anything else is ignored. Oldest first, keyset
 * paged by the audit version; `nextCursor` is null on the last page.
 * 401 / 400 (field lectureId, cursor or limit) / 404 LECTURE_NOT_FOUND
 * (another teacher's, deleted or unknown lecture). No register yet:
 * registerExists false, no entries. Explicit field list (no row ids; actors
 * as SYSTEM or TEACHER with isCurrentTeacher). Always no-store.
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const { teacherId } = await requireTeacherSession();
    const lectureId = parseLectureId(context.params?.id);
    const { cursor, limit } = parseHistoryQuery(request.url);
    const page = await getRegisterHistory(teacherId, lectureId, { cursor, limit });
    return withNoStore(apiSuccess(registerHistoryResponse(page, teacherId)));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
