import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateGuardianSchema } from "@/lib/guardian-validation";
import { updateGuardianForTeacher } from "@/services/student-service";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const guardianId = context.params.id;

    if (!guardianId?.trim()) {
      throw new AppError("Guardian id is required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as {
      name?: string;
      relation?: string;
      phone?: string;
    };

    const parsed = updateGuardianSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const guardian = await updateGuardianForTeacher(session.teacherId, guardianId, parsed.data);

    return apiSuccess(
      {
        guardian,
      },
      {
        message: "Guardian updated successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
