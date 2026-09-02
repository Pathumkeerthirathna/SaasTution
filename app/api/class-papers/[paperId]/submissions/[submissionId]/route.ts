import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { setPaperSubmissionMarks } from "@/services/class-paper-service";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: { paperId: string; submissionId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const body = (await request.json()) as { marks?: number | string | null };

    let marks: number | null = null;
    if (body.marks !== null && body.marks !== undefined && String(body.marks).trim() !== "") {
      const parsed = Number(body.marks);
      if (!Number.isFinite(parsed)) {
        return apiError("Marks must be a number.", 400, "VALIDATION_ERROR");
      }
      marks = parsed;
    }

    const result = await setPaperSubmissionMarks(
      session.teacherId,
      params.paperId,
      params.submissionId,
      marks
    );
    return apiSuccess(result, { message: "Marks saved." });
  } catch (error) {
    return handleRouteError(error);
  }
}
