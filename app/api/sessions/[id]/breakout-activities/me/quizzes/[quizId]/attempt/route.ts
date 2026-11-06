// POST  /api/sessions/[id]/breakout-activities/me/quizzes/[quizId]/attempt
// PATCH /api/sessions/[id]/breakout-activities/me/quizzes/[quizId]/attempt
//
// POST (no body): start the attempt, or return the existing one. 201 when
// this request started it, 200 otherwise. A CLOSED quiz without an attempt:
// 409 QUIZ_CLOSED.
// PATCH, application/json: { revision, answers } where answers holds only
// the questions being saved (the others keep their saved answers). A stale
// revision: 409 REVISION_CONFLICT (current answers and revision in details);
// past the deadline + 5 s: the saved answers are auto-submitted, then 409
// QUIZ_TIME_UP with the result in details; no attempt: 409 QUIZ_NOT_STARTED.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { readJsonBody } from "@/lib/breakout-activities/request-body";
import { quizAnswersSaveSchema } from "@/lib/breakout-activities/validation";
import { saveQuizAnswers, startQuizAttempt } from "@/services/breakout-student-quiz-service";

import { parseWith, requireBreakoutStudent } from "../../../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; quizId: string } };

export async function POST(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    const result = await startQuizAttempt({ studentId, sessionId: context.params.id, quizId: context.params.quizId });
    return apiSuccess(result, { status: result.started ? 201 : 200 });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    const body = parseWith(quizAnswersSaveSchema, await readJsonBody(request));
    const result = await saveQuizAnswers({
      studentId,
      sessionId: context.params.id,
      quizId: context.params.quizId,
      revision: body.revision,
      answers: body.answers,
    });
    return apiSuccess(result, { message: "Answers saved." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
