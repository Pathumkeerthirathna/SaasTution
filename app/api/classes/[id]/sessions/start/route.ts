import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { startClassSessionSchema } from "@/lib/session-validation";
import { startClassSessionForTeacher } from "@/services/session-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const classId = context.params.id;

    if (!classId?.trim()) {
      throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
    }

    let body: {
      lectureId?: string;
    } = {};

    try {
      body = (await request.json()) as {
        lectureId?: string;
      };
    } catch {
      body = {};
    }

    const parsed = startClassSessionSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      throw new AppError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const result = await startClassSessionForTeacher(session.teacherId, classId, parsed.data.lectureId);

    return apiSuccess(result, {
      status: 201,
      message: "Class session started successfully.",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
