// Teacher audio preferences: Jitsi's model-based noise suppression (RNNoise,
// Jitsi's NoiseSuppressionEffect) on the teacher's own microphone. Plain
// JavaScript with JSDoc types so the same code runs in the app (useJitsi,
// JitsiClassroom) and in the Node test runner (tests/jitsi). Preference and
// sending logic only: nothing here talks to Jitsi except through the `send`
// function a caller passes in. The browser's own echo cancellation, noise
// suppression and automatic gain control are left to Jitsi's defaults.

import { readStorage } from "./teacher-camera-preferences.mjs";

/** Same key as before, so an explicitly saved choice is kept. */
export const NOISE_SUPPRESSION_STORAGE_KEY = "sl-classroom-teacher-noise-suppression";

/** RNNoise is ON for teachers until they turn it off. */
export const DEFAULT_TEACHER_NOISE_SUPPRESSION = true;

/**
 * A stored "true" / "false"; anything else (never set): the default (on).
 *
 * @param {string | null | undefined} raw
 * @returns {boolean}
 */
export function parseStoredNoiseSuppression(raw) {
  return raw === "false" ? false : raw === "true" ? true : DEFAULT_TEACHER_NOISE_SUPPRESSION;
}

/** The teacher's choice from localStorage (default on). */
export function readStoredNoiseSuppression() {
  return parseStoredNoiseSuppression(readStorage(NOISE_SUPPRESSION_STORAGE_KEY));
}

/**
 * Keeps the teacher's noise-suppression choice and sends it to Jitsi
 * ("setNoiseSuppressionEnabled") once per conference join (first join,
 * reconnect, breakout switch, a recreated meeting), and at once when it
 * changes while joined. A choice made before Jitsi is ready is kept, never
 * lost; the same value is not sent twice to the same conference (Jitsi would
 * only log that it is already in that state).
 *
 * `send(enabled)` returns false when it could not send (no Jitsi API yet):
 * the choice then stays unsent and goes out on the next join or change.
 *
 * Jitsi gives no read-back of its state: "applied" here means "sent", not
 * that Jitsi could start RNNoise (it declines stereo microphones and shared
 * desktop audio, with its own notice in the meeting).
 *
 * @param {(enabled: boolean) => boolean} send
 */
export function createNoiseSuppressionController(send) {
  /** @type {boolean | null} */
  let desired = null;
  /** @type {boolean | null} what the current conference was last sent */
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
     * The teacher's choice (anything but a boolean is ignored). Returns
     * whether it was sent now.
     *
     * @param {unknown} enabled
     */
    setDesired(enabled) {
      if (typeof enabled !== "boolean") {
        return false;
      }

      desired = enabled;

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
