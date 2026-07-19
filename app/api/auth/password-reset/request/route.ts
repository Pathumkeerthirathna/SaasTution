import { apiError, apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { passwordResetRequestSchema } from "@/lib/auth-validation";
import { requestPasswordReset } from "@/services/auth-service";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      loginId?: string;
    };

    const parsed = passwordResetRequestSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    await requestPasswordReset(parsed.data.loginId,process.env.NEXT_PUBLIC_APP_URL);

    return apiSuccess(
      {
        requested: true,
      },
      {
        message: "If an account exists, a reset link has been sent to the registered email address.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
