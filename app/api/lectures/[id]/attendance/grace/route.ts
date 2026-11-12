import { apiSuccess } from "@/lib/api-response";
import {
  attendanceCrossOriginRejected,
  graceBodySchema,
  graceResponse,
  parseBody,
  parseLectureId,
  readJsonBody,
  withNoStore,
} from "@/lib/attendance-http";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { setRegisterGraceMinutes } from "@/services/lecture-attendance-grace-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/lectures/[id]/attendance/grace (Stage 5.7b-2b-2) — the signed-in
 * teacher changes the grace period stored in one of their lecture's
 * attendance register, through setRegisterGraceMinutes (its transaction,
 * locks, version check, reason rule, audit and recalculation). Same-origin
 * only (403), checked first; then 401 / 400 / 404 / 409.
 *
 * Body (strict): { graceMinutes: 0–240, expectedVersion: integer ≥ 0 (the
 * register version the teacher saw; 0 = no register yet), reason?: string |
 * null }. A register that changed since is 409 ATTENDANCE_REGISTER_CHANGED
 * (never retried here); a finalized register is 409
 * ATTENDANCE_REGISTER_FINALIZED; a cancelled lecture 409 LECTURE_CANCELLED;
 * a missing reason when existing records are recalculated 400
 * ATTENDANCE_REASON_REQUIRED. No attendance setting is needed (no 503). The
 * teacher comes only from the session. Explicit field list. Always no-store.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) return attendanceCrossOriginRejected(origin);

  try {
    const { teacherId } = await requireTeacherSession();
    const lectureId = parseLectureId(context.params?.id);
    const body = parseBody(graceBodySchema, await readJsonBody(request, { allowEmpty: false }));
    const result = await setRegisterGraceMinutes({
      teacherId,
      lectureId,
      graceMinutes: body.graceMinutes,
      expectedVersion: body.expectedVersion,
      reason: body.reason ?? null,
    });
    return withNoStore(apiSuccess(graceResponse(result)));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
