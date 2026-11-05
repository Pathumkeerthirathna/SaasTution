// GET /api/sessions/[id]/breakout-activities/assignments/[assignmentId]/submissions
// Teacher: the latest submission of each student with its version count;
// ?studentId=<uuid> gives that student's full history (newest first).
// (Student submit / own history: Step 3.)

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { listAssignmentSubmissionsForTeacher } from "@/services/breakout-assignment-service";

import { requireBreakoutTeacher, singleQueryParam } from "../../../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: { id: string; assignmentId: string } }) {
  try {
    const teacherId = await requireBreakoutTeacher();
    const studentId = singleQueryParam(request, "studentId");
    const result = await listAssignmentSubmissionsForTeacher({
      teacherId,
      sessionId: context.params.id,
      assignmentId: context.params.assignmentId,
      ...(studentId !== undefined ? { studentId } : {}),
    });
    return apiSuccess(result);
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
