import { apiError, apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { verifyEmailSchema } from "@/lib/auth-validation";
import { confirmEmailCode } from "@/services/auth-service";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      loginId?: string;
      code?: string;
    };

    const parsed = verifyEmailSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    await confirmEmailCode(parsed.data.loginId, parsed.data.code);

    return apiSuccess(
      { confirmed: true },
      { message: "Email confirmed successfully." }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
