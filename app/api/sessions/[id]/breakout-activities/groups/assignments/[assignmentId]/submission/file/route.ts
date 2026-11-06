// GET /api/sessions/[id]/breakout-activities/groups/assignments/[assignmentId]/submission/file
// Teacher: the PDF of the group's final submission (404 FILE_NOT_FOUND without one).

import { handleRouteError } from "@/lib/error-handler";
import { getGroupSubmissionFileForTeacher } from "@/services/breakout-group-assignment-service";

import { pdfResponse, requireBreakoutTeacher } from "../../../../../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; assignmentId: string } };

export async function GET(request: Request, context: Context) {
  try {
    const teacherId = await requireBreakoutTeacher();
    return pdfResponse(await getGroupSubmissionFileForTeacher({ teacherId, sessionId: context.params.id, assignmentId: context.params.assignmentId }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
