// POST /api/sessions/[id]/breakout-activities/assignments
// Teacher: create one assignment per target room (one publishGroupId, one
// shared brief), optionally published at once.
//
// multipart/form-data, strict fields:
//   title, instructions (optional; required unless a brief is attached),
//   targets (JSON: [{"type":"MAIN"} | {"type":"BREAKOUT","id":"..."}]),
//   publish ("true" | "false"), brief (optional PDF, max 25 MB).
// 201 { publishGroupId, assignments }.
// An unresolvable BREAKOUT target: 409 ROOM_UNKNOWN, nothing created.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { assertOnlyFormFields, formBoolean, formJson, formPdf, formText, readMultipartBody } from "@/lib/breakout-activities/request-body";
import { assignmentCreateSchema } from "@/lib/breakout-activities/validation";
import { createAssignments } from "@/services/breakout-assignment-service";

import { parseWith, requireBreakoutTeacher } from "../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FIELDS = ["title", "instructions", "targets", "publish", "brief"] as const;

export async function POST(request: Request, context: { params: { id: string } }) {
  try {
    const teacherId = await requireBreakoutTeacher();
    const form = await readMultipartBody(request);
    assertOnlyFormFields(form, FIELDS);
    const input = parseWith(assignmentCreateSchema, {
      title: formText(form, "title"),
      instructions: formText(form, "instructions") ?? "",
      targets: formJson(form, "targets"),
      publish: formBoolean(form, "publish"),
    });
    const brief = await formPdf(form, "brief");
    const result = await createAssignments({ teacherId, sessionId: context.params.id, ...input, brief });
    return apiSuccess(result, { status: 201, message: "Assignment created." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
