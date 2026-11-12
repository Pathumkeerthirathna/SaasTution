import { apiSuccess } from "@/lib/api-response";
import { parseLectureId, withNoStore } from "@/lib/attendance-http";
import { toAttendanceRegisterResponse } from "@/lib/attendance-register-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { getRegister } from "@/services/lecture-attendance-service";
import { getRegisterQrState } from "@/services/lecture-attendance-qr-state";

export const dynamic = "force-dynamic";

/**
 * GET /api/lectures/[id]/attendance — the attendance register of one of the
 * signed-in teacher's lectures, as the explicit teacher-facing contract
 * (lib/attendance-register-response.ts). Read only (never creates a
 * register). 401 without a teacher session; 400 for a blank or over-long id;
 * 404 for a missing, deleted or another teacher's lecture. Fields that need
 * the attendance settings are null while they are unavailable (never 503).
 * `qr` (Stage 5.7b-3b) is read after getRegister authorized the lecture: the
 * persisted closure and the scan window (services/lecture-attendance-qr-
 * state.ts); a missing setting shows the window CLOSED, never a 503.
 * Always no-store.
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const { teacherId } = await requireTeacherSession();
    const lectureId = parseLectureId(context.params?.id);
    const view = await getRegister(teacherId, lectureId);
    const qr = await getRegisterQrState(view);
    return withNoStore(apiSuccess(toAttendanceRegisterResponse(view, qr)));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
