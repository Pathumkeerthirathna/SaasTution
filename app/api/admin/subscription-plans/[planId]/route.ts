import { apiSuccess } from "@/lib/api-response";
import { requireAdminSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import {
  setSubscriptionPlanStatus,
  updateSubscriptionPlan,
} from "@/services/admin-subscription-plan-service";

export async function PUT(
  request: Request,
  context: { params: { planId: string } }
) {
  try {
    await requireAdminSession();

    const body = await request.json();

    const plan = await updateSubscriptionPlan(context.params.planId, body);

    return apiSuccess({ plan }, { message: "Subscription plan updated." });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: { planId: string } }
) {
  try {
    await requireAdminSession();

    // Plans referenced by past subscriptions must not be hard-deleted —
    // "remove" deactivates the plan (status = INACTIVE) instead.
    const plan = await setSubscriptionPlanStatus(
      context.params.planId,
      "INACTIVE"
    );

    return apiSuccess({ plan }, { message: "Subscription plan removed." });
  } catch (error) {
    return handleRouteError(error);
  }
}
