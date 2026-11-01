import type { DepartureNotices } from "./teacher-departure-notice";
import type { YouTubeFeature } from "./youtube-stream-controller";

type ServerReporter = { serverReport: (feature: YouTubeFeature, active: boolean) => void };

/**
 * The teacher's classroom page opening (or reopening) the session: Live and
 * Recording are set from the server in an order that cannot restore a stale
 * state.
 *
 * 1. The departure notices FIRST (GET /api/sessions/[id]/teacher-departure):
 *    that request processes a confirmed teacher departure not processed yet
 *    (no sweeper or student ran it), then reports `activeFeatures` read AFTER
 *    that processing. Applied to BOTH features: a feature the departure ended
 *    is off, one still active (or whose stop is still pending) is restored.
 * 2. THEN the Recording status (GET /api/youtube/lecture/recording/status,
 *    YouTube's view), read after step 1, so it can never report a Recording
 *    the departure has just ended as still running. (Before, both requests
 *    ran side by side: a status read before the departure processing could
 *    restore "Stop Recording" for a Recording that had just been stopped, and
 *    nothing corrected it: Recording has no push channel.)
 *
 * Live also keeps its SSE push (snapshot on connect, "ended" when a Live row
 * closes). A failed request reports nothing (the other still applies).
 * Returns the notices (for the page's toasts and orphaned-stream stop), or
 * null when they could not be loaded.
 */
export async function syncTeacherYouTubeState(deps: {
  loadNotices: () => Promise<DepartureNotices | null>;
  /** Whether YouTube reports the lecture's Recording active; null when unknown (failed). */
  loadRecordingStatus: () => Promise<boolean | null>;
  controller: () => ServerReporter | null | undefined;
  /** The page went away (effect cleanup): nothing more is applied. */
  cancelled: () => boolean;
  log?: (...args: unknown[]) => void;
}): Promise<DepartureNotices | null> {
  let notices: DepartureNotices | null = null;

  try {
    notices = await deps.loadNotices();
  } catch (error) {
    deps.log?.("Teacher-departure notices failed:", error);
  }

  if (deps.cancelled()) return notices;

  if (notices) {
    const active = new Set(notices.activeFeatures);

    deps.controller()?.serverReport("recording", active.has("recording"));
    deps.controller()?.serverReport("live", active.has("live"));
  }

  let recordingActive: boolean | null = null;

  try {
    recordingActive = await deps.loadRecordingStatus();
  } catch (error) {
    deps.log?.("Recording status check failed:", error);
  }

  if (!deps.cancelled() && recordingActive !== null) {
    deps.controller()?.serverReport("recording", recordingActive);
  }

  return notices;
}
