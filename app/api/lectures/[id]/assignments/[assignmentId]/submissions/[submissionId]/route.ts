import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// PATCH /api/lectures/[id]/assignments/[assignmentId]/submissions/[submissionId]
// Sets (or clears) the marks for one student's assignment submission.
export async function PATCH(
  request: Request,
  context: { params: { id: string; assignmentId: string; submissionId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const { id: lectureId, assignmentId, submissionId } = context.params;

    if (!lectureId?.trim() || !assignmentId?.trim() || !submissionId?.trim()) {
      throw new AppError(
        "Lecture id, assignment id and submission id are required.",
        400,
        "VALIDATION_ERROR"
      );
    }

    const body = (await request.json()) as { marks?: unknown };
    const marks =
      body.marks === null || body.marks === undefined
        ? null
        : Math.max(0, Math.round(Number(body.marks)));

    if (marks !== null && Number.isNaN(marks)) {
      throw new AppError("Marks must be a number.", 400, "VALIDATION_ERROR");
    }

    // Verify the submission belongs to an assignment/lecture owned by this teacher.
    const submission = await prisma.assignmentSubmission.findFirst({
      where: {
        id: submissionId,
        assignmentId,
        assignment: {
          lectureId,
          status: 0,
          lecture: {
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

    const updated = await prisma.assignmentSubmission.update({
      where: { id: submissionId },
      data: { marks, reviewedAt: marks === null ? null : new Date() },
      select: { id: true, marks: true, reviewedAt: true },
    });

    return apiSuccess(updated);
  } catch (error) {
    return handleRouteError(error);
  }
}
