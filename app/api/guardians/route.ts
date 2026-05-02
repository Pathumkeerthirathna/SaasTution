import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { createGuardianSchema } from "@/lib/guardian-validation";
import { handleRouteError } from "@/lib/error-handler";
import { addGuardianForTeacher } from "@/services/student-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireTeacherSession();
    const body = (await request.json()) as {
      studentId?: string;
      name?: string;
      relation?: string;
      phone?: string;
    };

    const parsed = createGuardianSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const guardian = await addGuardianForTeacher(session.teacherId, parsed.data);

    return apiSuccess(
      {
        guardian,
      },
      {
        status: 201,
        message: "Guardian added successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
