import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { createAssignmentSchema } from "@/lib/lecture-validation";
import { addAssignmentToLectureForTeacher, listAssignmentsForLectureForTeacher } from "@/services/lecture-service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const lectureId = context.params.id;

    if (!lectureId?.trim()) {
      throw new AppError("Lecture id is required.", 400, "VALIDATION_ERROR");
    }

    const assignments = await listAssignmentsForLectureForTeacher(session.teacherId, lectureId);
    return apiSuccess(assignments);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const lectureId = context.params.id;

    if (!lectureId?.trim()) {
      throw new AppError("Lecture id is required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as {
      title?: string;
      description?: string;
      dueDate?: string;
    };

    const parsed = createAssignmentSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const assignment = await addAssignmentToLectureForTeacher(session.teacherId, lectureId, parsed.data);

    return apiSuccess(
      {
        assignment,
      },
      {
        status: 201,
        message: "Assignment added successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
