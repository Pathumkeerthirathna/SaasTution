import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateGuardianLinkSchema } from "@/lib/guardian-validation";
import { updateGuardianLinkRelation } from "@/services/guardian-service";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: { id: string } }
) {
  try {
    const session = await requireTeacherSession();
    const guardianId = context.params.id;

    if (!guardianId?.trim()) {
      throw new AppError("Guardian id is required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as Record<string, unknown>;
    const parsed = updateGuardianLinkSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const result = await updateGuardianLinkRelation(
      session.teacherId,
      guardianId,
      parsed.data
    );

    return apiSuccess(result, { message: "Relation updated." });
  } catch (error) {
    return handleRouteError(error);
  }
}
