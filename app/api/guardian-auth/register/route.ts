import { apiError, apiSuccess } from "@/lib/api-response";
import {
  buildGuardianSessionCookieConfig,
  GUARDIAN_AUTH_COOKIE_NAME,
  signGuardianToken,
} from "@/lib/guardian-auth";
import { guardianRegisterSchema } from "@/lib/guardian-validation";
import { handleRouteError } from "@/lib/error-handler";
import { registerGuardianAccount } from "@/services/guardian-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      guardianId?: string;
      phone?: string;
      email?: string;
      password?: string;
    };

    const parsed = guardianRegisterSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const guardian = await registerGuardianAccount(parsed.data);
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
        status: 201,
        message: "Guardian account registered successfully.",
      }
    );

    response.cookies.set(GUARDIAN_AUTH_COOKIE_NAME, token, buildGuardianSessionCookieConfig());
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
