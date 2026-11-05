// GET    /api/sessions/[id]/breakout-activities/quizzes/[quizId]
// PATCH  /api/sessions/[id]/breakout-activities/quizzes/[quizId]
// DELETE /api/sessions/[id]/breakout-activities/quizzes/[quizId]
//
// GET (teacher): the full definition, answer keys included. (The student
// projection is Step 3.)
// PATCH, application/json, exactly one of:
//   { "action": "publish" | "close" }   this quiz only; close auto-submits
//                                       every IN_PROGRESS attempt
//   { title?, instructions?, timeLimitSeconds?, questions? }   DRAFT edits
// DELETE: DRAFT only, soft (status = 1).

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { readJsonBody } from "@/lib/breakout-activities/request-body";
import { quizPatchSchema } from "@/lib/breakout-activities/validation";
import { deleteQuiz, editQuiz, getQuizForTeacher, setQuizState } from "@/services/breakout-quiz-service";

import { parseWith, requireBreakoutTeacher } from "../../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; quizId: string } };

export async function GET(request: Request, context: Context) {
  try {
    const teacherId = await requireBreakoutTeacher();
    return apiSuccess(await getQuizForTeacher({ teacherId, sessionId: context.params.id, quizId: context.params.quizId }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const teacherId = await requireBreakoutTeacher();
    const target = { teacherId, sessionId: context.params.id, quizId: context.params.quizId };
    const body = parseWith(quizPatchSchema, await readJsonBody(request));
    if ("action" in body) {
      return apiSuccess(await setQuizState({ ...target, action: body.action }));
    }
    return apiSuccess(await editQuiz({ ...target, ...body }), { message: "Quiz updated." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const teacherId = await requireBreakoutTeacher();
    const result = await deleteQuiz({ teacherId, sessionId: context.params.id, quizId: context.params.quizId });
    return apiSuccess(result, { message: "Quiz deleted." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
