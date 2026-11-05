// GET /api/sessions/[id]/breakout-activities/assignments/[assignmentId]/brief
// Teacher: the assignment's brief PDF (attachment). 404 FILE_NOT_FOUND when
// it has none or the file is gone. (Students: Step 3.)

import { handleRouteError } from "@/lib/error-handler";
import { getAssignmentBriefForTeacher } from "@/services/breakout-assignment-service";

import { pdfResponse, requireBreakoutTeacher } from "../../../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: { id: string; assignmentId: string } }) {
  try {
    const teacherId = await requireBreakoutTeacher();
    return pdfResponse(await getAssignmentBriefForTeacher({ teacherId, sessionId: context.params.id, assignmentId: context.params.assignmentId }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
