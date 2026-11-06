// GET /api/sessions/[id]/breakout-activities/me/quizzes/[quizId]
// Student: one quiz of the student's current room. No attempt: metadata
// only (also when CLOSED). An attempt: the questions without answer keys
// and the student's own attempt (the score until CLOSED, the review after).

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { getQuizForStudent } from "@/services/breakout-student-quiz-service";

import { requireBreakoutStudent } from "../../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: { id: string; quizId: string } }) {
  try {
    const studentId = await requireBreakoutStudent();
    return apiSuccess(await getQuizForStudent({ studentId, sessionId: context.params.id, quizId: context.params.quizId }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
