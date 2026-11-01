/**
 * The returning teacher's notices about the teacher-departure stop
 * (GET /api/sessions/[id]/teacher-departure). Plain functions, so they can be
 * tested; JitsiClassroom shows them.
 *
 * Only confirmed stops are described as stopped. A pending stop (YouTube did
 * not confirm it) is described as possibly still running, with what to do.
 */

import type { YouTubeFeature } from "./youtube-stream-controller";

export type DepartureNotices = {
  sessionId: string;
  sessionActive: boolean;
  stopped: { feature: YouTubeFeature; id: string; endedAt: string; youtubeUrl: string }[];
  pending: { feature: YouTubeFeature; id: string; attemptedAt: string | null; reason: string }[];
  activeFeatures: YouTubeFeature[];
  hadDepartureStop: boolean;
  /** The teacher's Jibri shutdown fence (absent: unknown / an older server). */
  shutdownFence?: ShutdownFenceNotice;
};

export type ShutdownFenceNotice = { blocked: false } | { blocked: true; code: string; message: string; since: string | null };

function parseShutdownFence(value: unknown): ShutdownFenceNotice | undefined {
  if (!value || typeof value !== "object") return undefined;

  const fence = value as Record<string, unknown>;

  if (fence.blocked === false) return { blocked: false };
  if (fence.blocked !== true || typeof fence.code !== "string" || typeof fence.message !== "string") return undefined;

  return {
    blocked: true,
    code: fence.code,
    message: fence.message,
    since: typeof fence.since === "string" && !Number.isNaN(Date.parse(fence.since)) ? fence.since : null,
  };
}

const isFeature = (value: unknown): value is YouTubeFeature => value === "recording" || value === "live";

/** The response's `data`, or null when it does not have the expected shape. */
export function parseDepartureNotices(data: unknown): DepartureNotices | null {
  if (!data || typeof data !== "object") return null;

  const value = data as Record<string, unknown>;

  if (
    typeof value.sessionId !== "string" ||
    typeof value.sessionActive !== "boolean" ||
    typeof value.hadDepartureStop !== "boolean" ||
    !Array.isArray(value.stopped) ||
    !Array.isArray(value.pending) ||
    !Array.isArray(value.activeFeatures) ||
    !value.activeFeatures.every(isFeature)
  ) {
    return null;
  }

  const stopped = value.stopped.filter((entry): entry is DepartureNotices["stopped"][number] =>
    Boolean(entry) && isFeature(entry.feature) && typeof entry.id === "string" &&
    typeof entry.endedAt === "string" && !Number.isNaN(Date.parse(entry.endedAt)));
  const pending = value.pending.filter((entry): entry is DepartureNotices["pending"][number] =>
    Boolean(entry) && isFeature(entry.feature) && typeof entry.id === "string" && typeof entry.reason === "string");

  if (stopped.length !== value.stopped.length || pending.length !== value.pending.length) return null;

  return {
    sessionId: value.sessionId,
    sessionActive: value.sessionActive,
    stopped,
    pending,
    activeFeatures: value.activeFeatures,
    hadDepartureStop: value.hadDepartureStop,
    ...(parseShutdownFence(value.shutdownFence) ? { shutdownFence: parseShutdownFence(value.shutdownFence) } : {}),
  };
}

/**
 * Why the teacher cannot start Recording / Live yet (the server's own
 * explanation of the fence), with when it began; null when nothing blocks.
 * Shown after every load, so a reload never hides it.
 */
export function describeShutdownFenceNotice(
  notices: Pick<DepartureNotices, "shutdownFence">,
  formatTime: (date: Date) => string
): { message: string; code: string } | null {
  const fence = notices.shutdownFence;

  if (!fence || !fence.blocked) return null;

  const since = fence.since ? ` (since ${formatTime(new Date(fence.since))})` : "";

  return { message: fence.message + since, code: fence.code };
}

const NAMES: Record<YouTubeFeature, string> = { live: "Live", recording: "Recording" };
const STOP_BUTTONS: Record<YouTubeFeature, string> = { live: "Stop Live", recording: "Stop Recording" };

// Live first, each once.
const featuresOf = (entries: { feature: YouTubeFeature }[]): YouTubeFeature[] =>
  (["live", "recording"] as const).filter(feature => entries.some(entry => entry.feature === feature));

const joinAnd = (parts: string[]) => parts.join(" and ");

/**
 * The confirmed stops: one message naming only what stopped, and the IDs to
 * acknowledge. Null when there is nothing to tell.
 */
export function describeStoppedNotice(
  stopped: DepartureNotices["stopped"],
  formatTime: (date: Date) => string
): { message: string; features: YouTubeFeature[]; recordingIds: string[]; liveIds: string[] } | null {
  if (stopped.length === 0) return null;

  const features = featuresOf(stopped);
  const latest = new Date(Math.max(...stopped.map(entry => Date.parse(entry.endedAt))));
  const what = joinAnd(features.map(feature => NAMES[feature]));

  return {
    message:
      `Your YouTube ${what} ${features.length > 1 ? "were" : "was"} stopped because you closed the classroom ` +
      `(at ${formatTime(latest)}).`,
    features,
    recordingIds: stopped.filter(entry => entry.feature === "recording").map(entry => entry.id),
    liveIds: stopped.filter(entry => entry.feature === "live").map(entry => entry.id),
  };
}

/**
 * Stops YouTube did not confirm: never described as stopped. Null when there
 * are none.
 */
export function describePendingNotice(
  pending: DepartureNotices["pending"]
): { message: string; features: YouTubeFeature[]; reauthRequired: boolean } | null {
  if (pending.length === 0) return null;

  const features = featuresOf(pending);
  const what = joinAnd(features.map(feature => NAMES[feature]));
  const buttons = joinAnd(features.map(feature => STOP_BUTTONS[feature]));
  const reauthRequired = pending.some(entry => entry.reason === "reauth-required");
  // Automatic retries gave up (still never described as stopped).
  const unresolved = pending.some(entry => entry.reason === "unresolved");

  return {
    message:
      `We tried to stop your YouTube ${what} after you closed the classroom, but YouTube has not confirmed it. ` +
      (reauthRequired
        ? `Reconnect YouTube, then use ${buttons}.`
        : unresolved
          ? `Automatic attempts have stopped. Use ${buttons}, or end it in YouTube Studio.`
          : `It may still be running: use ${buttons} to end it.`),
    features,
    reauthRequired,
  };
}

/**
 * Whether a Jibri stream still running in this conference can only be a
 * leftover of the departure stop: the session is active, a departure stop
 * ended its features, and nothing of it is active or pending now.
 */
export function canStopOrphanStream(notices: DepartureNotices): boolean {
  return (
    notices.sessionActive &&
    notices.hadDepartureStop &&
    notices.activeFeatures.length === 0 &&
    notices.pending.length === 0
  );
}
