// GET /api/sessions/[id]/breakout-activities/me/assignments/[assignmentId]/brief
// Student: the brief PDF of an assignment of the student's current room
// (attachment). 404 FILE_NOT_FOUND when it has none.

import { handleRouteError } from "@/lib/error-handler";
import { getAssignmentBriefForStudent } from "@/services/breakout-student-assignment-service";

import { pdfResponse, requireBreakoutStudent } from "../../../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: { id: string; assignmentId: string } }) {
  try {
    const studentId = await requireBreakoutStudent();
    return pdfResponse(await getAssignmentBriefForStudent({ studentId, sessionId: context.params.id, assignmentId: context.params.assignmentId }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
