// GET /api/sessions/[id]/breakout-activities/me/group/assignments/[assignmentId]
// PUT /api/sessions/[id]/breakout-activities/me/group/assignments/[assignmentId]
//
// Student (a confirmed member of the assignment's room only; anyone else 404):
// GET: the assignment, the group's members, the shared work (text, revision,
//      latest editor) and the final submission once made.
// PUT, application/json, strict: { revision, answerText } saves the shared
//      text. A stale revision: 409 REVISION_CONFLICT with the current work
//      (reload). CLOSED: 409 ASSIGNMENT_CLOSED; submitted: 409 GROUP_WORK_SUBMITTED.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { readJsonBody } from "@/lib/breakout-activities/request-body";
import { draftSaveSchema } from "@/lib/breakout-activities/validation";
import { getGroupAssignmentForStudent, saveGroupAssignmentWork } from "@/services/breakout-group-assignment-service";

import { parseWith, requireBreakoutStudent } from "../../../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; assignmentId: string } };

export async function GET(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    return apiSuccess(await getGroupAssignmentForStudent({ studentId, sessionId: context.params.id, assignmentId: context.params.assignmentId }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    const input = parseWith(draftSaveSchema, await readJsonBody(request));
    const result = await saveGroupAssignmentWork({ studentId, sessionId: context.params.id, assignmentId: context.params.assignmentId, ...input });
    return apiSuccess(result, { message: "Saved." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
