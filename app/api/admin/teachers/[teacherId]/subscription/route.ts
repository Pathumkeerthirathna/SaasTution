import { apiError, apiSuccess } from "@/lib/api-response";
import { requireAdminSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { assertTeacherIdFormat } from "@/services/admin-teacher-storage-service";
import {
  assignTeacherSubscriptionPlan,
  getAdminTeacherSubscription,
  parseAdminSubscriptionRequest,
} from "@/services/admin-teacher-subscription-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/teachers/[teacherId]/subscription (administrators only):
 * the teacher, their current subscription (null when none) and every plan
 * (ACTIVE and INACTIVE) that can be assigned.
 */
export async function GET(request: Request, context: { params: { teacherId: string } }) {
  try {
    await requireAdminSession();
    assertTeacherIdFormat(context.params.teacherId);
    return apiSuccess(await getAdminTeacherSubscription(context.params.teacherId));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

/**
 * PUT /api/admin/teachers/[teacherId]/subscription (administrators only).
 * Body: { "planId": "<plan uuid>" }. The price and currency are copied from
 * the plan; nothing else is taken from the body. An existing subscription
 * keeps its start date, end date and auto-renew setting. No payment is
 * recorded. Responds with the updated summary and whether anything changed.
 */
export async function PUT(request: Request, context: { params: { teacherId: string } }) {
  try {
    const admin = await requireAdminSession();
    assertTeacherIdFormat(context.params.teacherId);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("Invalid request body.", 400, "VALIDATION_ERROR");
    }
    const parsed = parseAdminSubscriptionRequest(body);
    if (!parsed.ok) return apiError(parsed.message, 400, "VALIDATION_ERROR");

    const { changed } = await assignTeacherSubscriptionPlan({
      teacherId: context.params.teacherId,
      planId: parsed.value.planId,
      admin: { adminId: admin.adminId, email: admin.email },
    });
    const summary = await getAdminTeacherSubscription(context.params.teacherId);
    return apiSuccess(
      { changed, ...summary },
      { message: changed ? "The subscription plan was updated." : "The subscription is unchanged." }
    );
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
