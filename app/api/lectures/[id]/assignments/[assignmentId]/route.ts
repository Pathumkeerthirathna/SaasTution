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
    return handleRouteError(error, { request });
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

    // PERMANENT deletion (Stage 3.6): the assignment, every submission and every submission PDF.
    // 200 only when everything is gone; 202 when it is hidden and the rest is still pending.
    const state = await deleteAssignmentForTeacher(session.teacherId, lectureId, assignmentId);

    if (state === "PENDING") {
      return apiSuccess(
        { deleted: false, pending: true },
        {
          message: "The assignment was removed. Its submissions and files are still being deleted and will be removed automatically.",
          status: 202,
        }
      );
    }

    return apiSuccess(
      {
        deleted: true,
        pending: false,
      },
      {
        message: "Assignment and all submissions deleted permanently.",
      }
    );
  } catch (error) {
    return handleRouteError(error, { request: _request });
  }
}
