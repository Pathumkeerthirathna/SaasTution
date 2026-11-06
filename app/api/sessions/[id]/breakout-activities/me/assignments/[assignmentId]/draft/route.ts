// GET /api/sessions/[id]/breakout-activities/me/assignments/[assignmentId]/draft
// PUT /api/sessions/[id]/breakout-activities/me/assignments/[assignmentId]/draft
//
// GET: the student's own draft ({ answerText: "", revision: 0 } when none).
// PUT, application/json: { revision, answerText (<= 50 000) } where revision
// is the one the student last saw (0 for the first save). A stale revision:
// 409 REVISION_CONFLICT with the current text and revision in details.
// CLOSED: 409 ASSIGNMENT_CLOSED.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { readJsonBody } from "@/lib/breakout-activities/request-body";
import { draftSaveSchema } from "@/lib/breakout-activities/validation";
import { getDraftForStudent, saveDraftForStudent } from "@/services/breakout-student-assignment-service";

import { parseWith, requireBreakoutStudent } from "../../../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; assignmentId: string } };

export async function GET(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    return apiSuccess(await getDraftForStudent({ studentId, sessionId: context.params.id, assignmentId: context.params.assignmentId }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    const body = parseWith(draftSaveSchema, await readJsonBody(request));
    const result = await saveDraftForStudent({
      studentId,
      sessionId: context.params.id,
      assignmentId: context.params.assignmentId,
      revision: body.revision,
      answerText: body.answerText,
    });
    return apiSuccess(result, { message: "Draft saved." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
