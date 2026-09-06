import { apiSuccess } from "@/lib/api-response";
import { requireAdminSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import {
  createSubscriptionPlan,
  listSubscriptionPlansForAdmin,
} from "@/services/admin-subscription-plan-service";

export async function GET() {
  try {
    await requireAdminSession();

    const plans = await listSubscriptionPlansForAdmin();

    return apiSuccess({ plans });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdminSession();

    const body = await request.json();

    const plan = await createSubscriptionPlan(body);

    return apiSuccess(
      { plan },
      { status: 201, message: "Subscription plan created." }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
