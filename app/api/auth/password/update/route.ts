import { cookies } from "next/headers";

import { apiError, apiSuccess } from "@/lib/api-response";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { passwordUpdateSchema } from "@/lib/auth-validation";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { GUARDIAN_AUTH_COOKIE_NAME, verifyGuardianToken } from "@/lib/guardian-auth";
import { handleStudentPasswordChange } from "@/lib/student-password-change-http";
import { updatePasswordForAuthenticatedUser } from "@/services/auth-service";

export async function POST(request: Request) {
  try {
    // Students (Student Profile SP-5.6): the hardened flow, decided from the
    // verified token before the body is read. Teacher, admin and guardian
    // requests continue below exactly as before.
    const studentToken = cookies().get(AUTH_COOKIE_NAME)?.value;
    const studentSession = studentToken ? await verifyAuthToken(studentToken) : null;
    if (studentSession?.role === "STUDENT") {
      return await handleStudentPasswordChange(request, studentSession);
    }

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

      if (appSession.role === "STUDENT") {
        // Handled above; never reaches the shared service (it no longer accepts students).
        throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
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
    return handleRouteError(error, { request });
  }
}
