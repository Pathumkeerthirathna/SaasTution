/**
 * When the teacher's page starts / stops Jibri for YouTube Recording and Live.
 *
 * Jitsi runs ONE Jibri stream per conference, feeding the teacher's one
 * reusable YouTube stream; Recording and Live (shared or separate YouTube
 * broadcasts) both ride on it. Plain functions, so they can be tested.
 */

/**
 * Start Jibri only when nothing is streaming yet: neither feature is active
 * on this page (each became active only after Jibri confirmed, or was
 * restored from the server after a reload) and YouTube does not already see
 * the stream. YouTube's stream status alone lags behind Jibri by seconds, so
 * it is never the only check.
 */
export function shouldStartJibri(state: {
  /** YouTube reports the reusable stream as active (from the start API). */
  alreadyStreaming: boolean;
  recordingActive: boolean;
  liveActive: boolean;
}): boolean {
  return !state.alreadyStreaming && !state.recordingActive && !state.liveActive;
}

/**
 * After a successful stop API call: stop Jibri only if the server says no
 * other feature still needs it (`stopJibri`, from the persisted Recording /
 * Live rows, so it is right after a reload too). A response without it (an
 * older server) falls back to this page's own view of the other feature.
 */
export function shouldStopJibriAfterStop(
  response: { stopJibri?: unknown },
  otherFeatureActiveOnPage: boolean
): boolean {
  return typeof response.stopJibri === "boolean"
    ? response.stopJibri
    : !otherFeatureActiveOnPage;
}

/**
 * Jitsi's `recordingStatusChanged` event, reduced to what the YouTube stream
 * controller needs, or null when it is not about the class's YouTube stream:
 * - only mode "stream" (Jibri live streaming, which YouTube Recording and
 *   Live both use); "file" recordings and transcription are not ours;
 * - not while the page is in a breakout room (the event describes that room);
 * - only a well-formed event (a boolean `on`).
 */
export function toYouTubeStreamStatus(
  event: unknown,
  context: { inBreakout: boolean }
): { on: boolean; error?: string } | null {
  if (context.inBreakout || !event || typeof event !== "object") {
    return null;
  }

  const data = event as { on?: unknown; mode?: unknown; error?: unknown; transcription?: unknown };

  if (data.mode !== "stream" || typeof data.on !== "boolean" || data.transcription === true) {
    return null;
  }

  return typeof data.error === "string" && data.error
    ? { on: data.on, error: data.error }
    : { on: data.on };
}
