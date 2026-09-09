import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { requireGuardianStudentAccess } from "@/lib/guardian-portal-guard";
import { getGuardianStudentPapers } from "@/services/guardian-portal-service";

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

    const data = await getGuardianStudentPapers(studentId, {
      classId: searchParams.get("classId") || undefined,
      year: Number(searchParams.get("year")) || undefined,
      month: Number(searchParams.get("month")) || undefined,
    });

    return apiSuccess(data);
  } catch (error) {
    return handleRouteError(error);
  }
}
