import { readFile } from "node:fs/promises";
import path from "node:path";

import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STORAGE_ROOT = path.join(process.cwd(), "storage");

function assertPathInBounds(resolvedPath: string, allowedRoot: string) {
  const relative = path.relative(allowedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError("The requested file is not available.", 403, "FILE_ACCESS_DENIED");
  }
}

function resolveDownloadFileName(fileName: string) {
  const safe =
    fileName
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "submission.pdf";

  return safe.endsWith(".pdf") ? safe : `${safe}.pdf`;
}

export async function GET(
  request: Request,
  context: { params: { bundleId: string; itemId: string; submissionId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const { bundleId, itemId, submissionId } = context.params;

    if (!bundleId?.trim() || !itemId?.trim() || !submissionId?.trim()) {
      throw new AppError("Bundle id, item id and submission id are required.", 400, "VALIDATION_ERROR");
    }

    const submissionDelegate = (prisma as { materialBundleItemSubmission?: { findFirst: (...args: unknown[]) => unknown } })
      .materialBundleItemSubmission;

    if (!submissionDelegate) {
      throw new AppError(
        "Submission feature is not available because Prisma client is outdated. Run `npx prisma generate` and restart the dev server.",
        503,
        "PRISMA_CLIENT_OUTDATED"
      );
    }

    const submission = await submissionDelegate.findFirst({
      where: {
        id: submissionId,
        itemId,
        item: {
          bundleId,
          bundle: {
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
      },
    });

    if (!submission) {
      throw new AppError("Submission file not found.", 404, "FILE_NOT_FOUND");
    }

    const filePath = path.join(STORAGE_ROOT, submission.fileUrl);
    assertPathInBounds(filePath, STORAGE_ROOT);

    const file = await readFile(filePath).catch(() => {
      throw new AppError("Submission file is no longer available.", 404, "FILE_NOT_FOUND");
    });

    const asDownload = new URL(request.url).searchParams.get("download") === "1";
    const fileName = resolveDownloadFileName(submission.fileName);
    const encoded = encodeURIComponent(fileName);

    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": submission.mimeType || "application/pdf",
        "Content-Length": String(file.byteLength),
        "Content-Disposition": `${asDownload ? "attachment" : "inline"}; filename="${fileName}"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
