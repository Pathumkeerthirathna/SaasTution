import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { requireGuardianStudentAccess } from "@/lib/guardian-portal-guard";
import { getGuardianStudentAssignments } from "@/services/guardian-portal-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: { studentId: string } }
) {
  try {
    const { studentId } = await requireGuardianStudentAccess(
      context.params.studentId
    );

    const { searchParams } = new URL(request.url);

    const data = await getGuardianStudentAssignments(studentId, {
      classId: searchParams.get("classId") || undefined,
      from: searchParams.get("from") || undefined,
      to: searchParams.get("to") || undefined,
    });

    return apiSuccess(data);
  } catch (error) {
    return handleRouteError(error);
  }
}
