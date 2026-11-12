import { apiSuccess } from "@/lib/api-response";
import {
  attendanceCrossOriginRejected,
  decisionBodySchema,
  decisionResponse,
  parseBody,
  parseLectureId,
  parseStudentId,
  readJsonBody,
  withNoStore,
} from "@/lib/attendance-http";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { setTeacherAttendanceStatus } from "@/services/lecture-attendance-decision-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/lectures/[id]/attendance/students/[studentId]/decision (Stage
 * 5.6a) — the signed-in teacher marks one of their active students PRESENT,
 * LATE, ABSENT or EXCUSED for one of their lectures, through
 * setTeacherAttendanceStatus (its transaction, locks, version check, reason
 * rule and audit, unchanged). Same-origin only (403), checked first; then
 * 401 / 400 / 404 / 409.
 *
 * Body (strict): { status, expectedVersion: integer | null, reason?: string |
 * null }. expectedVersion is the record version the teacher saw (null: no
 * record); a record that changed since is 409 ATTENDANCE_RECORD_CHANGED,
 * never retried here. Reasons follow the service and database rules (none
 * for a first mark on an open register; required otherwise: 400
 * ATTENDANCE_REASON_REQUIRED). The teacher comes only from the session.
 * Returns an explicit field list (no record id). Always no-store.
 */
export async function POST(request: Request, context: { params: { id: string; studentId: string } }) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) return attendanceCrossOriginRejected(origin);

  try {
    const { teacherId } = await requireTeacherSession();
    const lectureId = parseLectureId(context.params?.id);
    const studentId = parseStudentId(context.params?.studentId);
    const body = parseBody(decisionBodySchema, await readJsonBody(request, { allowEmpty: false }));
    const result = await setTeacherAttendanceStatus({
      teacherId,
      lectureId,
      studentId,
      status: body.status,
      expectedVersion: body.expectedVersion,
      reason: body.reason ?? null,
    });
    return withNoStore(apiSuccess(decisionResponse(result)));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
