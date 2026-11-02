// Role-based video codec preferences for the Jitsi iframe (configOverwrite).
// Plain JavaScript with JSDoc types so the same code runs in the app
// (useJitsi) and in the Node test runner (tests/jitsi).
//
// Why: lib-jitsi-meet sends ONE camera codec to every receiver, the first
// codec of the sender's own order that every participant lists. An iPhone
// (WebKit) never lists AV1, and with Jitsi's default order the fallback is
// VP9, a switch Chrome refused on the live teacher sender
// (InvalidModificationError), leaving it on AV1 that the iPhone cannot decode.
//
//   Teacher: AV1 while every participant can decode it; VP8 (not VP9) as the
//            fallback when one cannot.
//   Student: VP8 first, so student cameras (watched by the teacher only) do
//            not switch codec when an iPhone joins or leaves.
//
// Only the order changes; no codec is disabled. Off unless the app is built
// with NEXT_PUBLIC_SL_ROLE_CODEC_ORDER=true: while off, nothing is added and
// Jitsi keeps its own default order.

/** The teacher's camera codec order (desktop; a teacher's phone keeps Jitsi's mobile default). */
export const TEACHER_CODEC_ORDER = Object.freeze(["AV1", "VP8", "VP9", "H264"]);

/** The students' camera codec order, on desktop and on phones alike. */
export const STUDENT_CODEC_ORDER = Object.freeze(["VP8", "VP9", "H264", "AV1"]);

/**
 * configOverwrite entries for the codec order: dotted keys, never a whole
 * `videoQuality` object, so the teacher's bitrate keys
 * (buildTeacherBitrateConfig) and every other video quality setting are
 * kept. lib-jitsi-meet reads `videoQuality.mobileCodecPreferenceOrder` on
 * Android / iOS and `videoQuality.codecPreferenceOrder` everywhere else.
 * Read when the Jitsi iframe is created (join).
 *
 * @param {string} role "teacher" | "student"; anything else gets nothing
 * @param {boolean} enabled the feature flag
 * @returns {Record<string, string[]>}
 */
export function buildCodecPreferenceConfig(role, enabled) {
  if (enabled !== true) {
    return {};
  }

  if (role === "teacher") {
    return { "videoQuality.codecPreferenceOrder": [...TEACHER_CODEC_ORDER] };
  }

  if (role === "student") {
    return {
      "videoQuality.codecPreferenceOrder": [...STUDENT_CODEC_ORDER],
      "videoQuality.mobileCodecPreferenceOrder": [...STUDENT_CODEC_ORDER],
    };
  }

  return {};
}
