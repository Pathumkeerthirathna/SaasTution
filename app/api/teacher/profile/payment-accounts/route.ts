import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSessionForbiddingOtherRoles } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { createPaymentAccount, listOwnerPaymentAccounts } from "@/services/teacher-payment-account-service";

/*
 * The signed-in teacher's OWN payment accounts (Payment Details).
 *   GET  - every non-removed account of the teacher (owner view).
 *   POST - add an account.
 * Teacher sessions only (visitors get 401; signed-in students and admins
 * 403); the teacher id comes from the session, never from the request.
 * Visitors and students see published accounts only, rendered by the profile
 * page itself - there is no public API for accounts.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireTeacherSessionForbiddingOtherRoles();
    return apiSuccess(await listOwnerPaymentAccounts(session.teacherId));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function POST(request: Request) {
  // Same-origin only (CSRF), before authentication.
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) {
    return apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  }

  try {
    const session = await requireTeacherSessionForbiddingOtherRoles();
    const body = await request.json().catch(() => {
      throw new AppError("The request body must be valid JSON.", 400, "VALIDATION_ERROR");
    });
    return apiSuccess(await createPaymentAccount(session.teacherId, body), { status: 201 });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
