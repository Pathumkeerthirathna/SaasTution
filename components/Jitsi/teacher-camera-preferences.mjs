// Teacher camera preferences: maximum send quality and Teaching Mode's frame
// rate / detail hint. Plain JavaScript with JSDoc types so the same code runs
// in the app (useJitsi, JitsiClassroom, SidebarNav) and in the Node test
// runner (tests/jitsi). Display / preference logic only: nothing here talks
// to Jitsi except through the `send` function a caller passes in.

/** Maximum send heights the teacher can pick (Jitsi "setVideoQuality"). */
export const TEACHER_VIDEO_QUALITY_HEIGHTS = Object.freeze([1080, 720, 480, 320, 180]);

/** Teaching Mode frame-rate caps; custom.js accepts exactly these. */
export const TEACHING_FRAME_RATES = Object.freeze([15, 24, 30]);
export const DEFAULT_TEACHING_FRAME_RATE = 15;

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
 * explicitly; an older custom.js ignores them (it applies 15 fps + detail).
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
