import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { createTeacherCalendarEvent } from "@/services/teacher-event-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireTeacherSession();
    const body = (await request.json()) as {
      eventTypeId?: unknown;
      title?: string;
      description?: string | null;
      startDateTime?: string;
      endDateTime?: string;
      isAllDay?: boolean;
      location?: string | null;
      meetingUrl?: string | null;
    };

    const eventTypeId = Number(body.eventTypeId);
    if (!Number.isInteger(eventTypeId) || eventTypeId <= 0) {
      throw new AppError("An event type is required.", 400, "VALIDATION_ERROR");
    }

    if (!body.startDateTime || !body.endDateTime) {
      throw new AppError(
        "Start and end date/time are required.",
        400,
        "VALIDATION_ERROR"
      );
    }

    const event = await createTeacherCalendarEvent(session.teacherId, {
      eventTypeId,
      title: String(body.title ?? ""),
      description: body.description ?? null,
      startDateTime: body.startDateTime,
      endDateTime: body.endDateTime,
      isAllDay: Boolean(body.isAllDay),
      location: body.location ?? null,
      meetingUrl: body.meetingUrl ?? null,
    });

    return apiSuccess(event, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
