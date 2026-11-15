import { handleRouteError } from "@/lib/error-handler";
import { openLegacyTeacherPhoto, storedFileAppError, storedFileResponse } from "@/lib/stored-files/stored-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * GET /uploads/teachers/{name}: LEGACY teacher profile photos (uploaded before
 * unified storage; <cwd>/storage/teachers). Kept so existing profileImageUrl
 * values keep working; new photos use /api/teacher-photos/... .
 *
 * Hardened: the name must match the old naming exactly ({teacher id}-{time}
 * .{jpg|jpeg|png|webp|gif}): no separators, dots, encodings or absolute paths
 * can reach the filesystem, and SVG (script-capable) is never served. The file
 * is opened by the confined legacy reader (inside the folder, no link
 * followed). The type comes from the allowed extension, never sniffed, and a
 * sandboxing CSP applies. Legacy names are unique per upload (time in the
 * name), so they stay immutable.
 */

const TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

const notFound = () =>
  new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });

export async function GET(request: Request, context: { params: { filename: string } }) {
  const name = context.params?.filename;
  const extension = typeof name === "string" ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const type = Object.hasOwn(TYPES, extension) ? TYPES[extension] : null;
  if (!type) return notFound();
  try {
    const file = await openLegacyTeacherPhoto(name);
    return storedFileResponse(file, {
      "Content-Type": type,
      "Content-Disposition": "inline",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
  } catch (error) {
    const appError = storedFileAppError(error, "Not Found");
    if (appError !== error && (appError as { statusCode?: number }).statusCode === 404) return notFound();
    if (appError !== error && (appError as { statusCode?: number }).statusCode === 403) return notFound();
    const response = handleRouteError(appError, { request });
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
