import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import {
  deleteTeacherCalendarEvent,
  updateTeacherCalendarEvent,
} from "@/services/teacher-event-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(raw: string) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError("A valid event id is required.", 400, "VALIDATION_ERROR");
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

    const body = (await request.json()) as Record<string, unknown>;

    const patch: Parameters<typeof updateTeacherCalendarEvent>[2] = {};
    if (body.eventTypeId !== undefined) patch.eventTypeId = Number(body.eventTypeId);
    if (body.title !== undefined) patch.title = String(body.title);
    if (body.description !== undefined)
      patch.description = (body.description as string | null) ?? null;
    if (body.startDateTime !== undefined)
      patch.startDateTime = String(body.startDateTime);
    if (body.endDateTime !== undefined)
      patch.endDateTime = String(body.endDateTime);
    if (body.isAllDay !== undefined) patch.isAllDay = Boolean(body.isAllDay);
    if (body.location !== undefined)
      patch.location = (body.location as string | null) ?? null;
    if (body.meetingUrl !== undefined)
      patch.meetingUrl = (body.meetingUrl as string | null) ?? null;

    const event = await updateTeacherCalendarEvent(session.teacherId, id, patch);
    return apiSuccess(event);
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

    const result = await deleteTeacherCalendarEvent(session.teacherId, id);
    return apiSuccess(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
