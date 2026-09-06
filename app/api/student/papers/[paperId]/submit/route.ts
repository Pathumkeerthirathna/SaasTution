import { unlink } from "node:fs/promises";

import { apiError, apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { assertPaperFile, resolveStoredFilePath, storePaperFile } from "@/lib/class-paper";
import { emitStudentDataChange } from "@/lib/session-events";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: { paperId: string } }
) {
  try {
    const session = await requireStudentSession();
    const form = await request.formData();
    const fileEntry = form.get("file");

    const row = await prisma.classPaperStudent.findFirst({
      where: {
        classPaperId: params.paperId,
        studentId: session.studentId,
        classPaper: {
          status: 0,
          class: { status: 0, students: { some: { studentId: session.studentId, isActive: true } } },
        },
      },
      select: {
        id: true,
        submissionPdfUrl: true,
        classPaper: { select: { startTime: true, endTime: true, classId: true } },
      },
    });

    if (!row) {
      throw new AppError("Paper not found.", 404, "PAPER_NOT_FOUND");
    }

    const now = Date.now();
    if (now < row.classPaper.startTime.getTime()) {
      return apiError("This paper is not open for submissions yet.", 400, "PAPER_NOT_OPEN");
    }
    if (now > row.classPaper.endTime.getTime()) {
      return apiError("The submission window for this paper has closed.", 400, "PAPER_CLOSED");
    }

    if (!(fileEntry instanceof File) || fileEntry.size === 0) {
      return apiError("Upload your answer file (PDF or image).", 400, "VALIDATION_ERROR");
    }
    const fileError = assertPaperFile(fileEntry);
    if (fileError) return apiError(fileError, 400, "VALIDATION_ERROR");

    const stored = await storePaperFile(fileEntry, [params.paperId, "submissions", session.studentId]);

    const updated = await prisma.classPaperStudent.update({
      where: { id: row.id },
      data: {
        submitted: true,
        submittedAt: new Date(),
        submissionPdfUrl: stored.fileUrl,
        submissionFileName: stored.fileName,
        submissionMimeType: stored.mimeType,
      },
      select: { id: true, submittedAt: true },
    });

    if (row.submissionPdfUrl && row.submissionPdfUrl !== stored.fileUrl) {
      const old = resolveStoredFilePath(row.submissionPdfUrl);
      if (old) await unlink(old).catch(() => undefined);
    }

    emitStudentDataChange({
      studentId: session.studentId,
      classId: row.classPaper.classId,
    });

    return apiSuccess(
      { submissionId: updated.id, submittedAt: updated.submittedAt?.toISOString() ?? null },
      { message: "Answer submitted." }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
