import { apiError, apiSuccess } from "@/lib/api-response";
import { passwordResetConfirmSchema } from "@/lib/auth-validation";
import { handleRouteError } from "@/lib/error-handler";
import { confirmPasswordReset } from "@/services/auth-service";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      token?: string;
      newPassword?: string;
    };

    const parsed = passwordResetConfirmSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    await confirmPasswordReset(parsed.data.token, parsed.data.newPassword);

    return apiSuccess(
      {
        updated: true,
      },
      {
        message: "Password reset successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
