// GET /api/sessions/[id]/breakout-activities/me/group/quizzes/[quizId]
// Student (a confirmed member of the quiz's room only; anyone else 404):
// before the group starts, metadata only; then the questions (no answer
// keys), the shared answers, who started / saved / submitted, progress, and
// the result (the score once submitted, the review once the quiz is closed).

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { getGroupQuizForStudent } from "@/services/breakout-group-quiz-service";

import { requireBreakoutStudent } from "../../../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; quizId: string } };

export async function GET(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    return apiSuccess(await getGroupQuizForStudent({ studentId, sessionId: context.params.id, quizId: context.params.quizId }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
