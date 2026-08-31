import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { apiError, apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CreatedSubmission = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  submittedAt: Date;
};

const PDF_MIME_TYPE = "application/pdf";
const MAX_PDF_SIZE_BYTES = 25 * 1024 * 1024;
const DEFAULT_GRACE_MINUTES = 20;

function sanitizeFileName(fileName: string) {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function POST(
  request: Request,
  context: { params: { bundleId: string; itemId: string } }
) {
  try {
    const session = await requireStudentSession();
    const { bundleId, itemId } = context.params;

    if (!bundleId?.trim() || !itemId?.trim()) {
      throw new AppError("Bundle id and item id are required.", 400, "VALIDATION_ERROR");
    }

    const item = await prisma.materialBundleItem.findFirst({
      where: {
        id: itemId,
        bundleId,
        type: "PAPER",
        status: 0,
        bundle: {
          bundleStatus: "SENT",
          status: 0,
          recipients: {
            some: {
              studentId: session.studentId,
              willReceive: true,
            },
          },
          class: {
            students: {
              some: {
                studentId: session.studentId,
                isActive: true,
              },
            },
          },
        },
      },
      select: {
        id: true,
        paperStartAt: true,
        paperEndAt: true,
        bundle: {
          select: {
            class: {
              select: {
                teacher: {
                  select: {
                    paperConfig: {
                      select: {
                        submissionGraceMinutes: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!item) {
      throw new AppError("Paper item not found.", 404, "BUNDLE_ITEM_NOT_FOUND");
    }

    if (!item.paperStartAt || !item.paperEndAt) {
      throw new AppError("Paper window is not configured yet.", 400, "PAPER_WINDOW_NOT_SET");
    }

    const now = new Date();
    const graceMinutes = item.bundle.class.teacher.paperConfig?.submissionGraceMinutes ?? DEFAULT_GRACE_MINUTES;
    const submissionDeadline = new Date(item.paperEndAt.getTime() + graceMinutes * 60 * 1000);

    if (now < item.paperStartAt) {
      return apiError("Paper has not started yet.", 400, "PAPER_NOT_STARTED");
    }

    if (now > submissionDeadline) {
      return apiError(
        "Submission window has closed. Send a reason message to the teacher.",
        400,
        "PAPER_SUBMISSION_CLOSED",
      );
    }

    const formData = await request.formData();
    const fileEntry = formData.get("file");

    if (!(fileEntry instanceof File)) {
      return apiError("PDF file is required.", 400, "VALIDATION_ERROR");
    }

    if (fileEntry.type !== PDF_MIME_TYPE) {
      return apiError("Only PDF files are allowed for submissions.", 400, "UNSUPPORTED_FILE_TYPE");
    }

    if (fileEntry.size > MAX_PDF_SIZE_BYTES) {
      return apiError("PDF file exceeds size limit of 25 MB.", 400, "FILE_TOO_LARGE");
    }

    const bytes = new Uint8Array(await fileEntry.arrayBuffer());
    const safeFileName = sanitizeFileName(fileEntry.name || "submission.pdf") || "submission.pdf";
    const uniquePrefix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const storedFileName = `${uniquePrefix}-${safeFileName.endsWith(".pdf") ? safeFileName : `${safeFileName}.pdf`}`;

    const uploadDir = path.join(process.cwd(), "storage", "material-bundle-submissions", itemId, session.studentId);
    await mkdir(uploadDir, { recursive: true });

    const fullFilePath = path.join(uploadDir, storedFileName);
    await writeFile(fullFilePath, bytes);

    const fileUrl = `material-bundle-submissions/${itemId}/${session.studentId}/${storedFileName}`;

    const submissionDelegate = (prisma as {
      materialBundleItemSubmission?: {
        create: (...args: unknown[]) => Promise<CreatedSubmission>;
      };
    })
      .materialBundleItemSubmission;

    if (!submissionDelegate) {
      throw new AppError(
        "Submission feature is not available because Prisma client is outdated. Run `npx prisma generate` and restart the dev server.",
        503,
        "PRISMA_CLIENT_OUTDATED"
      );
    }

    const submission = await submissionDelegate.create({
      data: {
        itemId,
        studentId: session.studentId,
        fileName: fileEntry.name || "submission.pdf",
        fileUrl,
        mimeType: fileEntry.type,
        sizeBytes: fileEntry.size,
        submittedAt: new Date(),
      },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        sizeBytes: true,
        submittedAt: true,
      },
    });

    return apiSuccess(
      {
        submission: {
          ...submission,
          isLate: submission.submittedAt > item.paperEndAt,
          submissionDeadline,
        },
      },
      { status: 201, message: "Submission uploaded successfully." }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
