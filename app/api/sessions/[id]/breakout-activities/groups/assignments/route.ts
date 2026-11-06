// POST /api/sessions/[id]/breakout-activities/groups/assignments
// Teacher: create one GROUP assignment per chosen existing breakout room
// (one publishGroupId, one shared brief), optionally published at once, and
// confirm each room's members in the same request.
//
// multipart/form-data, strict fields:
//   title, instructions (optional; required unless a brief is attached),
//   rooms (JSON: [{ "id", "name", "studentIds": [...] }]),
//   publish ("true" | "false"), brief (optional PDF, max 25 MB).
// 201 { publishGroupId, assignments, rooms }.
// Uses the existing createAssignments() with the confirmed rooms as its
// trusted room directory; the existing create route is unchanged.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { assertOnlyFormFields, formBoolean, formJson, formPdf, formText, readMultipartBody } from "@/lib/breakout-activities/request-body";
import { groupAssignmentCreateSchema } from "@/lib/breakout-activities/groups/validation";
import { createGroupAssignments } from "@/services/breakout-group-assignment-service";

import { parseWith, requireBreakoutTeacher } from "../../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FIELDS = ["title", "instructions", "rooms", "publish", "brief"] as const;

export async function POST(request: Request, context: { params: { id: string } }) {
  try {
    const teacherId = await requireBreakoutTeacher();
    const form = await readMultipartBody(request);
    assertOnlyFormFields(form, FIELDS);
    const input = parseWith(groupAssignmentCreateSchema, {
      title: formText(form, "title"),
      instructions: formText(form, "instructions") ?? "",
      rooms: formJson(form, "rooms"),
      publish: formBoolean(form, "publish"),
    });
    const brief = await formPdf(form, "brief");
    const result = await createGroupAssignments({ teacherId, sessionId: context.params.id, ...input, brief });
    return apiSuccess(result, { status: 201, message: "Group assignment created." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
