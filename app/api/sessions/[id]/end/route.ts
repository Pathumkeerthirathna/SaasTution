import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { isGroupSessionEndDecision, type GroupSessionEndDecision } from "@/services/breakout-group-session-end";
import { endClassSessionForTeacher } from "@/services/session-service";

export const dynamic = "force-dynamic";

/**
 * Optional JSON body { "groupActivities": "preserve" | "delete" }: the
 * teacher's decision about the session's GROUP breakout activities (asked
 * for with 409 GROUP_ACTIVITIES_DECISION_REQUIRED). No body, as before.
 */
async function readGroupDecision(request: Request): Promise<GroupSessionEndDecision | undefined> {
  const text = await request.text().catch(() => "");
  if (text.trim() === "") return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AppError("Invalid request body.", 400, "VALIDATION_ERROR");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("Invalid request body.", 400, "VALIDATION_ERROR");
  }
  const keys = Object.keys(body);
  if (keys.length === 0) return undefined;
  const decision = (body as { groupActivities?: unknown }).groupActivities;
  if (keys.length !== 1 || keys[0] !== "groupActivities" || !isGroupSessionEndDecision(decision)) {
    throw new AppError('groupActivities must be "preserve" or "delete".', 400, "VALIDATION_ERROR");
  }
  return decision;
}

export async function POST(
  _request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      throw new AppError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    const groupActivities = await readGroupDecision(_request);

    const result = await endClassSessionForTeacher(session.teacherId, sessionId, { groupActivities });

    return apiSuccess(result, {
      message: "Class session ended successfully.",
    });
  } catch (error) {
    return handleRouteError(error, { request: _request });
  }
}
