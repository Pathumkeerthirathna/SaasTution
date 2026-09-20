import { apiError, apiSuccess } from "@/lib/api-response";
import { registerSchema } from "@/lib/auth-validation";
import { handleRouteError } from "@/lib/error-handler";
import { registerTeacher } from "@/services/auth-service";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      name?: string;
      email?: string;
      password?: string;
      contact?: string;
    };

    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const teacher = await registerTeacher(parsed.data);

    // The account is not signed in yet — the teacher must confirm the code
    // emailed to them before they can log in for the first time.
    return apiSuccess(
      {
        teacher,
        requiresEmailConfirmation: true,
      },
      {
        status: 201,
        message: "Account created. Enter the confirmation code sent to your email to finish signing in.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
