// GET /api/sessions/[id]/breakout-activities/me/group/assignments/[assignmentId]/submission/file
// Student (a confirmed member of the assignment's room only): the PDF of the
// group's final submission (404 FILE_NOT_FOUND without one).

import { handleRouteError } from "@/lib/error-handler";
import { getGroupSubmissionFileForStudent } from "@/services/breakout-group-assignment-service";

import { pdfResponse, requireBreakoutStudent } from "../../../../../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; assignmentId: string } };

export async function GET(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    return pdfResponse(await getGroupSubmissionFileForStudent({ studentId, sessionId: context.params.id, assignmentId: context.params.assignmentId }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
