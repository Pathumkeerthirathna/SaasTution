import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import {
  getDummyDashboardMetrics,
  isTeacherPendingConfirmation,
} from "@/lib/dummy-dashboard-data";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { getTeacherDashboardMetrics } from "@/services/dashboard-metrics-service";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();

    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from")?.trim() ?? "";
    const to = searchParams.get("to")?.trim() ?? "";

    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      throw new AppError(
        "`from` and `to` must be YYYY-MM-DD dates.",
        400,
        "VALIDATION_ERROR"
      );
    }

    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = new Date(`${to}T23:59:59.999Z`);

    if (
      Number.isNaN(fromDate.getTime()) ||
      Number.isNaN(toDate.getTime()) ||
      toDate.getTime() < fromDate.getTime()
    ) {
      throw new AppError("`to` must not be before `from`.", 400, "VALIDATION_ERROR");
    }

    if (await isTeacherPendingConfirmation(session.teacherId)) {
      return apiSuccess(getDummyDashboardMetrics());
    }

    const metrics = await getTeacherDashboardMetrics(
      session.teacherId,
      fromDate,
      toDate
    );

    return apiSuccess(metrics);
  } catch (error) {
    return handleRouteError(error);
  }
}
