import { readFile } from "node:fs/promises";

import { requireAppSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { resolveStoredFilePath } from "@/lib/class-paper";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/class-papers/[paperId]/submissions/[submissionId]/file
// The owning teacher, or the student who made the submission, may view it.
export async function GET(
  _request: Request,
  { params }: { params: { paperId: string; submissionId: string } }
) {
  try {
    const session = await requireAppSession();

    if (session.role !== "TEACHER" && session.role !== "STUDENT") {
      throw new AppError("Not allowed.", 403, "FORBIDDEN");
    }

    const submission = await prisma.classPaperStudent.findFirst({
      where: {
        id: params.submissionId,
        classPaperId: params.paperId,
        classPaper:
          session.role === "TEACHER"
            ? { status: 0, class: { teacherId: session.userId } }
            : { status: 0 },
        ...(session.role === "STUDENT" ? { studentId: session.userId } : {}),
      },
      select: { submissionPdfUrl: true, submissionFileName: true, submissionMimeType: true },
    });

    if (!submission || !submission.submissionPdfUrl || !submission.submissionFileName) {
      throw new AppError("Submission file not found.", 404, "FILE_NOT_FOUND");
    }

    const filePath = resolveStoredFilePath(submission.submissionPdfUrl);
    if (!filePath) {
      throw new AppError("The requested file is not available.", 403, "FILE_ACCESS_DENIED");
    }

    const file = await readFile(filePath).catch(() => {
      throw new AppError("The file is no longer available.", 404, "FILE_NOT_FOUND");
    });

    const encoded = encodeURIComponent(submission.submissionFileName);
    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": submission.submissionMimeType || "application/octet-stream",
        "Content-Length": String(file.byteLength),
        "Content-Disposition": `inline; filename="${submission.submissionFileName}"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
