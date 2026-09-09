import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { requireGuardianStudentAccess } from "@/lib/guardian-portal-guard";
import {
  getStudentAttendanceAnalytics,
  getStudentAttendanceSummary,
} from "@/services/student-service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: { studentId: string } }
) {
  try {
    const { studentId } = await requireGuardianStudentAccess(
      context.params.studentId
    );

    const [summary, analytics] = await Promise.all([
      getStudentAttendanceSummary(studentId),
      getStudentAttendanceAnalytics(studentId, { months: 6 }),
    ]);

    return apiSuccess({ summary, analytics });
  } catch (error) {
    return handleRouteError(error);
  }
}
