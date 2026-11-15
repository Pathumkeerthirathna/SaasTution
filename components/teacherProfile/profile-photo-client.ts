/*
 * Teacher profile photo: the browser side of PUT / DELETE
 * /api/teacher/profile/photo. Pure helpers (injectable XHR / fetch) so they
 * can be tested without a browser. The server re-checks everything (type
 * from the file's bytes, 2 MB, quota); these checks only give faster,
 * clearer feedback.
 */

export const PROFILE_PHOTO_ENDPOINT = "/api/teacher/profile/photo";
export const PROFILE_PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";
export const PROFILE_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(PROFILE_PHOTO_ACCEPT.split(","));

/** A chosen file before cropping: a supported image type (the cropped upload's size is checked separately). */
export function validateSelectedPhoto(file: { type: string }): string | null {
  return ACCEPTED_TYPES.has(file.type) ? null : "Choose a JPEG, PNG or WebP image.";
}

/** The cropped photo about to be uploaded. */
export function validatePhotoUpload(blob: { size: number }): string | null {
  if (blob.size <= 0) return "The photo could not be prepared. Please choose it again.";
  if (blob.size > PROFILE_PHOTO_MAX_BYTES) return "The photo is larger than 2 MB. Zoom in or choose a smaller image.";
  return null;
}

type ErrorBody = { success?: boolean; message?: string; error?: { code?: string; message?: string } } | null;

/** A user-facing message for a failed photo request (server message when it gave one). */
export function photoErrorMessage(status: number, body: ErrorBody, fallback: string): string {
  const code = body?.error?.code;
  if (code === "STORAGE_QUOTA_EXCEEDED") return body?.error?.message ?? "Your storage is full. Free up space or ask an administrator to increase your limit.";
  if (code === "PROFILE_PHOTO_TOO_LARGE" || status === 413) return "The photo is larger than 2 MB. Zoom in or choose a smaller image.";
  if (code === "PROFILE_PHOTO_INVALID_IMAGE" || status === 415) return "Upload a JPEG, PNG or WebP image.";
  if (status === 401) return "Your session has ended. Please sign in again.";
  if (status === 0) return "Network error. Check your connection and try again.";
  return body?.error?.message ?? fallback;
}

// ---- Upload (XHR: upload progress) ------------------------------------------------------------------------

export type XhrLike = {
  open(method: string, url: string): void;
  send(body: FormData): void;
  setRequestHeader?(name: string, value: string): void;
  responseText: string;
  status: number;
  withCredentials?: boolean;
  upload?: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort?: (() => void) | null;
};

export type PhotoResult = { ok: true; profileImageUrl: string } | { ok: false; message: string };

export function uploadProfilePhotoRequest(
  photo: Blob,
  options: { onProgress?: (percent: number) => void; createXhr?: () => XhrLike; fileName?: string } = {}
): Promise<PhotoResult> {
  return new Promise((resolve) => {
    const xhr = options.createXhr ? options.createXhr() : (new XMLHttpRequest() as unknown as XhrLike);
    const form = new FormData();
    form.append("photo", photo, options.fileName ?? "profile-photo");
    xhr.open("PUT", PROFILE_PHOTO_ENDPOINT);
    if (xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) options.onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      };
    }
    xhr.onload = () => {
      let body: (ErrorBody & { data?: { profileImageUrl?: unknown } }) | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      const url = body?.data?.profileImageUrl;
      if (xhr.status >= 200 && xhr.status < 300 && body?.success && typeof url === "string") {
        resolve({ ok: true, profileImageUrl: url });
      } else {
        resolve({ ok: false, message: photoErrorMessage(xhr.status, body, "Failed to upload the photo.") });
      }
    };
    xhr.onerror = () => resolve({ ok: false, message: photoErrorMessage(0, null, "Failed to upload the photo.") });
    xhr.onabort = () => resolve({ ok: false, message: "The upload was cancelled." });
    xhr.send(form);
  });
}

// ---- Remove ------------------------------------------------------------------------------------------------

export type RemoveResult = { ok: true; pending: boolean; message: string } | { ok: false; message: string };

export async function removeProfilePhotoRequest(options: { fetchImpl?: (url: string, init?: RequestInit) => Promise<Response> } = {}): Promise<RemoveResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(PROFILE_PHOTO_ENDPOINT, { method: "DELETE", credentials: "same-origin" });
  } catch {
    return { ok: false, message: photoErrorMessage(0, null, "Failed to remove the photo.") };
  }
  let body: (ErrorBody & { data?: { removed?: unknown; pending?: unknown } }) | null = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status === 200 && body?.success && body.data?.removed === true) return { ok: true, pending: false, message: "Profile photo removed." };
  if (response.status === 202 && body?.success && body.data?.pending === true) {
    return { ok: true, pending: true, message: "Your photo was removed from your profile. Its file is still being deleted and will be removed automatically." };
  }
  return { ok: false, message: photoErrorMessage(response.status, body, "Failed to remove the photo.") };
}
