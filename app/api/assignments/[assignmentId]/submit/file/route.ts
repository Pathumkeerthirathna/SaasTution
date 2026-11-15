import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { openStoredFileForRead, storedFileAppError, storedFileResponse } from "@/lib/stored-files/stored-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveDownloadFileName(fileName: string) {
  const safe = fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "assignment-submission.pdf";

  return safe.endsWith(".pdf") ? safe : `${safe}.pdf`;
}

export async function GET(
  _request: Request,
  context: { params: { assignmentId: string } }
) {
  try {
    const studentSession = await requireStudentSession();
    const assignmentId = context.params.assignmentId;

    if (!assignmentId?.trim()) {
      throw new AppError("Assignment id is required.", 400, "VALIDATION_ERROR");
    }

    const submission = await prisma.assignmentSubmission.findUnique({
      where: {
        assignmentId_studentId: {
          assignmentId,
          studentId: studentSession.studentId,
        },
      },
      select: {
        fileUrl: true,
        storageKey: true,
        fileName: true,
        mimeType: true,
      },
    });

    if (!submission) {
      throw new AppError("Submission not found.", 404, "SUBMISSION_NOT_FOUND");
    }

    // Unified storage: storageKey first, else the legacy fileUrl below <cwd>/storage (no /uploads/ branch, as before); streamed.
    const file = await openStoredFileForRead("SUBMISSION", submission, { allowLegacyUploads: false }).catch((error) => {
      throw storedFileAppError(error, "Submitted file is no longer available.");
    });

    const fileName = resolveDownloadFileName(submission.fileName);
    const encoded = encodeURIComponent(fileName);

    return storedFileResponse(file, {
      "Content-Type": submission.mimeType || "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "private, no-store",
    });
  } catch (error) {
    return handleRouteError(error, { request: _request });
  }
}
