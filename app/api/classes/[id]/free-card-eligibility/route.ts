import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import {
  describeFreeCardEligibilityResult,
  parseFreeCardEligibilityRequest,
  setClassFreeCardEligibility,
} from "@/services/class-free-card-eligibility-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/classes/[id]/free-card-eligibility: the class's teacher marks
 * active enrolments of this class as Free Card students (or not).
 * Body: { classStudentIds: string[], eligible: boolean, applyToCurrentMonth?: boolean }.
 * All or nothing: 404 ENROLMENT_NOT_FOUND / 409 ENROLMENT_NOT_ACTIVE (with the
 * offending ids in details) change nothing. With applyToCurrentMonth (enable
 * only), existing current-month fees get Free Cards after the change is saved;
 * that step's outcome is in data.apply (APPLIED or FAILED); a failure there
 * never reverts the saved eligibility. Disabling revokes no Free Card.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  try {
    const session = await requireTeacherSession();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError("Invalid request body.", 400, "VALIDATION_ERROR");
    }
    const input = parseFreeCardEligibilityRequest(body);
    const result = await setClassFreeCardEligibility({
      teacherId: session.teacherId,
      classId: context.params.id,
      request: input,
    });
    return apiSuccess(result, { message: describeFreeCardEligibilityResult(result) });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
