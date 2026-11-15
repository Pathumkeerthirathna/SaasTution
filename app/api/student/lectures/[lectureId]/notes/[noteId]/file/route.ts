import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { emitStudentDataChange } from "@/lib/session-events";
import { prisma } from "@/lib/prisma";
import { openStoredFileForRead, storedFileAppError, storedFileResponse } from "@/lib/stored-files/stored-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
        storageKey: true,
        title: true,
        mimeType: true,
      },
    });

    if (!note) {
      throw new AppError("Note not found.", 404, "NOTE_NOT_FOUND");
    }

    // Mark this note as viewed by the student (idempotent). Only signal a
    // dashboard refresh when the row actually changed unviewed -> viewed.
    try {
      const existing = await prisma.noteStudent.findUnique({
        where: { noteId_studentId: { noteId, studentId: session.studentId } },
        select: { viewed: true },
      });
      if (!existing) {
        await prisma.noteStudent.create({
          data: { noteId, studentId: session.studentId, viewed: true, viewedAt: new Date() },
        });
        emitStudentDataChange({ studentId: session.studentId });
      } else if (!existing.viewed) {
        await prisma.noteStudent.update({
          where: { noteId_studentId: { noteId, studentId: session.studentId } },
          data: { viewed: true, viewedAt: new Date() },
        });
        emitStudentDataChange({ studentId: session.studentId });
      }
    } catch {
      /* viewing the file must not fail on a tracking hiccup */
    }

    // Unified storage: storageKey first, else the legacy fileUrl (incl. /uploads/); streamed.
    const file = await openStoredFileForRead("NOTE", note, { allowLegacyUploads: true }).catch((error) => {
      throw storedFileAppError(error, "The file is no longer available.");
    });

    const ext = file.extension || ".pdf";
    const safeName =
      (note.title
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "lecture-note") + ext;

    const encoded = encodeURIComponent(safeName);

    return storedFileResponse(file, {
      "Content-Type": note.mimeType || "application/pdf",
      "Content-Disposition": `inline; filename="${safeName}"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "private, no-store",
    });
  } catch (error) {
    return handleRouteError(error, { request: _request });
  }
}
