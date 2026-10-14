// The teacher shown on a student's stage while the teacher's camera is off
// (custom.js, SL_STAGE_VIEW). Plain JavaScript with JSDoc types so the same
// code runs in the app (useJitsi) and in the Node test runner (tests/jitsi).

/** Longest text sent to the iframe; custom.js applies the same cap. */
export const STAGE_TEACHER_MAX_TEXT = 200;

/**
 * @param {unknown} value
 * @returns {string}
 */
function cleanText(value) {
  return typeof value === "string" ? value.trim().slice(0, STAGE_TEACHER_MAX_TEXT) : "";
}

/**
 * The stored photo path ("/uploads/teachers/...") as an absolute URL on the
 * page's own origin: the Jitsi iframe is on another origin. Only http(s).
 *
 * @param {unknown} photoUrl
 * @param {string} origin
 * @returns {string | null}
 */
export function resolveStagePhotoUrl(photoUrl, origin) {
  const raw = cleanText(photoUrl);

  if (!raw) {
    return null;
  }

  try {
    const url = new URL(raw, origin);

    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Largest teacher photo handed to the iframe (bytes); bigger ones are skipped. */
export const STAGE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Fetches the teacher's photo on the SL Classroom page's own origin and
 * returns it as a Blob, or null (no photo, not an image, too big, failed).
 *
 * The Blob is posted into the Jitsi iframe, which shows it from an object
 * URL. The iframe then never has to load the image across origins itself,
 * which a browser can refuse: e.g. Chrome's Local Network Access blocks a
 * public site's iframe (meet.slclassroom.live) from loading http://localhost.
 *
 * @param {string | null | undefined} photoUrl Absolute or same-origin URL.
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [options]
 * @returns {Promise<Blob | null>}
 */
export async function fetchStagePhoto(photoUrl, options = {}) {
  const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch : null);

  if (!photoUrl || !fetchImpl) {
    return null;
  }

  try {
    const response = await fetchImpl(photoUrl, { credentials: "same-origin", signal: options.signal });

    if (!response.ok) {
      return null;
    }

    const blob = await response.blob();

    return blob && /^image\//i.test(blob.type) && blob.size > 0 && blob.size <= STAGE_PHOTO_MAX_BYTES
      ? blob
      : null;
  } catch {
    return null;
  }
}

/**
 * The SL_STAGE_VIEW `teacher` field, or null when the join info has no
 * teacher profile (custom.js then uses the teacher's Jitsi display name).
 *
 * @param {{
 *   teacherDisplayName?: string,
 *   teacherProfile?: { name: string, designation: string | null, photoUrl: string | null }
 * } | null | undefined} joinInfo
 * @param {string} origin The SL Classroom page's origin.
 * @returns {{ name: string, designation: string, photoUrl: string | null, jitsiName: string } | null}
 */
export function toStageTeacher(joinInfo, origin) {
  const profile = joinInfo?.teacherProfile;
  const name = cleanText(profile?.name);

  if (!profile || !name) {
    return null;
  }

  return {
    name,
    designation: cleanText(profile.designation),
    photoUrl: resolveStagePhotoUrl(profile.photoUrl, origin),
    // The teacher's Jitsi display name: custom.js shows this profile only on
    // the participant with exactly this name (not on a co-teacher).
    jitsiName: cleanText(joinInfo?.teacherDisplayName),
  };
}
