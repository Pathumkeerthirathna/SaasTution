import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSessionForbiddingOtherRoles } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import {
  getResourceAccessForTeacher,
  parseResourceAccessChoice,
  parseResourceAccessMonth,
  setResourceAccessOverride,
} from "@/services/resource-access-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * One student's resource access for one billing month of the teacher's class
 * (Payments page, "Resource access"; services/resource-access-service.ts).
 *   GET ?studentId=&year=&month=           -> payment status, grace period,
 *                                             override and effective access
 *   PUT { studentId, year, month, access }  -> access DEFAULT (remove the
 *                                             override), GRANTED or REVOKED
 * Teacher sessions only (visitors 401; students and admins 403). The class
 * must be the session teacher's (else 404 CLASS_NOT_FOUND) and the student
 * actively enrolled in it (else 404 STUDENT_NOT_ENROLLED). PUT is same-origin
 * only (CSRF). Nothing from the client decides access: only the override
 * choice is taken, the effective access is recalculated on the server.
 */

export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const session = await requireTeacherSessionForbiddingOtherRoles();
    const url = new URL(request.url);
    const month = parseResourceAccessMonth(url.searchParams.get("year"), url.searchParams.get("month"));
    const studentId = url.searchParams.get("studentId") ?? "";
    return apiSuccess(await getResourceAccessForTeacher(session.teacherId, context.params.id, studentId, month));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function PUT(request: Request, context: { params: { id: string } }) {
  // Same-origin only (CSRF), before authentication.
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) {
    return apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  }

  try {
    const session = await requireTeacherSessionForbiddingOtherRoles();
    const body = (await request.json().catch(() => {
      throw new AppError("The request body must be valid JSON.", 400, "VALIDATION_ERROR");
    })) as Record<string, unknown> | null;
    const input = body && typeof body === "object" ? body : {};
    const month = parseResourceAccessMonth(input.year, input.month);
    const choice = parseResourceAccessChoice(input.access);
    const studentId = typeof input.studentId === "string" ? input.studentId : "";
    const saved = await setResourceAccessOverride(session.teacherId, context.params.id, studentId, month, choice);
    return apiSuccess(saved, {
      message:
        choice === "DEFAULT"
          ? "Resource access restored to the automatic payment rules."
          : choice === "GRANTED"
            ? "Resource access granted for this month."
            : "Resource access revoked for this month.",
    });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
