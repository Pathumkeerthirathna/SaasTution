// Teacher camera preferences: maximum send quality and Teaching Mode's frame
// rate / detail hint. Plain JavaScript with JSDoc types so the same code runs
// in the app (useJitsi, JitsiClassroom, SidebarNav) and in the Node test
// runner (tests/jitsi). Display / preference logic only: nothing here talks
// to Jitsi except through the `send` function a caller passes in.

/**
 * Maximum send heights the teacher can pick (Jitsi "setVideoQuality"); 720p
 * is the highest (the camera is captured at 720p).
 */
export const TEACHER_VIDEO_QUALITY_HEIGHTS = Object.freeze([720, 480, 320, 180]);
/** Selected (and sent to Jitsi) when the teacher has not chosen one. */
export const DEFAULT_TEACHER_VIDEO_QUALITY = 720;

/**
 * Teaching Mode frame-rate caps; custom.js accepts exactly these. Applied
 * while Teaching Mode is on.
 */
export const TEACHING_FRAME_RATES = Object.freeze([15, 24, 30]);
export const DEFAULT_TEACHING_FRAME_RATE = 24;

/**
 * The teacher's top-layer (720p "high" level) video bitrate cap, bits/s,
 * for these codecs only. H.264 keeps lib-jitsi-meet's own default (2 Mbps).
 * A maximum, not a guaranteed rate: Jitsi and the browser still adapt to
 * the network, the CPU and what the students request.
 */
export const TEACHER_MAX_VIDEO_BITRATE_BPS = 1500000;
export const TEACHER_BITRATE_CODECS = Object.freeze(["av1", "vp8", "vp9"]);

/** The teacher's bitrate presets (maximum caps), in the order shown. */
export const TEACHER_BITRATE_PRESETS = Object.freeze([
  Object.freeze({ id: "low", label: "Low", bps: 500000, description: "Lower data usage" }),
  Object.freeze({ id: "standard", label: "Standard", bps: 1000000, description: "Balanced option for saving data" }),
  Object.freeze({
    id: "standard-plus", label: "Standard+", bps: 1500000, description: "Good video detail for teaching", recommended: true,
  }),
  Object.freeze({
    id: "high", label: "High", bps: 2500000, description: "Higher potential video quality",
    warning: "Uses more mobile data. Choose this option if your connection and data allowance can support it.",
  }),
]);
/** Standard+ (the recommended preset): the cap used until the teacher picks another. */
export const DEFAULT_TEACHER_BITRATE_BPS = TEACHER_MAX_VIDEO_BITRATE_BPS;
export const TEACHER_BITRATE_STORAGE_KEY = "sl-classroom-teacher-video-bitrate";

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isTeacherBitrate(value) {
  return typeof value === "number" && TEACHER_BITRATE_PRESETS.some((preset) => preset.bps === value);
}

/**
 * A stored cap ("1500000") when it is one of the presets, else the default.
 *
 * @param {string | null | undefined} raw
 * @returns {number}
 */
export function parseStoredTeacherBitrate(raw) {
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : null;

  return isTeacherBitrate(value) ? value : DEFAULT_TEACHER_BITRATE_BPS;
}

/**
 * configOverwrite entries for the teacher's bitrate cap: one dotted key per
 * codec (e.g. "videoQuality.av1.maxBitratesVideo.high"), never a whole
 * `videoQuality` object, so Jitsi merges just that value and keeps the
 * codec preference order and every other level. Students get none. The
 * value is read when the Jitsi iframe is created (join); changes during
 * the meeting go through buildTeacherBitrateMessage (custom.js).
 *
 * @param {string} role
 * @param {number} [bps] one of the presets; anything else: the default
 * @returns {Record<string, number>}
 */
export function buildTeacherBitrateConfig(role, bps = DEFAULT_TEACHER_BITRATE_BPS) {
  if (role !== "teacher") {
    return {};
  }

  const cap = isTeacherBitrate(bps) ? bps : DEFAULT_TEACHER_BITRATE_BPS;

  return Object.fromEntries(TEACHER_BITRATE_CODECS.map((codec) => [
    `videoQuality.${codec}.maxBitratesVideo.high`,
    cap,
  ]));
}

/**
 * The live bitrate message for custom.js (the teacher's own Jitsi iframe):
 * it sets the same AV1 / VP8 / VP9 "high" cap on the active connection.
 *
 * @param {number} epoch
 * @param {number} bps
 * @returns {{ type: "SL_TEACHER_BITRATE", v: 1, epoch: number, maxBitrate: number }}
 */
