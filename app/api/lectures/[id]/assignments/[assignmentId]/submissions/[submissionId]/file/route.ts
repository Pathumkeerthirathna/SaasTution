import { readFile } from "node:fs/promises";
import path from "node:path";

import { requireTeacherSession } from "@/lib/auth-session";
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

function resolveDownloadFileName(fileName: string, studentName: string) {
  const safeName = studentName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const safeFile = fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "submission.pdf";

  return `${safeName}-${safeFile.endsWith(".pdf") ? safeFile : `${safeFile}.pdf`}`;
}

// GET /api/lectures/[id]/assignments/[assignmentId]/submissions/[submissionId]/file
// Downloads a student's submission PDF. Teacher auth — must own the lecture.
export async function GET(
  _request: Request,
  context: { params: { id: string; assignmentId: string; submissionId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const { id: lectureId, assignmentId, submissionId } = context.params;

    if (!lectureId?.trim() || !assignmentId?.trim() || !submissionId?.trim()) {
      throw new AppError("Required ids are missing.", 400, "VALIDATION_ERROR");
    }

    // Verify the submission belongs to an assignment on a lecture owned by this teacher.
    const submission = await prisma.assignmentSubmission.findFirst({
      where: {
        id: submissionId,
        assignmentId,
        assignment: {
          lectureId,
          lecture: {
            class: {
              teacherId: session.teacherId,
            },
          },
        },
      },
      select: {
        fileUrl: true,
        fileName: true,
        mimeType: true,
        student: {
          select: { name: true },
        },
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

    const downloadName = resolveDownloadFileName(submission.fileName, submission.student.name);
    const encoded = encodeURIComponent(downloadName);

    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": submission.mimeType || "application/pdf",
        "Content-Length": String(file.byteLength),
        "Content-Disposition": `attachment; filename="${downloadName}"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
