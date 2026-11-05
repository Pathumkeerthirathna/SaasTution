// PATCH /api/sessions/[id]/breakout-activities/quizzes/[quizId]/submissions/[submissionId]/grading
// Teacher: mark overrides for one attempt.
//
// application/json: { "overrides": [{ "questionId", "marks": number | null, "note"? }] }
// Allowed while the session is active, the quiz PUBLISHED or CLOSED, and the
// attempt SUBMITTED or AUTO_SUBMITTED (IN_PROGRESS: 409 QUIZ_NOT_SUBMITTED).
// 200 { autoScore, finalScore, grading, overriddenAt }.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { readJsonBody } from "@/lib/breakout-activities/request-body";
import { gradingOverridesSchema } from "@/lib/breakout-activities/validation";
import { overrideQuizGrading } from "@/services/breakout-quiz-service";

import { parseWith, requireBreakoutTeacher } from "../../../../../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; quizId: string; submissionId: string } };

export async function PATCH(request: Request, context: Context) {
  try {
    const teacherId = await requireBreakoutTeacher();
    const { overrides } = parseWith(gradingOverridesSchema, await readJsonBody(request));
    const result = await overrideQuizGrading({
      teacherId,
      sessionId: context.params.id,
      quizId: context.params.quizId,
      submissionId: context.params.submissionId,
      overrides,
    });
    return apiSuccess(result, { message: "Marks updated." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
