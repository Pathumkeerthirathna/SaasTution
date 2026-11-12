import { apiSuccess } from "@/lib/api-response";
import {
  attendanceCrossOriginRejected,
  parseBody,
  parseLectureId,
  parseStudentId,
  readJsonBody,
  reviewBodySchema,
  reviewResponse,
  withNoStore,
} from "@/lib/attendance-http";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { acceptEvidence, dismissEvidence } from "@/services/lecture-attendance-evidence-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/lectures/[id]/attendance/students/[studentId]/review (Stage
 * 5.6a) — the signed-in teacher answers a pending evidence review for one of
 * their active students: ACCEPT (acceptEvidence: the evidence status becomes
 * the teacher's decision; a reason is always required) or DISMISS
 * (dismissEvidence: the status stays; reason optional). The services own the
 * transaction, locks (the Student row first: ownership and active status
 * hold until commit), version check, reason rule and audit. Same-origin only
 * (403), checked first; then 401 / 400 / 404 / 409.
 *
 * Body (strict): { action: "ACCEPT" | "DISMISS", expectedVersion: integer,
 * reason?: string | null }. A record that changed since is 409
 * ATTENDANCE_RECORD_CHANGED (never retried here); nothing pending is 409
 * ATTENDANCE_NO_PENDING_REVIEW. Returns an explicit field list (no record
 * id). Always no-store.
 */
export async function POST(request: Request, context: { params: { id: string; studentId: string } }) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) return attendanceCrossOriginRejected(origin);

  try {
    const { teacherId } = await requireTeacherSession();
    const lectureId = parseLectureId(context.params?.id);
    const studentId = parseStudentId(context.params?.studentId);
    const body = parseBody(reviewBodySchema, await readJsonBody(request, { allowEmpty: false }));
    const input = { teacherId, lectureId, studentId, expectedVersion: body.expectedVersion, reason: body.reason ?? null };
    const result = body.action === "ACCEPT" ? await acceptEvidence(input) : await dismissEvidence(input);
    return withNoStore(apiSuccess(reviewResponse(lectureId, body.action, result)));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
