import { readFile } from "node:fs/promises";
import path from "node:path";

import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertPathInBounds(resolvedPath: string, allowedRoot: string) {
  const relative = path.relative(allowedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError("The requested file is not available.", 403, "FILE_ACCESS_DENIED");
  }
}

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
        fileName: true,
        mimeType: true,
      },
    });

    if (!submission) {
      throw new AppError("Submission not found.", 404, "SUBMISSION_NOT_FOUND");
    }

    const root = path.join(process.cwd(), "storage");
    const filePath = path.join(root, submission.fileUrl);
    assertPathInBounds(filePath, root);

    const file = await readFile(filePath).catch(() => {
      throw new AppError("Submitted file is no longer available.", 404, "FILE_NOT_FOUND");
    });

    const fileName = resolveDownloadFileName(submission.fileName);
    const encoded = encodeURIComponent(fileName);

    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": submission.mimeType || "application/pdf",
        "Content-Length": String(file.byteLength),
        "Content-Disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
