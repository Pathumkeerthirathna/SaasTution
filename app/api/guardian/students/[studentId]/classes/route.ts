import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { requireGuardianStudentAccess } from "@/lib/guardian-portal-guard";
import { getStudentClassesForTeacher } from "@/services/student-service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: { studentId: string } }
) {
  try {
    const { studentId } = await requireGuardianStudentAccess(
      context.params.studentId
    );
    return apiSuccess(await getStudentClassesForTeacher(studentId));
  } catch (error) {
    return handleRouteError(error);
  }
}
