import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { readProfilePhotoUpload } from "@/lib/profile-images/upload-request";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { removeTeacherProfilePhoto, uploadTeacherProfilePhoto } from "@/services/teacher-profile-photo-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * The signed-in teacher's OWN profile photo (the teacher comes only from the
 * session; no teacher id is ever read from the request).
 *
 *   GET     { profileImageUrl: string | null } (null = no photo: the UI shows
 *           its default avatar).
 *   PUT     multipart field "photo": JPEG / PNG / WebP (checked from the file's
 *           bytes), at most 2 MB (enforced while the body is read). Stored on
 *           unified storage, counted in the storage quota (PROFILE_IMAGE);
 *           replaces the previous photo only after the new one is saved.
 *           200 { profileImageUrl }; 413 PROFILE_PHOTO_TOO_LARGE / quota
 *           STORAGE_QUOTA_EXCEEDED; 415 PROFILE_PHOTO_INVALID_IMAGE /
 *           UNSUPPORTED_MEDIA_TYPE; 409 PROFILE_PHOTO_CONFLICT; 503.
 *   DELETE  removes it. 200 { removed: true, pending: false } or 202
 *           { removed: false, pending: true } (hidden; the file deletion is
 *           finished automatically).
 * Writes: same-origin (403) and the session (401) are checked BEFORE any of
 * the body is read. Responses are never cached.
 */

const noStore = (response: Response) => {
  response.headers.set("Cache-Control", "no-store");
  return response;
};

const crossOrigin = () =>
  noStore(apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED"));

export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();
    const profile = await prisma.teacherProfile.findUnique({
      where: { teacherId: session.teacherId },
      select: { profileImageUrl: true },
    });
    return noStore(Response.json({ profileImageUrl: profile?.profileImageUrl ?? null }));
  } catch (error) {
    return noStore(handleRouteError(error, { request }));
  }
}

export async function PUT(request: Request) {
  if (!checkSameOriginRequest(request).allowed) return crossOrigin();
  try {
    const session = await requireTeacherSession();
    const photo = await readProfilePhotoUpload(request);
    const result = await uploadTeacherProfilePhoto({ teacherId: session.teacherId, photo });
    return noStore(apiSuccess({ profileImageUrl: result.profileImageUrl }, { message: "Profile photo updated." }));
  } catch (error) {
    return noStore(handleRouteError(error, { request }));
  }
}

export async function DELETE(request: Request) {
  if (!checkSameOriginRequest(request).allowed) return crossOrigin();
  try {
    const session = await requireTeacherSession();
    const state = await removeTeacherProfilePhoto({ teacherId: session.teacherId });
    if (state === "PENDING") {
      return noStore(
        apiSuccess(
          { removed: false, pending: true, profileImageUrl: null },
          { message: "Your photo was removed from your profile. Its file is still being deleted and will be removed automatically.", status: 202 }
        )
      );
    }
    return noStore(apiSuccess({ removed: true, pending: false, profileImageUrl: null }, { message: "Profile photo removed." }));
  } catch (error) {
    return noStore(handleRouteError(error, { request }));
  }
}
