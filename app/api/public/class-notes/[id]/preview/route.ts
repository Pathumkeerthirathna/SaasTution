import { readFile } from "node:fs/promises";
import path from "node:path";

import { AppError, handleRouteError } from "@/lib/error-handler";
import { getPublicFreeNote } from "@/services/class-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPLOADS_ROOT = path.join(process.cwd(), "public", "uploads");
const STORAGE_ROOT = path.join(process.cwd(), "storage");

function getFilePath(fileUrl: string): { filePath: string; allowedRoot: string } {
  if (fileUrl.startsWith("/uploads/")) {
    return {
      filePath: path.join(process.cwd(), "public", fileUrl),
      allowedRoot: UPLOADS_ROOT,
    };
  }

  return {
    filePath: path.join(process.cwd(), "storage", fileUrl),
    allowedRoot: STORAGE_ROOT,
  };
}

function assertPathInBounds(resolvedPath: string, allowedRoot: string) {
  const relative = path.relative(allowedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError("The requested file is not available.", 403, "FILE_ACCESS_DENIED");
  }
}

function resolveFileName(fileUrl: string, title: string) {
  const extension = path.extname(fileUrl);
  const baseTitle =
    title
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "lecture-note";

  return extension ? `${baseTitle}${extension}` : baseTitle;
}

export async function GET(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const { id } = context.params;

    if (!id?.trim()) {
      throw new AppError("Note id is required.", 400, "VALIDATION_ERROR");
    }

    const note = await getPublicFreeNote(id);
    const { filePath, allowedRoot } = getFilePath(note.fileUrl);
    assertPathInBounds(filePath, allowedRoot);

    const file = await readFile(filePath).catch(() => {
      throw new AppError("The file is no longer available.", 404, "FILE_NOT_FOUND");
    });

    const wantsDownload = new URL(request.url).searchParams.get("download") === "1";
    const fileName = resolveFileName(note.fileUrl, note.title);
    const encodedFileName = encodeURIComponent(fileName);
    const disposition = wantsDownload ? "attachment" : "inline";

    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": note.mimeType || "application/octet-stream",
        "Content-Length": String(file.byteLength),
        "Content-Disposition": `${disposition}; filename="${fileName}"; filename*=UTF-8''${encodedFileName}`,
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
