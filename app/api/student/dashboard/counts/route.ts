import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import {
  getStudentDashboardCounts,
  type CountsRange,
} from "@/services/student-dashboard-counts-service";

export const dynamic = "force-dynamic";

const RANGES: CountsRange[] = ["month", "quarter", "year", "all"];

export async function GET(request: Request) {
  try {
    const session = await requireStudentSession();
    const raw = new URL(request.url).searchParams.get("range");
    const range: CountsRange = RANGES.includes(raw as CountsRange) ? (raw as CountsRange) : "month";

    const counts = await getStudentDashboardCounts(session.studentId, range);
    return apiSuccess({ counts });
  } catch (error) {
    return handleRouteError(error);
  }
}
