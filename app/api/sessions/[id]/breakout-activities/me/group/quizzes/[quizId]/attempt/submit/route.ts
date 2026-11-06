// POST /api/sessions/[id]/breakout-activities/me/group/quizzes/[quizId]/attempt/submit
// Student (any confirmed member of the quiz's room): the group's ONE final
// quiz submission. application/json, strict: { revision } (the attempt
// revision the student last saw). Already submitted: the stored result
// (replayed: true). Time over / closed: auto-submitted (200).

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { readJsonBody } from "@/lib/breakout-activities/request-body";
import { quizSubmitSchema } from "@/lib/breakout-activities/validation";
import { submitGroupQuiz } from "@/services/breakout-group-quiz-service";

import { parseWith, requireBreakoutStudent } from "../../../../../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; quizId: string } };

export async function POST(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    const input = parseWith(quizSubmitSchema, await readJsonBody(request));
    const result = await submitGroupQuiz({ studentId, sessionId: context.params.id, quizId: context.params.quizId, revision: input.revision });
    return apiSuccess(result, { message: result.replayed ? "Already submitted." : "Submitted." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
