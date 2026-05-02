import { apiError, apiSuccess } from "@/lib/api-response";
import { buildSessionCookieConfig, signAuthToken, AUTH_COOKIE_NAME } from "@/lib/auth";
import { loginSchema } from "@/lib/auth-validation";
import { handleRouteError } from "@/lib/error-handler";
import { markTeacherLoggedIn } from "@/lib/login-tracker";
import { loginTeacher } from "@/services/auth-service";

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
      email?: string;
      password?: string;
    };

    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const loginId = parsed.data.email.trim().toLowerCase();

    if (loginId === ADMIN_LOGIN_ID && parsed.data.password === ADMIN_PASSWORD) {
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

    const teacher = await loginTeacher(loginId, parsed.data.password);
    markTeacherLoggedIn(teacher.id);

    const token = await signAuthToken({
      sub: teacher.id,
      email: teacher.email,
      role: "TEACHER",
      name: teacher.name,
    });

    const response = apiSuccess(
      {
        user: {
          ...teacher,
          role: "TEACHER" as const,
        },
        redirectTo: "/dashboard",
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
