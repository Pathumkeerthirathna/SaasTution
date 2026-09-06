import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import {
  getCurrentTeacherSubscription,
  selectTeacherSubscriptionPlan,
} from "@/services/teacher-subscription-service";

export async function GET() {
  try {
    const teacherSession = await requireTeacherSession();

    const subscription = await getCurrentTeacherSubscription(
      teacherSession.teacherId
    );

    return apiSuccess({ subscription });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const teacherSession = await requireTeacherSession();

    const body = await request.json();
    const planId = typeof body?.planId === "string" ? body.planId : "";

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
    return handleRouteError(error);
  }
}
