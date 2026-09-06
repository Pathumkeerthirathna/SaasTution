import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import {
  getDummyPaperReviews,
  isTeacherPendingConfirmation,
} from "@/lib/dummy-dashboard-data";
import { handleRouteError } from "@/lib/error-handler";
import { getPendingPaperReviewsForTeacher } from "@/services/class-paper-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireTeacherSession();

    if (await isTeacherPendingConfirmation(session.teacherId)) {
      return apiSuccess(getDummyPaperReviews());
    }

    const reviews = await getPendingPaperReviewsForTeacher(session.teacherId);

    return apiSuccess(reviews);
  } catch (error) {
    return handleRouteError(error);
  }
}
