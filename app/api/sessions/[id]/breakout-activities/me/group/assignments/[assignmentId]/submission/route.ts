// POST /api/sessions/[id]/breakout-activities/me/group/assignments/[assignmentId]/submission
// Student (any confirmed member of the assignment's room): the group's ONE
// final submission. multipart/form-data, strict fields:
//   revision (required: the work revision the student last saw),
//   file (optional PDF, max 25 MB).
// Submits the saved shared text (and/or the PDF). 201 with the submission;
// once submitted, every repeat returns it (replayed: true) and changes nothing.

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { assertOnlyFormFields, formFileUpload, formText, readMultipartBody } from "@/lib/breakout-activities/request-body";
import { parseRevisionField } from "@/lib/breakout-activities/groups/validation";
import { submitGroupAssignment } from "@/services/breakout-group-assignment-service";

import { requireBreakoutStudent } from "../../../../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; assignmentId: string } };

export async function POST(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    const form = await readMultipartBody(request);
    assertOnlyFormFields(form, ["revision", "file"]);
    const result = await submitGroupAssignment({
      studentId,
      sessionId: context.params.id,
      assignmentId: context.params.assignmentId,
      revision: parseRevisionField(formText(form, "revision")),
      file: await formFileUpload(form, "file"),
    });
    return apiSuccess(result, { status: 201, message: result.replayed ? "Already submitted." : "Submitted." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
