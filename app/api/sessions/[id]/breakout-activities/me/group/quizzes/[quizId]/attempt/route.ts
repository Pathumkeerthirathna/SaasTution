// POST  /api/sessions/[id]/breakout-activities/me/group/quizzes/[quizId]/attempt
// PATCH /api/sessions/[id]/breakout-activities/me/group/quizzes/[quizId]/attempt
//
// Student (a confirmed member of the quiz's room only):
// POST: start the group's shared attempt (or get the existing one; never a
//       second). 201 when this call started it, else 200.
// PATCH, application/json, strict: { answers } saves those questions only
//       (the other saved answers stay). Time over / closed: the saved
//       answers are auto-submitted, then 409 QUIZ_TIME_UP / QUIZ_CLOSED.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { readJsonBody } from "@/lib/breakout-activities/request-body";
import { groupQuizSaveSchema } from "@/lib/breakout-activities/groups/validation";
import { saveGroupQuizAnswers, startGroupQuiz } from "@/services/breakout-group-quiz-service";

import { parseWith, requireBreakoutStudent } from "../../../../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; quizId: string } };

export async function POST(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    const result = await startGroupQuiz({ studentId, sessionId: context.params.id, quizId: context.params.quizId });
    return apiSuccess(result, { status: result.started ? 201 : 200, message: result.started ? "Quiz started." : "Quiz resumed." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    const input = parseWith(groupQuizSaveSchema, await readJsonBody(request));
    return apiSuccess(await saveGroupQuizAnswers({ studentId, sessionId: context.params.id, quizId: context.params.quizId, answers: input.answers }), {
      message: "Saved.",
    });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
