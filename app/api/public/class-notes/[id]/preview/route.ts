import { AppError, handleRouteError } from "@/lib/error-handler";
import { openStoredFileForRead, storedFileAppError, storedFileResponse } from "@/lib/stored-files/stored-file";
import { getPublicFreeNote } from "@/services/class-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveFileName(extension: string, title: string) {
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
    // Unified storage: storageKey first, else the legacy fileUrl (incl. /uploads/); streamed.
    const file = await openStoredFileForRead("NOTE", note, { allowLegacyUploads: true }).catch((error) => {
      throw storedFileAppError(error, "The file is no longer available.");
    });

    const wantsDownload = new URL(request.url).searchParams.get("download") === "1";
    const fileName = resolveFileName(file.extension, note.title);
    const encodedFileName = encodeURIComponent(fileName);
    const disposition = wantsDownload ? "attachment" : "inline";

    return storedFileResponse(file, {
      "Content-Type": note.mimeType || "application/octet-stream",
      "Content-Disposition": `${disposition}; filename="${fileName}"; filename*=UTF-8''${encodedFileName}`,
      "Cache-Control": "public, max-age=0, must-revalidate",
    });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
