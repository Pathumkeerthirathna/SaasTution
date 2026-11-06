// GET /api/sessions/[id]/breakout-activities/me/quizzes
// Student: the quizzes of the student's current room, metadata only (no
// questions), each with the student's own attempt summary.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { listQuizzesForStudent } from "@/services/breakout-student-quiz-service";

import { requireBreakoutStudent } from "../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const studentId = await requireBreakoutStudent();
    return apiSuccess(await listQuizzesForStudent({ studentId, sessionId: context.params.id }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
