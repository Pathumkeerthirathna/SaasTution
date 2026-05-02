import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { assignStudentSchema } from "@/lib/student-validation";
import { assignStudentToClass } from "@/services/student-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireTeacherSession();
    const body = (await request.json()) as {
      classId?: string;
      studentId?: string;
    };

    const parsed = assignStudentSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const assignment = await assignStudentToClass(
      session.teacherId,
      parsed.data.classId,
      parsed.data.studentId
    );

    return apiSuccess(
      {
        assignment,
      },
      {
        status: 201,
        message: "Student assigned to class successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
