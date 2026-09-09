import { apiSuccess } from "@/lib/api-response";
import { requireGuardianSession } from "@/lib/guardian-auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { getGuardianStudents } from "@/services/guardian-portal-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireGuardianSession();
    const students = await getGuardianStudents(session.guardianId);

    return apiSuccess({
      guardian: {
        id: session.guardianId,
        fullName: session.name,
        email: session.email,
      },
      students,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
