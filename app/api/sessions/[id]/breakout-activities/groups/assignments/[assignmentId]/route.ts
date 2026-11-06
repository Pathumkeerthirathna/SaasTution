// GET /api/sessions/[id]/breakout-activities/groups/assignments/[assignmentId]
// Teacher: one GROUP assignment: the room's confirmed members, the shared
// work (text, revision, latest editor) and the final submission.
// Publish / close / edit / delete: the existing
// PATCH / DELETE …/breakout-activities/assignments/[assignmentId].

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { getGroupAssignmentForTeacher } from "@/services/breakout-group-assignment-service";

import { requireBreakoutTeacher } from "../../../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; assignmentId: string } };

export async function GET(request: Request, context: Context) {
  try {
    const teacherId = await requireBreakoutTeacher();
    return apiSuccess(await getGroupAssignmentForTeacher({ teacherId, sessionId: context.params.id, assignmentId: context.params.assignmentId }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
