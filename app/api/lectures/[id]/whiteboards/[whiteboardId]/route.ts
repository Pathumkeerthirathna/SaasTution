import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { updateWhiteboardSchema } from "@/lib/lecture-validation";
import {
  deleteWhiteboardForTeacher,
  getWhiteboardForTeacher,
  updateWhiteboardForTeacher,
} from "@/services/lecture-whiteboard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = {
  params: { id: string; whiteboardId: string };
};

function readIds(context: Context) {
  const lectureId = context.params.id;
  const whiteboardId = context.params.whiteboardId;

  if (!lectureId?.trim() || !whiteboardId?.trim()) {
    throw new AppError("Lecture id and whiteboard id are required.", 400, "VALIDATION_ERROR");
  }

  return { lectureId, whiteboardId };
}

export async function GET(_request: Request, context: Context) {
  try {
    const session = await requireTeacherSession();
    const { lectureId, whiteboardId } = readIds(context);

    const whiteboard = await getWhiteboardForTeacher(session.teacherId, lectureId, whiteboardId);
    return apiSuccess({ whiteboard });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    const session = await requireTeacherSession();
    const { lectureId, whiteboardId } = readIds(context);

    const parsed = updateWhiteboardSchema.safeParse(await request.json());

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const whiteboard = await updateWhiteboardForTeacher(
      session.teacherId,
      lectureId,
      whiteboardId,
      parsed.data
    );

    return apiSuccess({ whiteboard }, { message: "Whiteboard updated successfully." });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const session = await requireTeacherSession();
    const { lectureId, whiteboardId } = readIds(context);

    await deleteWhiteboardForTeacher(session.teacherId, lectureId, whiteboardId);

    return apiSuccess({ deleted: true }, { message: "Whiteboard deleted successfully." });
  } catch (error) {
    return handleRouteError(error);
  }
}
