import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSessionForbiddingOtherRoles } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { deletePaymentAccount, updatePaymentAccount } from "@/services/teacher-payment-account-service";

/*
 * One of the signed-in teacher's OWN payment accounts.
 *   PATCH  - edit (fields, isPublic, isActive, isPrimary: true).
 *   DELETE - remove (soft delete; a removed primary hands over to the oldest remaining account).
 * Teacher sessions only (visitors 401; students and admins 403). The account
 * must belong to the session's teacher: any other id (another teacher's,
 * removed, unknown) is 404, so other teachers' account ids are never confirmed.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string } };

function rejectCrossOrigin(request: Request) {
  const origin = checkSameOriginRequest(request);
  return origin.allowed ? null : apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED");
}

export async function PATCH(request: Request, { params }: Context) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;

  try {
    const session = await requireTeacherSessionForbiddingOtherRoles();
    const body = await request.json().catch(() => {
      throw new AppError("The request body must be valid JSON.", 400, "VALIDATION_ERROR");
    });
    return apiSuccess(await updatePaymentAccount(session.teacherId, params.id, body));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;

  try {
    const session = await requireTeacherSessionForbiddingOtherRoles();
    return apiSuccess(await deletePaymentAccount(session.teacherId, params.id));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
