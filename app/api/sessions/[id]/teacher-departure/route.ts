import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import {
  acknowledgeTeacherDepartureNotices,
  getTeacherDepartureNotices,
} from "@/lib/teacher-departure-notices";
import { isValidPageId } from "@/lib/teacher-presence";

export const dynamic = "force-dynamic";

/*
 * The class's own teacher, on returning to the classroom: what the
 * teacher-departure stop did to this session's YouTube Recording / Live
 * (lib/teacher-departure-notices.ts), and dismissing those notices.
 * Teachers only (students: 401), the session's own teacher only (404).
 */

function sessionIdOf(context: { params: { id: string } }) {
  const sessionId = context.params.id?.trim();

  if (!sessionId) {
    throw new AppError("Session id is required.", 400, "VALIDATION_ERROR");
  }

  return sessionId;
}

export async function GET(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();

    // The returning classroom page (teacher-departure-signal.ts), if it says.
    const pageId = new URL(request.url).searchParams.get("pageId");

    return apiSuccess(await getTeacherDepartureNotices(
      session.teacherId,
      sessionIdOf(context),
      isValidPageId(pageId) ? pageId : null
    ));
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
    const sessionId = sessionIdOf(context);

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      throw new AppError("Invalid JSON body.", 400, "VALIDATION_ERROR");
    }

    if (!body || typeof body !== "object") {
      throw new AppError("Invalid request body.", 400, "VALIDATION_ERROR");
    }

    const { recordingIds, liveIds } = body as { recordingIds?: unknown; liveIds?: unknown };

    return apiSuccess(
      await acknowledgeTeacherDepartureNotices(session.teacherId, sessionId, { recordingIds, liveIds }),
      { message: "Notices dismissed." }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
