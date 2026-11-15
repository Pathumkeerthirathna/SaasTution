import { AppError } from "@/lib/error-handler";
import { PROFILE_PHOTO_MAX_BYTES } from "@/lib/profile-images/storage-keys";

/*
 * Profile photo upload: the multipart request body, read with a HARD byte
 * limit. The limit is enforced while the body is read (Content-Length first,
 * then every chunk), so an oversized request is refused without reading it
 * to the end; request.formData() alone would buffer any size. At most
 * PROFILE_PHOTO_MAX_BYTES (2 MB) of photo plus a small allowance for the
 * multipart framing is ever held in memory. Call it only AFTER the session
 * and origin checks.
 */

/** Room for the multipart boundary and part headers around the photo. */
export const MULTIPART_OVERHEAD_BYTES = 16 * 1024;
export const PROFILE_PHOTO_FIELD = "photo";

export const profilePhotoTooLargeError = () =>
  new AppError("The photo is larger than 2 MB. Choose a smaller image.", 413, "PROFILE_PHOTO_TOO_LARGE");
const invalidRequest = (message: string) => new AppError(message, 400, "VALIDATION_ERROR", { field: PROFILE_PHOTO_FIELD });

/**
 * The uploaded photo (a Blob of at most `maxBytes`), or an AppError:
 * 415 for a non-multipart body, 413 PROFILE_PHOTO_TOO_LARGE, 400
 * VALIDATION_ERROR (no photo, empty photo, unreadable body).
 */
export async function readProfilePhotoUpload(request: Request, options: { maxBytes?: number } = {}): Promise<Blob> {
  const maxBytes = options.maxBytes ?? PROFILE_PHOTO_MAX_BYTES;
  const limit = maxBytes + MULTIPART_OVERHEAD_BYTES;

  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) {
    throw new AppError("Send the photo as a file upload.", 415, "UNSUPPORTED_MEDIA_TYPE");
  }

  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > limit) throw profilePhotoTooLargeError();

  if (!request.body) throw invalidRequest("A photo is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel().catch(() => undefined);
        throw profilePhotoTooLargeError();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidRequest("The upload could not be read. Please try again.");
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw invalidRequest("The upload could not be read. Please try again.");
  }

  const photo = form.get(PROFILE_PHOTO_FIELD);
  if (!(photo instanceof Blob)) throw invalidRequest("A photo is required.");
  if (photo.size === 0) throw invalidRequest("The photo is empty.");
  if (photo.size > maxBytes) throw profilePhotoTooLargeError();
  return photo;
}
