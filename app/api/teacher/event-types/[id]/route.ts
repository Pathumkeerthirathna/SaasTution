import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import {
  deleteTeacherEventType,
  updateTeacherEventType,
} from "@/services/teacher-event-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(raw: string) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError("A valid event type id is required.", 400, "VALIDATION_ERROR");
  }
  return id;
}

export async function PUT(
  request: Request,
  context: { params: { id: string } }
) {
  try {
    const session = await requireTeacherSession();
    const id = parseId(context.params.id);

    const body = (await request.json()) as {
      name?: string;
      description?: string | null;
      color?: string | null;
      isActive?: boolean;
    };

    const type = await updateTeacherEventType(session.teacherId, id, body);
    return apiSuccess(type);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: { id: string } }
) {
  try {
    const session = await requireTeacherSession();
    const id = parseId(context.params.id);

    const result = await deleteTeacherEventType(session.teacherId, id);
    return apiSuccess(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
