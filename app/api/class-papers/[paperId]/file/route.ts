import { readFile } from "node:fs/promises";

import { requireAppSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { resolveStoredFilePath } from "@/lib/class-paper";
import { getPaperFileForViewer } from "@/services/class-paper-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/class-papers/[paperId]/file — inline preview of the paper file.
// Accessible to the owning teacher and any enrolled student.
export async function GET(
  _request: Request,
  { params }: { params: { paperId: string } }
) {
  try {
    const session = await requireAppSession();
    if (session.role !== "TEACHER" && session.role !== "STUDENT") {
      throw new AppError("Not allowed.", 403, "FORBIDDEN");
    }

    const paper = await getPaperFileForViewer(
      session.role === "TEACHER"
        ? { role: "TEACHER", teacherId: session.userId }
        : { role: "STUDENT", studentId: session.userId },
      params.paperId
    );

    if (!paper) {
      throw new AppError("Paper not found.", 404, "PAPER_NOT_FOUND");
    }

    const filePath = resolveStoredFilePath(paper.pdfUrl);
    if (!filePath) {
      throw new AppError("The requested file is not available.", 403, "FILE_ACCESS_DENIED");
    }

    const file = await readFile(filePath).catch(() => {
      throw new AppError("The file is no longer available.", 404, "FILE_NOT_FOUND");
    });

    const encoded = encodeURIComponent(paper.pdfName);
    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": paper.pdfMimeType || "application/octet-stream",
        "Content-Length": String(file.byteLength),
        "Content-Disposition": `inline; filename="${paper.pdfName}"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
