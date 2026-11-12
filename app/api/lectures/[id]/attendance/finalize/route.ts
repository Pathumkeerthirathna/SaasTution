import { apiError, apiSuccess } from "@/lib/api-response";
import {
  attendanceCrossOriginRejected,
  finalizeBodySchema,
  logFinalizationIntegrityEvent,
  parseBody,
  parseLectureId,
  readJsonBody,
  requestIdOf,
  withNoStore,
} from "@/lib/attendance-http";
import { ATTENDANCE_ERRORS } from "@/lib/attendance/service-errors";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { finalizeLectureAttendance } from "@/services/lecture-attendance-finalization-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/lectures/[id]/attendance/finalize — finalizes the lecture's
 * attendance in one atomic transaction (services/lecture-attendance-
 * finalization-service.ts). Same-origin only (403), checked first; then 401
 * / 400 / 404 / 409 / 503. Body (strict): { fingerprint } from the preview.
 * 200 for a new finalization and for one already done (alreadyFinalized:
 * true, idempotent). FINALIZATION_INTEGRITY_ERROR: one structured operator
 * log line, a generic 500 to the client. Always no-store.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) return attendanceCrossOriginRejected(origin);

  let teacherId: string | null = null;
  let lectureId: string | null = null;
  try {
    ({ teacherId } = await requireTeacherSession());
    lectureId = parseLectureId(context.params?.id);
    const body = parseBody(finalizeBodySchema, await readJsonBody(request, { allowEmpty: false }));
    const result = await finalizeLectureAttendance({ teacherId, lectureId, fingerprint: body.fingerprint });
    return withNoStore(
      apiSuccess({
        lectureId: result.lectureId,
        alreadyFinalized: result.alreadyFinalized,
        finalizedAt: result.finalizedAt.toISOString(),
        registerVersion: result.registerVersion,
        eligibleStudents: result.eligibleStudents,
        unknownEligibilityStudents: result.unknownEligibilityStudents,
        absentCreated: result.absentCreated,
        details: result.details,
      })
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "FINALIZATION_INTEGRITY_ERROR" && teacherId && lectureId) {
      logFinalizationIntegrityEvent({ lectureId, teacherId, requestId: requestIdOf(request) });
      const spec = ATTENDANCE_ERRORS.FINALIZATION_INTEGRITY_ERROR;
      return withNoStore(apiError(spec.message, spec.status, "FINALIZATION_INTEGRITY_ERROR"));
    }
    return withNoStore(handleRouteError(error, { request }));
  }
}
