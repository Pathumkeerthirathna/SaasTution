// PUT /api/sessions/[id]/breakout-activities/groups/members
// Teacher: confirm (or update) the members of existing breakout rooms for
// Group Activities. application/json, strict:
//   { rooms: [{ id, name, studentIds: [...] }] }
// Every listed room ends with exactly these students; a student listed in
// another room is moved; rooms not listed are unchanged. Every student must
// be actively enrolled in the session's class (400 STUDENT_NOT_IN_CLASS).
// This never changes the Jitsi breakout rooms themselves.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { readJsonBody } from "@/lib/breakout-activities/request-body";
import { membersUpdateSchema } from "@/lib/breakout-activities/groups/validation";
import { confirmGroupMembers } from "@/services/breakout-group-membership-service";

import { parseWith, requireBreakoutTeacher } from "../../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: { params: { id: string } }) {
  try {
    const teacherId = await requireBreakoutTeacher();
    const input = parseWith(membersUpdateSchema, await readJsonBody(request));
    const result = await confirmGroupMembers({ teacherId, sessionId: context.params.id, rooms: input.rooms });
    return apiSuccess(result, { message: "Group members updated." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
