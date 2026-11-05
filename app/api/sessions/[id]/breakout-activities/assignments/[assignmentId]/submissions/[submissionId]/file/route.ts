// GET /api/sessions/[id]/breakout-activities/assignments/[assignmentId]/submissions/[submissionId]/file
// Teacher: one submission's PDF (attachment), only when the submission
// belongs to this assignment in this session. (The owning student: Step 3.)

import { handleRouteError } from "@/lib/error-handler";
import { getAssignmentSubmissionFileForTeacher } from "@/services/breakout-assignment-service";

import { pdfResponse, requireBreakoutTeacher } from "../../../../../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; assignmentId: string; submissionId: string } };

export async function GET(request: Request, context: Context) {
  try {
    const teacherId = await requireBreakoutTeacher();
    return pdfResponse(
      await getAssignmentSubmissionFileForTeacher({
        teacherId,
        sessionId: context.params.id,
        assignmentId: context.params.assignmentId,
        submissionId: context.params.submissionId,
      })
    );
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
