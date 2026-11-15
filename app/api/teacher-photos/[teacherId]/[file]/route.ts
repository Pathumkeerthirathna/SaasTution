import { handleRouteError } from "@/lib/error-handler";
import { storedFileAppError, storedFileResponse } from "@/lib/stored-files/stored-file";
import { openTeacherProfilePhoto } from "@/services/teacher-profile-photo-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * GET /api/teacher-photos/{teacherId}/{32 hex}.{jpg|png|webp}: a teacher's
 * CURRENT profile photo from unified storage (the URL stored in
 * TeacherProfile.profileImageUrl). Public, like the legacy photo URLs (the
 * photo is shown on public profiles, search results and in live sessions).
 *
 * Both segments are validated strictly (no dots, separators or encodings can
 * reach a path), the key is rebuilt from them and must be the one the
 * teacher's row references (a replaced, removed or unknown photo is 404). The
 * stored name is unique per upload, so the response is immutable. Security
 * headers: the stored type only (never sniffed), a sandboxing CSP, inline.
 */

const notFound = () =>
  new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });

export async function GET(request: Request, context: { params: { teacherId: string; file: string } }) {
  try {
    const found = await openTeacherProfilePhoto(context.params?.teacherId, context.params?.file);
    if (!found) return notFound();
    return storedFileResponse(found.file, {
      "Content-Type": found.mimeType,
      "Content-Disposition": "inline",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${found.sha256}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
  } catch (error) {
    // A missing / unreadable file is 404, storage problems 503 (never a path or detail).
    const response = handleRouteError(storedFileAppError(error, "The photo is not available."), { request });
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
