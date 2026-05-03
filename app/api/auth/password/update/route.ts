import { cookies } from "next/headers";

import { apiError, apiSuccess } from "@/lib/api-response";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { passwordUpdateSchema } from "@/lib/auth-validation";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { GUARDIAN_AUTH_COOKIE_NAME, verifyGuardianToken } from "@/lib/guardian-auth";
import { updatePasswordForAuthenticatedUser } from "@/services/auth-service";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      currentPassword?: string;
      newPassword?: string;
    };

    const parsed = passwordUpdateSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const cookieStore = cookies();
    const appToken = cookieStore.get(AUTH_COOKIE_NAME)?.value;

    if (appToken) {
      const appSession = await verifyAuthToken(appToken);

      if (!appSession) {
        throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
      }

      if (appSession.role === "ADMIN") {
        throw new AppError("Admin password cannot be changed from this endpoint.", 403, "FORBIDDEN");
      }

      await updatePasswordForAuthenticatedUser({
        role: appSession.role,
        userId: appSession.sub,
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.newPassword,
      });

      return apiSuccess(
        {
          updated: true,
        },
        {
          message: "Password updated successfully.",
        }
      );
    }

    const guardianToken = cookieStore.get(GUARDIAN_AUTH_COOKIE_NAME)?.value;

    if (!guardianToken) {
      throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    }

    const guardianSession = await verifyGuardianToken(guardianToken);

    if (!guardianSession) {
      throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    }

    await updatePasswordForAuthenticatedUser({
      role: "GUARDIAN",
      userId: guardianSession.sub,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
    });

    return apiSuccess(
      {
        updated: true,
      },
      {
        message: "Password updated successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
