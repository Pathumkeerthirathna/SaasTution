import { apiError, apiSuccess } from "@/lib/api-response";
import { buildSessionCookieConfig, signAuthToken, AUTH_COOKIE_NAME } from "@/lib/auth";
import { registerSchema } from "@/lib/auth-validation";
import { handleRouteError } from "@/lib/error-handler";
import { registerTeacher } from "@/services/auth-service";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      name?: string;
      email?: string;
      password?: string;
    };

    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const teacher = await registerTeacher(parsed.data);
    const token = await signAuthToken({
      sub: teacher.id,
      email: teacher.email,
      role: "TEACHER",
      name: teacher.name,
    });

    const response = apiSuccess(
      {
        teacher,
      },
      {
        status: 201,
        message: "Teacher account created successfully.",
      }
    );

    response.cookies.set(AUTH_COOKIE_NAME, token, buildSessionCookieConfig());
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
