import { apiError, apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { resendVerificationSchema } from "@/lib/auth-validation";
import { resendEmailConfirmationCode } from "@/services/auth-service";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      loginId?: string;
    };

    const parsed = resendVerificationSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    await resendEmailConfirmationCode(parsed.data.loginId);

    return apiSuccess(
      { sent: true },
      { message: "A new confirmation code has been sent to your email." }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
