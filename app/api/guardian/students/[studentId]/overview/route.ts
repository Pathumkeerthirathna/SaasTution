import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { requireGuardianStudentAccess } from "@/lib/guardian-portal-guard";
import { getGuardianStudentOverview } from "@/services/guardian-portal-service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: { studentId: string } }
) {
  try {
    const { studentId } = await requireGuardianStudentAccess(
      context.params.studentId
    );
    return apiSuccess(await getGuardianStudentOverview(studentId));
  } catch (error) {
    return handleRouteError(error);
  }
}
