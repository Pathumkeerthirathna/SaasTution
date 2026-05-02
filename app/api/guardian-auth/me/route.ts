import { apiSuccess } from "@/lib/api-response";
import { requireGuardianSession } from "@/lib/guardian-auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { getGuardianStudentOverview } from "@/services/guardian-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireGuardianSession();
    const overview = await getGuardianStudentOverview(session.guardianId);

    return apiSuccess(overview);
  } catch (error) {
    return handleRouteError(error);
  }
}
