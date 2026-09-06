import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import {
  getDummyBundlePaperReviews,
  isTeacherPendingConfirmation,
} from "@/lib/dummy-dashboard-data";
import { handleRouteError } from "@/lib/error-handler";
import { getPendingBundlePaperReviewsForTeacher } from "@/services/material-bundle-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireTeacherSession();

    if (await isTeacherPendingConfirmation(session.teacherId)) {
      return apiSuccess(getDummyBundlePaperReviews());
    }

    const reviews = await getPendingBundlePaperReviewsForTeacher(session.teacherId);

    return apiSuccess(reviews);
  } catch (error) {
    return handleRouteError(error);
  }
}
