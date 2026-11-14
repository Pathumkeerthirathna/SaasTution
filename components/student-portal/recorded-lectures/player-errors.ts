/*
 * What to tell the student when playback fails (RL-5.1).
 *
 * A <video> error does not expose the HTTP status, so the player sends ONE
 * HEAD request to the stream URL. HEAD re-authorises like GET but never
 * opens the file and never takes a stream slot, so it can tell:
 *   401 session ended, 403 account inactive, 404 recording no longer
 *   available (removed, or the student left the class), 500 file problem,
 *   503 temporarily unavailable.
 * It CANNOT detect the per-student stream limit (429 is only ever returned
 * to a GET that would stream): a HEAD that succeeds (200 / 206) or a HEAD
 * that fails on the network means "playback was interrupted" — too many
 * recordings playing in other tabs, a dropped connection, or a paused
 * stream that timed out — shown as one generic, retryable error. No extra
 * GET is ever sent just to identify the error.
 */

export type PlaybackFailureKind =
  | "SESSION_EXPIRED"
  | "ACCOUNT_INACTIVE"
  | "NOT_AVAILABLE"
  | "FILE_UNAVAILABLE"
  | "TEMPORARILY_UNAVAILABLE"
  | "PLAYBACK_INTERRUPTED";

export type PlaybackFailure = {
  kind: PlaybackFailureKind;
  title: string;
  message: string;
  /** Show "Try again" (reload the same part from where it stopped). */
  retryable: boolean;
  /** Show a "Sign in" link. */
  signIn: boolean;
};

const FAILURES: Record<PlaybackFailureKind, Omit<PlaybackFailure, "kind">> = {
  SESSION_EXPIRED: {
    title: "Your session has ended",
    message: "Please sign in again to keep watching.",
    retryable: false,
    signIn: true,
  },
  ACCOUNT_INACTIVE: {
    title: "Your account is inactive",
    message: "Your student account is inactive. Please contact your teacher.",
    retryable: false,
    signIn: false,
  },
  NOT_AVAILABLE: {
    title: "This recording is no longer available",
    message: "It may have been removed, or you may no longer be enrolled in this class.",
    retryable: false,
    signIn: false,
  },
  FILE_UNAVAILABLE: {
    title: "This recording cannot be played",
    message: "Something is wrong with this recording. Please tell your teacher.",
    retryable: false,
    signIn: false,
  },
  TEMPORARILY_UNAVAILABLE: {
    title: "Recordings are temporarily unavailable",
    message: "Please wait a moment and try again.",
    retryable: true,
    signIn: false,
  },
  PLAYBACK_INTERRUPTED: {
    title: "Playback was interrupted",
    message:
      "This can happen if the connection dropped or if several recordings are playing in other tabs. Close other recordings and try again.",
    retryable: true,
    signIn: false,
  },
};

export function playbackFailure(kind: PlaybackFailureKind): PlaybackFailure {
  return { kind, ...FAILURES[kind] };
}

/** The failure for a HEAD diagnosis: its status, or null when the HEAD itself failed (network). */
export function diagnosePlaybackFailure(headStatus: number | null): PlaybackFailure {
  if (headStatus === 401) return playbackFailure("SESSION_EXPIRED");
  if (headStatus === 403) return playbackFailure("ACCOUNT_INACTIVE");
  if (headStatus === 404) return playbackFailure("NOT_AVAILABLE");
  if (headStatus === 500) return playbackFailure("FILE_UNAVAILABLE");
  if (headStatus === 503 || (headStatus !== null && headStatus > 500)) return playbackFailure("TEMPORARILY_UNAVAILABLE");
  // 200 / 206 / 416, anything else, or no answer: the file is reachable for this
  // student right now, so the GET failed for a reason HEAD cannot see.
  return playbackFailure("PLAYBACK_INTERRUPTED");
}

/** A list / "load more" API failure (JSON API, status known). */
export function listFailureMessage(status: number): { message: string; signIn: boolean } {
  if (status === 401) return { message: "Your session has ended. Please sign in again.", signIn: true };
  if (status === 403) return { message: "Your student account is inactive. Please contact your teacher.", signIn: false };
  if (status === 503) return { message: "Recorded lectures are temporarily unavailable. Please try again shortly.", signIn: false };
  return { message: "Could not load more recordings. Please try again.", signIn: false };
}
