import { apiSuccess } from "@/lib/api-response";
import { parseLectureId, withNoStore } from "@/lib/attendance-http";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { getLectureAttendanceFinalizationPreview } from "@/services/lecture-attendance-finalization-preview-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/lectures/[id]/attendance/finalization — the read-only
 * finalization preview (counts, schedule, readiness, blockers and the
 * fingerprint to send to /finalize), unchanged from the service: no student
 * identities. 401 / 400 / 404; 503 with { setting, status } when an
 * attendance setting is missing or invalid. Always no-store.
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const { teacherId } = await requireTeacherSession();
    const lectureId = parseLectureId(context.params?.id);
    const preview = await getLectureAttendanceFinalizationPreview({ teacherId, lectureId });
    return withNoStore(apiSuccess(preview));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
