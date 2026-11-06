// GET /api/sessions/[id]/breakout-activities/me/assignments/[assignmentId]/submissions/[submissionId]/file
// Student: the PDF of one of the student's OWN submissions (attachment).
// Anyone else's submission is 404.

import { handleRouteError } from "@/lib/error-handler";
import { getOwnSubmissionFile } from "@/services/breakout-student-assignment-service";

import { pdfResponse, requireBreakoutStudent } from "../../../../../_shared/student-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: { id: string; assignmentId: string; submissionId: string } };

export async function GET(request: Request, context: Context) {
  try {
    const studentId = await requireBreakoutStudent();
    return pdfResponse(
      await getOwnSubmissionFile({
        studentId,
        sessionId: context.params.id,
        assignmentId: context.params.assignmentId,
        submissionId: context.params.submissionId,
      })
    );
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
