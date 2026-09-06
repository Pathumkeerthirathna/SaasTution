import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { getActiveSubscriptionPlansForTeacher } from "@/services/teacher-subscription-service";

export async function GET() {
  try {
    await requireTeacherSession();

    const plans = await getActiveSubscriptionPlansForTeacher();

    return apiSuccess({ plans });
  } catch (error) {
    return handleRouteError(error);
  }
}
