import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateGuardianDetailsSchema } from "@/lib/guardian-validation";
import { updateGuardianDetails } from "@/services/guardian-service";

export const dynamic = "force-dynamic";

export async function PUT(
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
    const parsed = updateGuardianDetailsSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const guardian = await updateGuardianDetails(
      session.teacherId,
      guardianId,
      parsed.data
    );

    return apiSuccess({ guardian }, { message: "Guardian details updated." });
  } catch (error) {
    return handleRouteError(error);
  }
}
