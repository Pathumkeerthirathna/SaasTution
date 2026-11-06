// PATCH /api/sessions/[id]/breakout-activities/groups/quizzes/[quizId]/grading
// Teacher: override marks of the group's submitted attempt, with the
// existing marking rules. application/json, strict (the existing schema):
//   { overrides: [{ questionId, marks: number | null, note? }] }

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { readJsonBody } from "@/lib/breakout-activities/request-body";
import { gradingOverridesSchema } from "@/lib/breakout-activities/validation";
import { overrideGroupQuizGrading } from "@/services/breakout-group-quiz-service";

import { parseWith, requireBreakoutTeacher } from "../../../../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; quizId: string } };

export async function PATCH(request: Request, context: Context) {
  try {
    const teacherId = await requireBreakoutTeacher();
    const input = parseWith(gradingOverridesSchema, await readJsonBody(request));
    const result = await overrideGroupQuizGrading({ teacherId, sessionId: context.params.id, quizId: context.params.quizId, overrides: input.overrides });
    return apiSuccess(result, { message: "Grading updated." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