export function buildTeacherBitrateMessage(epoch, bps) {
  return {
    type: "SL_TEACHER_BITRATE",
    v: 1,
    epoch,
    maxBitrate: isTeacherBitrate(bps) ? bps : DEFAULT_TEACHER_BITRATE_BPS,
  };
}

const TEACHER_BITRATE_STATES = ["applied", "pending", "unsupported", "failed"];

/**
 * custom.js's report (SL_TEACHER_BITRATE_STATUS), or null when malformed.
 * `topMaxBitrate`: the maxBitrate on the camera's active top encoding as the
 * browser holds it (null when unknown); it is lower than the cap while
 * students request a smaller size (Jitsi's "standard" / "low" levels).
 *
 * @param {unknown} data
 */
export function parseTeacherBitrateStatus(data) {
  const message = /** @type {Record<string, unknown> | null} */ (data);
  const finiteOrNull = (/** @type {unknown} */ value) =>
    value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);

  if (
    !message ||
    message.type !== "SL_TEACHER_BITRATE_STATUS" ||
    message.v !== 1 ||
    !isTeacherBitrate(message.maxBitrate) ||
    !TEACHER_BITRATE_STATES.includes(/** @type {string} */ (message.state)) ||
    !finiteOrNull(message.topMaxBitrate) ||
    !(message.codec === null || (typeof message.codec === "string" && /^[A-Za-z0-9]{1,16}$/.test(message.codec)))
  ) {
    return null;
  }

  return {
    maxBitrate: /** @type {number} */ (message.maxBitrate),
    state: /** @type {"applied" | "pending" | "unsupported" | "failed"} */ (message.state),
    topMaxBitrate: /** @type {number | null} */ (message.topMaxBitrate),
    codec: /** @type {string | null} */ (message.codec),
  };
}

/** "1.5 Mbps", "500 kbps". @param {number} bps */
export function formatBitrate(bps) {
  return bps >= 1000000 ? `${Number((bps / 1000000).toFixed(2))} Mbps` : `${Math.round(bps / 1000)} kbps`;
}

/**
 * One line under the selector: whether the chosen cap is on the live camera.
 * No report (an older custom.js): it applies from the next join only.
 *
 * @param {{ maxBitrate: number, state: string, topMaxBitrate: number | null, codec: string | null } | null | undefined} status
 * @param {number} selected
 * @returns {string}
 */
export function describeTeacherBitrateStatus(status, selected) {
  if (!status) {
    return `${formatBitrate(selected)} cap is used from the next time you join.`;
  }

  if (status.maxBitrate !== selected || status.state === "pending") {
    return "Applying…";
  }

  if (status.state === "unsupported") {
    return `Cannot be changed during this meeting; ${formatBitrate(selected)} is used from the next time you join.`;
  }

  if (status.state === "failed") {
    return `Could not be applied now; ${formatBitrate(selected)} is used from the next time you join.`;
  }

  // The cap is set for AV1 / VP8 / VP9 only; H.264 keeps Jitsi's own default.
  if (status.codec && !TEACHER_BITRATE_CODECS.includes(status.codec.toLowerCase())) {
    return `Your camera is using ${status.codec.toUpperCase()}, which keeps Jitsi's own cap; this setting applies to AV1, VP8 and VP9.`;
  }

  const codec = status.codec ? ` (${status.codec.toUpperCase()})` : "";
  const smaller = status.topMaxBitrate !== null && status.topMaxBitrate < selected
    ? ` Your camera is currently sending a smaller size (limit ${formatBitrate(status.topMaxBitrate)}) because of what students request.`
    : "";

  return `Applied to your camera${codec}: up to ${formatBitrate(selected)}.${smaller}`;
}

export const VIDEO_QUALITY_STORAGE_KEY = "sl-classroom-teacher-video-quality";
export const TEACHING_FRAME_RATE_STORAGE_KEY = "sl-classroom-teacher-teaching-fps";
export const TEACHING_DETAIL_HINT_STORAGE_KEY = "sl-classroom-teacher-teaching-detail-hint";

/**
 * localStorage read; null when there is none (server render, private mode).
 *
 * @param {string} key
 * @returns {string | null}
 */
