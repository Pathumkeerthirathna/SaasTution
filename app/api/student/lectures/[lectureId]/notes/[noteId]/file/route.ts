import { readFile } from "node:fs/promises";
import path from "node:path";

import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";

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

// GET /api/student/lectures/[lectureId]/notes/[noteId]/file
// Streams the note file inline (for preview). Student must be enrolled.
export async function GET(
  _request: Request,
  context: { params: { lectureId: string; noteId: string } }
) {
  try {
    const session = await requireStudentSession();
    const { lectureId, noteId } = context.params;

    if (!lectureId?.trim() || !noteId?.trim()) {
      throw new AppError("Required ids are missing.", 400, "VALIDATION_ERROR");
    }

    const note = await prisma.note.findFirst({
      where: {
        id: noteId,
        lectureId,
        status: 0,
        lecture: {
          status: 0,
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
        fileUrl: true,
        title: true,
        mimeType: true,
      },
    });

    if (!note) {
      throw new AppError("Note not found.", 404, "NOTE_NOT_FOUND");
    }

    const { filePath, allowedRoot } = getFilePath(note.fileUrl);
    assertPathInBounds(filePath, allowedRoot);

    const file = await readFile(filePath).catch(() => {
      throw new AppError("The file is no longer available.", 404, "FILE_NOT_FOUND");
    });

    const ext = path.extname(note.fileUrl) || ".pdf";
    const safeName =
      (note.title
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "lecture-note") + ext;

    const encoded = encodeURIComponent(safeName);

    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": note.mimeType || "application/pdf",
        "Content-Length": String(file.byteLength),
        "Content-Disposition": `inline; filename="${safeName}"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
