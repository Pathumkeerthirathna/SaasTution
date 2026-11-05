// POST /api/sessions/[id]/breakout-activities/quizzes
// Teacher: create one quiz per target room (one publishGroupId, one
// server-built definition), optionally published at once.
//
// application/json, strict:
//   { title, instructions?, timeLimitSeconds? (60-14400 | null),
//     questions: [...], targets: [...], publish }
// 201 { publishGroupId, quizzes } (no answer keys in the response).
// An unresolvable BREAKOUT target: 409 ROOM_UNKNOWN, nothing created.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { readJsonBody } from "@/lib/breakout-activities/request-body";
import { quizCreateSchema } from "@/lib/breakout-activities/validation";
import { createQuizzes } from "@/services/breakout-quiz-service";

import { parseWith, requireBreakoutTeacher } from "../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: { id: string } }) {
  try {
    const teacherId = await requireBreakoutTeacher();
    const input = parseWith(quizCreateSchema, await readJsonBody(request));
    const result = await createQuizzes({ teacherId, sessionId: context.params.id, ...input });
    return apiSuccess(result, { status: 201, message: "Quiz created." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
