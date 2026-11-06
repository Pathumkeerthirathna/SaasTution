// POST /api/sessions/[id]/breakout-activities/me/quizzes/[quizId]/attempt/submit
// Student: submit the attempt. application/json: { revision } (the one the
// student last saw). Grades the SAVED answers. 200 with the result: the
// total score until the quiz is CLOSED, the review after it. A repeat
// returns the same result (replayed: true). Past the deadline + 5 s the saved
// answers are auto-submitted (200, attemptStatus AUTO_SUBMITTED). A stale
// revision: 409 REVISION_CONFLICT; no attempt: 409 QUIZ_NOT_STARTED.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { readJsonBody } from "@/lib/breakout-activities/request-body";
import { quizSubmitSchema } from "@/lib/breakout-activities/validation";
import { submitQuizAttempt } from "@/services/breakout-student-quiz-service";

import { parseWith, requireBreakoutStudent } from "../../../../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: { id: string; quizId: string } }) {
  try {
    const studentId = await requireBreakoutStudent();
    const { revision } = parseWith(quizSubmitSchema, await readJsonBody(request));
    const result = await submitQuizAttempt({ studentId, sessionId: context.params.id, quizId: context.params.quizId, revision });
    return apiSuccess(result, { message: result.replayed ? "Already submitted." : "Submitted." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
