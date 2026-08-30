import { readFile } from "node:fs/promises";
import path from "node:path";

import { AppError, handleRouteError } from "@/lib/error-handler";
import { getAnnouncementImagePath } from "@/services/teacher-announcement-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export async function GET(
  _request: Request,
  context: { params: { id: string } }
) {
  try {
    const { id } = context.params;

    if (!id?.trim()) {
      throw new AppError("Announcement id is required.", 400, "VALIDATION_ERROR");
    }

    const { filePath, imageName } = await getAnnouncementImagePath(id);

    const file = await readFile(filePath).catch(() => {
      throw new AppError("The image is no longer available.", 404, "FILE_NOT_FOUND");
    });

    const ext = path.extname(imageName).toLowerCase();

    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
        "Content-Length": String(file.byteLength),
        "Content-Disposition": "inline",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
