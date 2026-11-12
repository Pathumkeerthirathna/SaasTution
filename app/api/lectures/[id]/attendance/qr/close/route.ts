import { apiSuccess } from "@/lib/api-response";
import {
  attendanceCrossOriginRejected,
  parseBody,
  parseLectureId,
  QR_CLOSE_MAX_BODY_BYTES,
  qrCloseBodySchema,
  qrCloseResponse,
  readJsonBodyWithLimit,
  withNoStore,
} from "@/lib/attendance-http";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { closeQrAttendance } from "@/services/lecture-attendance-qr-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/lectures/[id]/attendance/qr/close (Stage 5.7b-3b) — the signed-in
 * teacher closes QR attendance for one of their lectures, permanently,
 * through closeQrAttendance (its transaction, register FOR UPDATE and the
 * immutable closure row). Same-origin only (403), checked first; then 401 /
 * 400 / 413 / 404 / 409. Body: exactly {} (strict), at most
 * QR_CLOSE_MAX_BODY_BYTES (16; larger: 413 ATTENDANCE_REQUEST_TOO_LARGE). Idempotent: a repeat answers
 * the stored closure with `alreadyClosed: true` and writes nothing. Allowed
 * before or after finalization; no attendance setting is needed (no 503).
 * The teacher comes only from the session; the closing teacher's id is never
 * returned (`closedByYou` instead). Always no-store.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) return attendanceCrossOriginRejected(origin);

  try {
    const { teacherId } = await requireTeacherSession();
    const lectureId = parseLectureId(context.params?.id);
    parseBody(qrCloseBodySchema, await readJsonBodyWithLimit(request, { maxBytes: QR_CLOSE_MAX_BODY_BYTES, allowEmpty: false }));
    const result = await closeQrAttendance({ teacherId, lectureId });
    return withNoStore(apiSuccess(qrCloseResponse(result, teacherId)));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
