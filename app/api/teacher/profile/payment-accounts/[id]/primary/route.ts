import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSessionForbiddingOtherRoles } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { setPrimaryPaymentAccount } from "@/services/teacher-payment-account-service";

/*
 * Makes one of the signed-in teacher's OWN payment accounts the primary
 * account (the previous primary stops being primary, in one transaction).
 * Teacher sessions only (visitors 401; students and admins 403); another
 * teacher's account id is 404.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) {
    return apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  }

  try {
    const session = await requireTeacherSessionForbiddingOtherRoles();
    return apiSuccess(await setPrimaryPaymentAccount(session.teacherId, params.id));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
