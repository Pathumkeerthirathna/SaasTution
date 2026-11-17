import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import {
  getCurrentTeacherSubscription,
  selectTeacherSubscriptionPlan,
} from "@/services/teacher-subscription-service";

export async function GET(request: Request) {
  try {
    const teacherSession = await requireTeacherSession();

    const subscription = await getCurrentTeacherSubscription(
      teacherSession.teacherId
    );

    return apiSuccess({ subscription });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function POST(request: Request) {
  try {
    const teacherSession = await requireTeacherSession();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("Invalid request body.", 400, "VALIDATION_ERROR");
    }
    const planId =
      typeof (body as { planId?: unknown } | null)?.planId === "string"
        ? (body as { planId: string }).planId
        : "";

    if (!planId) {
      return apiError("planId is required.", 400, "VALIDATION_ERROR");
    }

    const subscription = await selectTeacherSubscriptionPlan(
      teacherSession.teacherId,
      planId
    );

    return apiSuccess(
      { subscription },
      { message: "Subscription plan selected." }
    );
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