export function readStorage(key) {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * localStorage write; silently skipped when unavailable (the choice then
 * lasts for this page only).
 *
 * @param {string} key
 * @param {string} value
 */
export function writeStorage(key, value) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
    }
  } catch {
    /* private mode: not persisted */
  }
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isTeacherVideoQualityHeight(value) {
  return typeof value === "number" && TEACHER_VIDEO_QUALITY_HEIGHTS.includes(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isTeachingFrameRate(value) {
  return typeof value === "number" && TEACHING_FRAME_RATES.includes(value);
}

/**
 * A stored height ("720"), or null when absent or not one of the choices.
 *
 * @param {string | null | undefined} raw
 * @returns {number | null}
 */
export function parseStoredVideoQuality(raw) {
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : null;

  return isTeacherVideoQualityHeight(value) ? value : null;
}

/**
 * A stored frame rate ("24"), else the default.
 *
 * @param {string | null | undefined} raw
 * @returns {number}
 */
export function parseStoredFrameRate(raw) {
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : null;

  return isTeachingFrameRate(value) ? value : DEFAULT_TEACHING_FRAME_RATE;
}

/**
 * A stored "true" / "false", else the fallback.
 *
 * @param {string | null | undefined} raw
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function parseStoredBoolean(raw, fallback) {
  return raw === "true" ? true : raw === "false" ? false : fallback;
}

/**
 * The Teaching Mode message for custom.js. maxFps / detailHint are sent
 * explicitly; custom.js applies them while `enabled` is true (an older
 * custom.js ignores both and applies 15 fps + detail while on).
 *
 * @param {number} epoch
 * @param {{ enabled: boolean, maxFps: number, detailHint: boolean }} settings
 * @returns {{ type: "SL_TEACHING_MODE", v: 1, epoch: number, enabled: boolean, maxFps: number, detailHint: boolean }}
 */
export function buildTeachingModeMessage(epoch, settings) {
  return {
    type: "SL_TEACHING_MODE",
    v: 1,
    epoch,
    enabled: Boolean(settings.enabled),
    maxFps: isTeachingFrameRate(settings.maxFps) ? settings.maxFps : DEFAULT_TEACHING_FRAME_RATE,
    detailHint: typeof settings.detailHint === "boolean" ? settings.detailHint : true,
  };
}

/**
 * One line under the frame-rate buttons, whether Teaching Mode is on or off:
 * what custom.js reports for the camera TRACK (its frame-rate constraint and
 * the frame rate the track itself reports). Never what is sent: the encoded
 * / sent frame rate is only known from WebRTC stats (Video diagnostics).
 *
 * @param {{ camera: boolean, frameRate: string | null, fps: number | null, maxFps: number | null } | null | undefined} status
 * @param {number} selectedFps
 * @returns {string}
 */
export function describeFrameRateStatus(status, selectedFps) {
  if (!status) {
    return "Not confirmed by the meeting yet.";
  }

  // An older custom.js reports no maxFps (and caps only while Teaching Mode
  // is on); a different value is an earlier choice still being replaced.
  if (status.maxFps === null) {
    return "Not confirmed by this meeting server.";
  }

  if (status.maxFps !== selectedFps || status.frameRate === "pending") {
    return "Applying…";
  }

  if (!status.camera || status.frameRate === null) {
    return "Not applied to a camera yet.";
  }

  const reported = status.fps !== null ? ` (camera reports ${Math.round(status.fps)} fps)` : "";

  if (status.frameRate === "applied") {
    return `Camera capped at ${selectedFps} fps${reported}.`;
  }

  if (status.frameRate === "kept") {
    return `Camera already at or below ${selectedFps} fps${reported}.`;
  }

  if (status.frameRate === "unsupported") {
    return `This camera does not accept a ${selectedFps} fps cap.`;
  }

  return `The ${selectedFps} fps cap could not be applied.`;
}

/**
 * Keeps the teacher's chosen maximum send quality and sends it to Jitsi
 * once per conference join (first join, reconnect, breakout switch): a
 * choice made before Jitsi is ready is kept, not lost. No timers or
 * retries: an unsent choice goes out on the next join or the next choice.
 *
 * `send(height)` returns false when it could not send (Jitsi not created).
 *
 * @param {(height: number) => boolean} send
 */
export function createVideoQualityController(send) {
  /** @type {number | null} */
  let desired = null;
  /** @type {number | null} what the current conference was last sent */
  let applied = null;
  let joined = false;

  function flush() {
    if (desired === null || !joined || applied === desired) {
      return false;
    }

    if (send(desired) === false) {
      return false;
    }

    applied = desired;

    return true;
  }

  return {
    /**
     * The teacher's choice (invalid heights are ignored). Returns whether it
     * was sent now.
     *
     * @param {unknown} height
     */
    setDesired(height) {
      if (!isTeacherVideoQualityHeight(height)) {
        return false;
      }

      desired = height;

      return flush();
    },

    /** A conference was (re)joined: send the choice to it once. */
    conferenceJoined() {
      joined = true;
      applied = null;

      return flush();
    },

    /** Left (or torn down): the next join sends the choice again. */
    conferenceLeft() {
      joined = false;
      applied = null;
    },

    state() {
      return { desired, applied, joined };
    },
  };
}
