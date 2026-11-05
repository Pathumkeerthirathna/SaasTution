// PATCH  /api/sessions/[id]/breakout-activities/assignments/[assignmentId]
// DELETE /api/sessions/[id]/breakout-activities/assignments/[assignmentId]
//
// PATCH, application/json, exactly one of:
//   { "action": "publish" | "close" }       this assignment only
//   { "title"?, "instructions"? }           DRAFT edits
// PATCH, multipart/form-data: a replacement brief (DRAFT only):
//   brief (PDF, required), title?, instructions?
// DELETE: DRAFT only, soft (status = 1).
// Not a DRAFT: 409 ACTIVITY_NOT_DRAFT (CLOSED: 409 ASSIGNMENT_CLOSED).

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { breakoutError } from "@/lib/breakout-activities/errors";
import { assertOnlyFormFields, formPdf, formText, readJsonBody, readMultipartBody } from "@/lib/breakout-activities/request-body";
import { assignmentBriefUpdateFieldsSchema, assignmentPatchSchema } from "@/lib/breakout-activities/validation";
import { deleteAssignment, editAssignment, setAssignmentState } from "@/services/breakout-assignment-service";

import { mediaType, parseWith, requireBreakoutTeacher } from "../../_shared/teacher-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; assignmentId: string } };

export async function PATCH(request: Request, context: Context) {
  try {
    const teacherId = await requireBreakoutTeacher();
    const target = { teacherId, sessionId: context.params.id, assignmentId: context.params.assignmentId };

    if (mediaType(request) === "multipart/form-data") {
      const form = await readMultipartBody(request);
      assertOnlyFormFields(form, ["brief", "title", "instructions"]);
      const fields = parseWith(assignmentBriefUpdateFieldsSchema, {
        title: formText(form, "title"),
        instructions: formText(form, "instructions"),
      });
      const brief = await formPdf(form, "brief");
      if (!brief) throw breakoutError("VALIDATION_ERROR", "Attach the new PDF brief.");
      return apiSuccess(await editAssignment({ ...target, ...fields, brief }), { message: "Assignment updated." });
    }

    const body = parseWith(assignmentPatchSchema, await readJsonBody(request));
    if ("action" in body) {
      return apiSuccess(await setAssignmentState({ ...target, action: body.action }));
    }
    return apiSuccess(await editAssignment({ ...target, ...body }), { message: "Assignment updated." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const teacherId = await requireBreakoutTeacher();
    const result = await deleteAssignment({ teacherId, sessionId: context.params.id, assignmentId: context.params.assignmentId });
    return apiSuccess(result, { message: "Assignment deleted." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
