// GET /api/sessions/[id]/breakout-activities/quizzes/[quizId]/submissions
// Teacher: every attempt of the quiz, with answers and grading.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { listQuizAttemptsForTeacher } from "@/services/breakout-quiz-service";

import { requireBreakoutTeacher } from "../../../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: { id: string; quizId: string } }) {
  try {
    const teacherId = await requireBreakoutTeacher();
    return apiSuccess(await listQuizAttemptsForTeacher({ teacherId, sessionId: context.params.id, quizId: context.params.quizId }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
