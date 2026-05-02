import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateAssignmentSchema } from "@/lib/lecture-validation";
import { deleteAssignmentForTeacher, updateAssignmentForTeacher } from "@/services/lecture-service";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: {
    params: { id: string; assignmentId: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const lectureId = context.params.id;
    const assignmentId = context.params.assignmentId;

    if (!lectureId?.trim() || !assignmentId?.trim()) {
      throw new AppError("Lecture id and assignment id are required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as {
      title?: string;
      description?: string;
      dueDate?: string;
    };

    const parsed = updateAssignmentSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const assignment = await updateAssignmentForTeacher(
      session.teacherId,
      lectureId,
      assignmentId,
      parsed.data
    );

    return apiSuccess(
      {
        assignment,
      },
      {
        message: "Assignment updated successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: {
    params: { id: string; assignmentId: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const lectureId = context.params.id;
    const assignmentId = context.params.assignmentId;

    if (!lectureId?.trim() || !assignmentId?.trim()) {
      throw new AppError("Lecture id and assignment id are required.", 400, "VALIDATION_ERROR");
    }

    await deleteAssignmentForTeacher(session.teacherId, lectureId, assignmentId);

    return apiSuccess(
      {
        deleted: true,
      },
      {
        message: "Assignment deleted successfully.",
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
