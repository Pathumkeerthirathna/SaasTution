import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { guardianSearchSchema } from "@/lib/guardian-validation";
import { handleRouteError } from "@/lib/error-handler";
import { searchGuardians } from "@/services/guardian-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireTeacherSession();

    const { searchParams } = new URL(request.url);
    const parsed = guardianSearchSchema.safeParse({ q: searchParams.get("q") ?? "" });

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid search query.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR");
    }

    const guardians = await searchGuardians(parsed.data.q);
    return apiSuccess(guardians);
  } catch (error) {
    return handleRouteError(error);
  }
}
