// POST /api/sessions/[id]/breakout-activities/groups/quizzes
// Teacher: create one GROUP quiz per chosen existing breakout room (one
// publishGroupId, one server-built definition), optionally published at
// once, and confirm each room's members in the same request.
//
// application/json, strict:
//   { title, instructions?, timeLimitSeconds? (60-14400 | null),
//     questions: [...], rooms: [{ id, name, studentIds }], publish }
// 201 { publishGroupId, quizzes, rooms } (no answer keys in the response).
// Uses the existing createQuizzes() with the confirmed rooms as its trusted
// room directory; the existing create route is unchanged.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { readJsonBody } from "@/lib/breakout-activities/request-body";
import { groupQuizCreateSchema } from "@/lib/breakout-activities/groups/validation";
import { createGroupQuizzes } from "@/services/breakout-group-quiz-service";

import { parseWith, requireBreakoutTeacher } from "../../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: { id: string } }) {
  try {
    const teacherId = await requireBreakoutTeacher();
    const input = parseWith(groupQuizCreateSchema, await readJsonBody(request));
    const result = await createGroupQuizzes({ teacherId, sessionId: context.params.id, ...input });
    return apiSuccess(result, { status: 201, message: "Group quiz created." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
