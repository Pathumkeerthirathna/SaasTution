// GET /api/sessions/[id]/breakout-activities/me/group/assignments/[assignmentId]/brief
// Student (a confirmed member of the assignment's room only): the brief PDF.

import { handleRouteError } from "@/lib/error-handler";
import { getGroupAssignmentBriefForStudent } from "@/services/breakout-group-assignment-service";

import { pdfResponse, requireBreakoutStudent } from "../../../../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; assignmentId: string } };

export async function GET(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    return pdfResponse(await getGroupAssignmentBriefForStudent({ studentId, sessionId: context.params.id, assignmentId: context.params.assignmentId }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
