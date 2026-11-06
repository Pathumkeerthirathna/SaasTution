// GET  /api/sessions/[id]/breakout-activities/me/assignments/[assignmentId]/submissions
// POST /api/sessions/[id]/breakout-activities/me/assignments/[assignmentId]/submissions
//
// GET: the student's own submission versions, newest first.
// POST, multipart/form-data, strict fields:
//   idempotencyKey (required: a client-generated key, the same on a retry),
//   answerText (optional), file (optional PDF, max 25 MB).
// Text, a PDF or both. 201 with the submission; a retry with the same key
// returns the original one (also 201, replayed: true), whatever it carries.
// The file is passed on as received (size checked here, its type and
// content by the service after the idempotency lookup).

import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { assertOnlyFormFields, formFileUpload, formText, readMultipartBody } from "@/lib/breakout-activities/request-body";
import { listOwnSubmissions, submitAssignmentForStudent } from "@/services/breakout-student-assignment-service";

import { requireBreakoutStudent } from "../../../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; assignmentId: string } };

export async function GET(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    return apiSuccess(await listOwnSubmissions({ studentId, sessionId: context.params.id, assignmentId: context.params.assignmentId }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    const form = await readMultipartBody(request);
    assertOnlyFormFields(form, ["idempotencyKey", "answerText", "file"]);
    const result = await submitAssignmentForStudent({
      studentId,
      sessionId: context.params.id,
      assignmentId: context.params.assignmentId,
      idempotencyKey: formText(form, "idempotencyKey") ?? "",
      answerText: formText(form, "answerText") ?? null,
      file: await formFileUpload(form, "file"),
    });
    return apiSuccess(result, { status: 201, message: result.replayed ? "Already submitted." : "Submitted." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
