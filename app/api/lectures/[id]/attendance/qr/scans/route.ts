import { apiSuccess } from "@/lib/api-response";
import {
  attendanceCrossOriginRejected,
  parseBody,
  parseLectureId,
  QR_SCAN_MAX_BODY_BYTES,
  qrScanBodySchema,
  qrScanResponse,
  readJsonBodyWithLimit,
  withNoStore,
} from "@/lib/attendance-http";
import { qrScanRateLimiter } from "@/lib/attendance/qr-scan-rate-limit";
import { attendanceError } from "@/lib/attendance/service-errors";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { recordQrScan } from "@/services/lecture-attendance-qr-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/lectures/[id]/attendance/qr/scans (Stage 5.7b-3b) — the signed-in
 * teacher submits one scanned student QR for one of their lectures, through
 * recordQrScan (its checks, transaction, locks, window, eligibility, evidence
 * and scan event). Same-origin only (403), checked first; then 401 / 400 /
 * 429 / 404 / 409 / 503.
 *
 * Body (strict): { clientScanId: [A-Za-z0-9_-]{16,64} (the retry key: the
 * same id is the same scan, answered with `replayed: true`), payload: string
 * ≤ 128 }, at most QR_SCAN_MAX_BODY_BYTES (1 KiB; larger: 413
 * ATTENDANCE_REQUEST_TOO_LARGE, never buffered: readJsonBodyWithLimit). The payload is a bearer credential: it is never logged, stored by
 * this route, or echoed (a refusal names only the field). Rate limits per
 * teacher (lib/attendance/qr-scan-rate-limit.ts; 429
 * ATTENDANCE_SCAN_RATE_LIMITED + Retry-After): new clientScanIds 120 / 60 s
 * (2,000 / 60 s server-wide); repeats of a remembered clientScanId 600 / 60 s,
 * a separate budget (Stage 5.7b-3c-1). A repeat still reaches the service,
 * which alone decides replay vs 409 ATTENDANCE_SCAN_ID_REUSED. The teacher
 * comes only from the session. Explicit field list (no
 * scan event, token or record ids, no hashes). Always no-store.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) return attendanceCrossOriginRejected(origin);

  let retryAfterSeconds: number | null = null;
  try {
    const { teacherId } = await requireTeacherSession();
    const lectureId = parseLectureId(context.params?.id);
    const body = parseBody(qrScanBodySchema, await readJsonBodyWithLimit(request, { maxBytes: QR_SCAN_MAX_BODY_BYTES, allowEmpty: false }));

    const rate = qrScanRateLimiter.check(teacherId, body.clientScanId);
    if (!rate.allowed) {
      retryAfterSeconds = rate.retryAfterSeconds;
      throw attendanceError("ATTENDANCE_SCAN_RATE_LIMITED");
    }

    const outcome = await recordQrScan({ teacherId, lectureId, clientScanId: body.clientScanId, payload: body.payload });
    return withNoStore(apiSuccess(qrScanResponse(outcome)));
  } catch (error) {
    const response = withNoStore(handleRouteError(error, { request }));
    if (retryAfterSeconds !== null) response.headers.set("Retry-After", String(retryAfterSeconds));
    return response;
  }
}
