// GET /api/sessions/[id]/breakout-activities/groups/quizzes/[quizId]
// Teacher: one GROUP quiz: the definition with answer keys, the room's
// confirmed members, and the shared attempt with answers, grading and
// scores (a due attempt is auto-submitted first while the session is active).
// Publish / close / edit / delete: the existing …/breakout-activities/quizzes/[quizId].

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { getGroupQuizForTeacher } from "@/services/breakout-group-quiz-service";

import { requireBreakoutTeacher } from "../../../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; quizId: string } };

export async function GET(request: Request, context: Context) {
  try {
    const teacherId = await requireBreakoutTeacher();
    return apiSuccess(await getGroupQuizForTeacher({ teacherId, sessionId: context.params.id, quizId: context.params.quizId }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
