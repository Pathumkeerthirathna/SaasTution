// GET /api/sessions/[id]/breakout-activities/me/group
// Student: my Group Activities group: the room, its confirmed members, and
// the published GROUP assignments / quizzes of that room with the group's
// progress and submission status. Not a confirmed member of any group:
// { group: null, assignments: [], quizzes: [] }.
// The student comes from the login session; the room from the teacher-
// confirmed membership (never from the request).

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { getMyGroupOverview } from "@/services/breakout-group-overview-service";

import { requireBreakoutStudent } from "../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const studentId = await requireBreakoutStudent();
    return apiSuccess(await getMyGroupOverview({ studentId, sessionId: context.params.id }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
