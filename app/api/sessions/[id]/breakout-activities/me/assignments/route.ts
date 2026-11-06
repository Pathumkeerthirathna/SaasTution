// GET /api/sessions/[id]/breakout-activities/me/assignments
// Student: the assignments of the student's current room, each with the
// student's own draft state and latest submission.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { listAssignmentsForStudent } from "@/services/breakout-student-assignment-service";

import { requireBreakoutStudent } from "../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const studentId = await requireBreakoutStudent();
    return apiSuccess(await listAssignmentsForStudent({ studentId, sessionId: context.params.id }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
