import { apiError, apiSuccess } from "@/lib/api-response";
import { buildSessionCookieConfig, signAuthToken, AUTH_COOKIE_NAME } from "@/lib/auth";
import { loginSchema } from "@/lib/auth-validation";
import { handleRouteError } from "@/lib/error-handler";
import { markTeacherLoggedIn } from "@/lib/login-tracker";
import { verifySessionInviteToken } from "@/lib/session-invite";
import { loginByLoginId } from "@/services/auth-service";

const ADMIN_LOGIN_ID = "pathum";
const ADMIN_PASSWORD = "abcD@1234";
const ADMIN_USER = {
  id: "admin-pathum",
  name: "Pathum",
  email: "pathum@admin.local",
  role: "ADMIN" as const,
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      loginId?: string;
      email?: string;
      password?: string;
      inviteToken?: string;
    };

    const normalizedBody = {
      loginId: body.loginId ?? body.email,
      password: body.password,
    };

    const parsed = loginSchema.safeParse(normalizedBody);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const loginId = parsed.data.loginId.trim();
    const normalizedLoginId = loginId.toLowerCase();

    if (normalizedLoginId === ADMIN_LOGIN_ID && parsed.data.password === ADMIN_PASSWORD) {
      const token = await signAuthToken({
        sub: ADMIN_USER.id,
        email: ADMIN_USER.email,
        role: ADMIN_USER.role,
        name: ADMIN_USER.name,
      });

      const response = apiSuccess(
        {
          user: ADMIN_USER,
          redirectTo: "/dashboard/admin",
        },
        {
          message: "Login successful.",
        }
      );

      response.cookies.set(AUTH_COOKIE_NAME, token, buildSessionCookieConfig());
      return response;
    }

    const loginResult = await loginByLoginId(loginId, parsed.data.password);
    let redirectTo = loginResult.redirectTo;

    const inviteToken = body.inviteToken?.trim();

    if (inviteToken && loginResult.role === "STUDENT") {
      const invitePayload = await verifySessionInviteToken(inviteToken);

      if (invitePayload && invitePayload.studentId === loginResult.user.id) {
        redirectTo = `/student/dashboard?invite=${encodeURIComponent(inviteToken)}`;
      }
    }

    if (loginResult.role === "TEACHER") {
      markTeacherLoggedIn(loginResult.user.id);
    }

    const token = await signAuthToken({
      sub: loginResult.user.id,
      email: loginResult.user.email,
      role: loginResult.role,
      name: loginResult.user.name,
    });

    const response = apiSuccess(
      {
        user: {
          ...loginResult.user,
          role: loginResult.role,
        },
        redirectTo,
      },
      {
        message: "Login successful.",
      }
    );

    response.cookies.set(AUTH_COOKIE_NAME, token, buildSessionCookieConfig());
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
