import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// PATCH — set (or clear) the marks for one bundle paper submission and mark
// it reviewed. `reviewedAt` is set whenever marks is a number, and cleared
// when marks is null (so it goes back to "not reviewed").
export async function PATCH(
  request: Request,
  context: { params: { bundleId: string; itemId: string; submissionId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const { bundleId, itemId, submissionId } = context.params;

    if (!bundleId?.trim() || !itemId?.trim() || !submissionId?.trim()) {
      throw new AppError("Bundle id, item id and submission id are required.", 400, "VALIDATION_ERROR");
    }

    const body = (await request.json()) as { marks?: unknown };
    const marks =
      body.marks === null || body.marks === undefined
        ? null
        : Math.max(0, Math.round(Number(body.marks)));

    if (marks !== null && Number.isNaN(marks)) {
      throw new AppError("Marks must be a number.", 400, "VALIDATION_ERROR");
    }

    const submission = await prisma.materialBundleItemSubmission.findFirst({
      where: {
        id: submissionId,
        itemId,
        item: {
          bundleId,
          status: 0,
          bundle: {
            status: 0,
            class: { teacherId: session.teacherId },
          },
        },
      },
      select: { id: true },
    });

    if (!submission) {
      throw new AppError("Submission not found.", 404, "SUBMISSION_NOT_FOUND");
    }

    const updated = await prisma.materialBundleItemSubmission.update({
      where: { id: submissionId },
      data: { marks, reviewedAt: marks === null ? null : new Date() },
      select: { id: true, marks: true, reviewedAt: true },
    });

    return apiSuccess(updated);
  } catch (error) {
    return handleRouteError(error);
  }
}
