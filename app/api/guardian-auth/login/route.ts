import { apiError, apiSuccess } from "@/lib/api-response";
import {
  buildGuardianSessionCookieConfig,
  GUARDIAN_AUTH_COOKIE_NAME,
  signGuardianToken,
} from "@/lib/guardian-auth";
import { guardianLoginSchema } from "@/lib/guardian-validation";
import { handleRouteError } from "@/lib/error-handler";
import { loginGuardian } from "@/services/guardian-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      email?: string;
      password?: string;
    };

    const parsed = guardianLoginSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const guardian = await loginGuardian(parsed.data);
    const token = await signGuardianToken({
      sub: guardian.id,
      email: guardian.email ?? parsed.data.email,
      role: "GUARDIAN",
      name: guardian.name,
    });

    const response = apiSuccess(
      {
        guardian,
      },
      {
        message: "Login successful.",
      }
    );

    response.cookies.set(GUARDIAN_AUTH_COOKIE_NAME, token, buildGuardianSessionCookieConfig());
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
