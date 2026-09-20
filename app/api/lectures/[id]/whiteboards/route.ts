import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { createWhiteboardSchema } from "@/lib/lecture-validation";
import {
  createWhiteboardForTeacher,
  listWhiteboardsForLectureForTeacher,
} from "@/services/lecture-whiteboard-service";

export const runtime = "nodejs";
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

    const whiteboards = await listWhiteboardsForLectureForTeacher(session.teacherId, lectureId);
    return apiSuccess(whiteboards);
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

    const parsed = createWhiteboardSchema.safeParse(await request.json());

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const whiteboard = await createWhiteboardForTeacher(session.teacherId, lectureId, parsed.data);

    return apiSuccess({ whiteboard }, { status: 201, message: "Whiteboard saved successfully." });
  } catch (error) {
    return handleRouteError(error);
  }
}
