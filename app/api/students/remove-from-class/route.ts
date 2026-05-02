import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { removeStudentFromClassSchema } from "@/lib/student-validation";
import { removeStudentFromClassForTeacher } from "@/services/student-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireTeacherSession();
    const body = (await request.json()) as {
      classId?: string;
      studentId?: string;
      reason?: string;
    };

    const parsed = removeStudentFromClassSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const assignment = await removeStudentFromClassForTeacher({
      teacherId: session.teacherId,
      classId: parsed.data.classId,
      studentId: parsed.data.studentId,
      reason: parsed.data.reason,
    });

    return apiSuccess(
      {
        assignment,
      },
      {
        message: "Student removed from class successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
