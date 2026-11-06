// GET /api/sessions/[id]/breakout-activities
// Teacher: every assignment and quiz of the session (not deleted), with
// counts. No answer keys, no file paths. (The student view is Step 3.)
// INDIVIDUAL activities only: GROUP activities are listed by GET .../groups.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { listAssignmentsForTeacher } from "@/services/breakout-assignment-service";
import { listQuizzesForTeacher } from "@/services/breakout-quiz-service";

import { requireBreakoutTeacher } from "./_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const teacherId = await requireBreakoutTeacher();
    const [{ assignments }, { quizzes }] = await Promise.all([
      listAssignmentsForTeacher(teacherId, context.params.id),
      listQuizzesForTeacher(teacherId, context.params.id),
    ]);
    return apiSuccess({ assignments, quizzes });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
