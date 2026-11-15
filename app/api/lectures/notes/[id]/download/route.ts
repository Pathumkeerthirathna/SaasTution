import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { openStoredFileForRead, storedFileAppError, storedFileResponse } from "@/lib/stored-files/stored-file";
import { getAndTrackNoteDownloadForTeacher } from "@/services/lecture-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveFileName(extension: string, title: string) {
  const baseTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "lecture-file";

  if (!extension) {
    return baseTitle;
  }

  return `${baseTitle}${extension}`;
}

export async function GET(
  _request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const session = await requireTeacherSession();
    const noteId = context.params.id;

    if (!noteId?.trim()) {
      throw new AppError("Note id is required.", 400, "VALIDATION_ERROR");
    }

    const note = await getAndTrackNoteDownloadForTeacher(session.teacherId, noteId);
    // Unified storage: storageKey first, else the legacy fileUrl (incl. /uploads/); streamed.
    const file = await openStoredFileForRead("NOTE", note, { allowLegacyUploads: true }).catch((error) => {
      throw storedFileAppError(error, "The file is no longer available.");
    });

    const fileName = resolveFileName(file.extension, note.title);
    const encodedFileName = encodeURIComponent(fileName);

    return storedFileResponse(file, {
      "Content-Type": note.mimeType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encodedFileName}`,
      "Cache-Control": "private, no-store",
    });
  } catch (error) {
    return handleRouteError(error, { request: _request });
  }
}
