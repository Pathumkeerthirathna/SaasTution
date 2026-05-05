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
      .replace(/^-|-$/g, "") || "bundle-item.pdf";

  return safe.endsWith(".pdf") ? safe : `${safe}.pdf`;
}

export async function GET(
  request: Request,
  context: { params: { bundleId: string; itemId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const { bundleId, itemId } = context.params;

    if (!bundleId?.trim() || !itemId?.trim()) {
      throw new AppError("Bundle id and item id are required.", 400, "VALIDATION_ERROR");
    }

    const item = await prisma.materialBundleItem.findFirst({
      where: {
        id: itemId,
        bundleId,
        bundle: {
          class: {
            teacherId: session.teacherId,
          },
        },
      },
      select: {
        fileUrl: true,
        fileName: true,
        mimeType: true,
      },
    });

    if (!item || !item.fileUrl || !item.fileName) {
      throw new AppError("Bundle file not found.", 404, "FILE_NOT_FOUND");
    }

    const filePath = path.join(STORAGE_ROOT, item.fileUrl);
    assertPathInBounds(filePath, STORAGE_ROOT);

    const file = await readFile(filePath).catch(() => {
      throw new AppError("Bundle file is no longer available.", 404, "FILE_NOT_FOUND");
    });

    const asDownload = new URL(request.url).searchParams.get("download") === "1";
    const fileName = resolveDownloadFileName(item.fileName);
    const encoded = encodeURIComponent(fileName);

    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": item.mimeType || "application/pdf",
        "Content-Length": String(file.byteLength),
        "Content-Disposition": `${asDownload ? "attachment" : "inline"}; filename="${fileName}"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
