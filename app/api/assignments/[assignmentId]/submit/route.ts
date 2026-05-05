import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { apiError, apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { submitAssignmentSchema } from "@/lib/lecture-validation";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PDF_MIME_TYPE = "application/pdf";
const MAX_PDF_SIZE_BYTES = 25 * 1024 * 1024;

function sanitizeFileName(fileName: string) {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function assertPathInBounds(resolvedPath: string, allowedRoot: string) {
  const relative = path.relative(allowedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError("The requested file is not available.", 403, "FILE_ACCESS_DENIED");
  }
}

// GET /api/assignments/[assignmentId]/submit
// Returns the current student's submission for this assignment, if any.
export async function GET(
  _request: Request,
  context: { params: { assignmentId: string } }
) {
  try {
    const studentSession = await requireStudentSession();
    const { assignmentId } = context.params;

    if (!assignmentId?.trim()) {
      throw new AppError("Assignment id is required.", 400, "VALIDATION_ERROR");
    }

    // Verify the assignment exists and belongs to one of the student's enrolled classes.
    const assignment = await prisma.assignment.findFirst({
      where: {
        id: assignmentId,
        lecture: {
          class: {
            students: {
              some: {
                studentId: studentSession.studentId,
                isActive: true,
              },
            },
          },
        },
      },
      select: { id: true },
    });

    if (!assignment) {
      throw new AppError("Assignment not found.", 404, "ASSIGNMENT_NOT_FOUND");
    }

    const submission = await prisma.assignmentSubmission.findUnique({
      where: {
        assignmentId_studentId: {
          assignmentId,
          studentId: studentSession.studentId,
        },
      },
      select: {
        id: true,
        notes: true,
        fileName: true,
        fileUrl: true,
        mimeType: true,
        sizeBytes: true,
        submittedAt: true,
      },
    });

    return apiSuccess({ submission: submission ?? null });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/assignments/[assignmentId]/submit
// Creates or replaces the current student's submission.
export async function POST(
  request: Request,
  context: { params: { assignmentId: string } }
) {
  try {
    const studentSession = await requireStudentSession();
    const { assignmentId } = context.params;

    if (!assignmentId?.trim()) {
      throw new AppError("Assignment id is required.", 400, "VALIDATION_ERROR");
    }

    const formData = await request.formData();
    const notes = String(formData.get("notes") ?? "").trim();
    const fileEntry = formData.get("file");
    const body = { notes: notes || undefined };
    const parsed = submitAssignmentSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    if (!(fileEntry instanceof File)) {
      return apiError("PDF file is required.", 400, "VALIDATION_ERROR");
    }

    if (fileEntry.type !== PDF_MIME_TYPE) {
      return apiError("Only PDF files are allowed for assignment submissions.", 400, "UNSUPPORTED_FILE_TYPE");
    }

    if (fileEntry.size > MAX_PDF_SIZE_BYTES) {
      return apiError("PDF file exceeds size limit of 25 MB.", 400, "FILE_TOO_LARGE");
    }

    // Verify the assignment exists and belongs to one of the student's enrolled classes.
    const assignment = await prisma.assignment.findFirst({
      where: {
        id: assignmentId,
        lecture: {
          class: {
            students: {
              some: {
                studentId: studentSession.studentId,
                isActive: true,
              },
            },
          },
        },
      },
      select: { id: true, dueDate: true },
    });

    if (!assignment) {
      throw new AppError("Assignment not found.", 404, "ASSIGNMENT_NOT_FOUND");
    }

    const bytes = new Uint8Array(await fileEntry.arrayBuffer());
    const safeFileName = sanitizeFileName(fileEntry.name || "submission.pdf") || "submission.pdf";
    const uniquePrefix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const storedFileName = `${uniquePrefix}-${safeFileName.endsWith(".pdf") ? safeFileName : `${safeFileName}.pdf`}`;

    const uploadDir = path.join(process.cwd(), "storage", "assignments", assignmentId);
    await mkdir(uploadDir, { recursive: true });

    const fullFilePath = path.join(uploadDir, storedFileName);
    await writeFile(fullFilePath, bytes);
    const fileUrl = `assignments/${assignmentId}/${storedFileName}`;

    const existingSubmission = await prisma.assignmentSubmission.findUnique({
      where: {
        assignmentId_studentId: {
          assignmentId,
          studentId: studentSession.studentId,
        },
      },
      select: {
        fileUrl: true,
      },
    });

    // Upsert so re-submissions overwrite the previous one.
    const submission = await prisma.assignmentSubmission.upsert({
      where: {
        assignmentId_studentId: {
          assignmentId,
          studentId: studentSession.studentId,
        },
      },
      create: {
        assignmentId,
        studentId: studentSession.studentId,
        fileName: fileEntry.name || "submission.pdf",
        fileUrl,
        mimeType: fileEntry.type,
        sizeBytes: fileEntry.size,
        notes: parsed.data.notes ?? null,
        submittedAt: new Date(),
      },
      update: {
        fileName: fileEntry.name || "submission.pdf",
        fileUrl,
        mimeType: fileEntry.type,
        sizeBytes: fileEntry.size,
        notes: parsed.data.notes ?? null,
        submittedAt: new Date(),
      },
      select: {
        id: true,
        notes: true,
        fileName: true,
        fileUrl: true,
        mimeType: true,
        sizeBytes: true,
        submittedAt: true,
      },
    });

    if (existingSubmission?.fileUrl && existingSubmission.fileUrl !== fileUrl) {
      const oldPath = path.join(process.cwd(), "storage", existingSubmission.fileUrl);
      const root = path.join(process.cwd(), "storage");
      assertPathInBounds(oldPath, root);
      await unlink(oldPath).catch(() => undefined);
    }

    return apiSuccess({ submission }, { message: "Assignment submitted successfully.", status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
