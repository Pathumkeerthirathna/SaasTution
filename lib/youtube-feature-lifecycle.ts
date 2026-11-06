import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import { emitLiveChange } from "@/lib/session-events";
import {
  getYouTubeAccessToken,
  withYouTubeAccessTokenReuse,
  YouTubeReauthorizationRequiredError,
} from "@/lib/youtube-auth";
import {
  deleteYouTubeLiveBroadcast,
  getYouTubeLiveBroadcast,
  listUpcomingYouTubeLiveBroadcasts,
  SLCLASSROOM_BROADCAST_DESCRIPTION_PREFIX,
  transitionYouTubeLiveBroadcast,
  type YouTubeLiveBroadcast,
} from "@/lib/youtube-live";
import {
  findActiveSharedFeature,
  isOtherYouTubeFeatureActive,
  clearCompleteRequested,
  DEPARTURE_TRANSITION_APPLY_WINDOW_MS,
  isTerminalLifecycle,
  markCompleteRequested,
  youTubeActualEndTime,
  youTubeEndedCloseData,
  type DepartureSendState,
  type YouTubeFeature,
} from "@/lib/youtube-feature-state";
import { serverNow, serverNowSync } from "@/lib/server-clock";
import { departureState, recordTeacherActivity, type DepartureState } from "@/lib/teacher-presence";
import { armsFences, readJibriFenceControl } from "@/lib/jibri-fence-control";
import { armJibriFence } from "@/lib/jibri-shutdown-gate";
import { withLectureYouTubeLock } from "@/lib/youtube-operation-lock";
import {
  YouTubeApiError,
  youtubeDeadlineRemainingMs,
  YouTubeRequestTimeoutError,
  youtubeTimeouts,
} from "@/lib/youtube-request";
import { YouTubeBroadcastStatus, YouTubeFeatureStopReason } from "@prisma/client";

/*
 * Ending a YouTube feature (Recording or Live): a normal stop, or the cleanup
 * of a start whose Jibri stream never confirmed. Both run under the lecture
 * lock and follow the shared-broadcast rule: the YouTube broadcast is
 * completed only when no other active feature uses it, and Jibri may stop
 * (`stopJibri`) only when the other feature is not active for the lecture.
 */

const ACTIVE: YouTubeBroadcastStatus[] = [
  YouTubeBroadcastStatus.READY,
  YouTubeBroadcastStatus.LIVE,
];

type FeatureRow = {
  id: string;
  lectureId: string;
  broadcastId: string;
  youtubeUrl: string;
  status: YouTubeBroadcastStatus;
  version: number;
  updatedAt: Date;
};

const rowSelect = {
  id: true, lectureId: true, broadcastId: true, youtubeUrl: true, status: true, version: true, updatedAt: true,
};

/**
 * The row version a start reported (`rowVersion`), sent back with its
 * failed-start cleanup:
 * - version: the integer `version` (incremented only when a start reuses or
 *   reactivates the row; see reuseLiveRow in youtube-lecture.ts);
 * - legacy-updatedAt: an ISO timestamp from a page loaded before the version
 *   counter (one-release compatibility; compared with `updatedAt` as before).
 */
export type RowVersionToken =
  | { kind: "version"; value: number }
  | { kind: "legacy-updatedAt"; value: Date };

/**
 * Parses a request's `rowVersion`: undefined when absent (pages from before
 * row versions), "invalid" when present but unusable.
 */
export function parseRowVersionToken(raw: unknown): RowVersionToken | undefined | "invalid" {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 0 ? { kind: "version", value: raw } : "invalid";
  }

  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T/.test(raw) && !Number.isNaN(Date.parse(raw))) {
    return { kind: "legacy-updatedAt", value: new Date(raw) };
  }

  return "invalid";
}

const rowIsAt = (row: FeatureRow, token: RowVersionToken) =>
  token.kind === "version"
    ? row.version === token.value
    : row.updatedAt.getTime() === token.value.getTime();

const versionCondition = (token?: RowVersionToken) =>
  !token ? {} : token.kind === "version" ? { version: token.value } : { updatedAt: token.value };

function findActiveRow(feature: YouTubeFeature, lectureId: string): Promise<FeatureRow | null> {
  const args = {
    where: { lectureId, status: { in: ACTIVE } },
    orderBy: { createdAt: "desc" as const },
    select: rowSelect,
  };

  return feature === "recording"
    ? prisma.youTubeRecording.findFirst(args)
    : prisma.youTubeLiveBroadcast.findFirst(args);
}

function findRowById(feature: YouTubeFeature, lectureId: string, id: string): Promise<FeatureRow | null> {
  const args = { where: { id, lectureId }, select: rowSelect };

  return feature === "recording"
    ? prisma.youTubeRecording.findFirst(args)
    : prisma.youTubeLiveBroadcast.findFirst(args);
}

/**
 * Closes the row only if it is still active (repeated calls change nothing)
 * and, when a version token is given, still at that version.
 */
/** Written together with a row's end (the teacher-departure stop's reason). */
type CloseData = {
  stopReason?: YouTubeFeatureStopReason;
  autoStopAttemptedAt?: Date;
  autoStopError?: string | null;
  /** YouTube's own end time, when the broadcast had already ended there. */
  endedAt?: Date;
};

async function closeRow(
  feature: YouTubeFeature,
  id: string,
  status: YouTubeBroadcastStatus,
  token?: RowVersionToken,
  closeData: CloseData = {}
) {
  const args = {
    where: { id, status: { in: ACTIVE }, ...versionCondition(token) },
    data: { status, endedAt: new Date(), ...closeData },
  };

  const result = feature === "recording"
    ? await prisma.youTubeRecording.updateMany(args)
    : await prisma.youTubeLiveBroadcast.updateMany(args);

  return result.count > 0;
}

/**
 * YouTube's explicit refusal to complete a broadcast that cannot make that
 * transition (it never went live): HTTP 403, reason "invalidTransition", or
 * "errorStreamInactive" when its bound stream never received data (e.g. Jibri
 * refused the start: all streamers busy). Anything else is not taken as a
 * refusal. Callers still require a ready / created lookup, and the removal
 * still looks the broadcast up afresh (cleanUpNeverLiveBroadcast).
 */
const isNeverLiveRefusal = (error: unknown) =>
  error instanceof YouTubeApiError &&
  error.status === 403 &&
  (error.reason === "invalidTransition" || error.reason === "errorStreamInactive");

/** States in which a broadcast is (still, or now) running: never deleted. */
const STARTED_LIFECYCLES = new Set(["live", "liveStarting", "testing", "testStarting"]);

/** What a guarded cleanup of a never-live broadcast found, and did. */
type NeverLiveCleanup =
  /** It never went live and is removed: deleted now, or YouTube answered the delete "not found". */
  | { result: "deleted" }
  /** The fresh lookup did not find it (removed before). */
  | { result: "gone" }
  /** The fresh lookup reports it complete / revoked: over, by YouTube's own report. */
  | { result: "ended"; broadcast: YouTubeLiveBroadcast }
  /**
   * Nothing removed and nothing to close: it started meanwhile (live,
   * liveStarting, testing), its state is unknown, or YouTube refused / failed
   * the lookup or the delete. A later attempt looks it up afresh.
   */
  | { result: "kept"; started: boolean; detail: string };

/**
 * Guarded removal of a broadcast believed never to have gone live (YouTube
 * refused to complete it, or the departure's transitions gave up on a ready
 * one). Never trusts the earlier lookup: looks the broadcast up again and
 * deletes it (liveBroadcasts.delete) ONLY if YouTube reports it ready /
 * created, never once it is live / starting / testing. Callers guarantee no
 * other active feature uses it, under the lecture lock (every start that could
 * share it holds that lock). The caller closes its rows only on "deleted",
 * "gone" or "ended".
 *
 * Throws YouTubeReauthorizationRequiredError, and YouTubeRequestTimeoutError
 * when the lookup or the delete got no answer (whether it was deleted is then
 * unknown: the next attempt's fresh lookup finds out; "not found" is gone).
 */
async function cleanUpNeverLiveBroadcast(
  refreshTokenEncrypted: string,
  broadcastId: string
): Promise<NeverLiveCleanup> {
  let broadcast: YouTubeLiveBroadcast;

  try {
    broadcast = await getYouTubeLiveBroadcast(refreshTokenEncrypted, broadcastId);
  } catch (error) {
    if (error instanceof YouTubeReauthorizationRequiredError) throw error;
    if (error instanceof YouTubeRequestTimeoutError) throw error;
    if (error instanceof Error && error.message.includes("not found")) return { result: "gone" };

    return { result: "kept", started: false, detail: describeFailure("lookup", error) };
  }

  const lifecycleStatus = broadcast.status?.lifeCycleStatus;

  if (isTerminalLifecycle(lifecycleStatus)) {
    return { result: "ended", broadcast };
  }

  if (lifecycleStatus !== "ready" && lifecycleStatus !== "created") {
    return {
      result: "kept",
      started: STARTED_LIFECYCLES.has(lifecycleStatus ?? ""),
      detail: `lookup: ${lifecycleStatus ?? "no status"}, not deleted`,
    };
  }

  try {
    await deleteYouTubeLiveBroadcast(refreshTokenEncrypted, broadcastId);
  } catch (error) {
    if (error instanceof YouTubeReauthorizationRequiredError) throw error;
    if (error instanceof YouTubeRequestTimeoutError) throw error;
    if (error instanceof YouTubeApiError && error.status === 404) return { result: "deleted" };

    console.error("YouTube did not delete a broadcast that never went live; retried later:", { broadcastId, error });

    return { result: "kept", started: false, detail: describeFailure("delete", error) };
  }

  console.warn("Deleted a YouTube broadcast that never went live:", { broadcastId, lifecycleStatus });

  return { result: "deleted" };
}

const prestartCleanupError = () =>
  new AppError(
    "Couldn't check your YouTube channel for unused broadcasts, so nothing was started. Please try again in a moment.",
    503,
    "YOUTUBE_PRESTART_CLEANUP_FAILED"
  );

/**
 * Before a Recording / Live start (startInCurrentSession, holding the
 * teacher's stream lock AND the lecture lock): removes leftover broadcasts
 * that never started and are still bound to this teacher's reusable stream,
 * so none can start with the class this start is about to stream (YouTube
 * starts every auto-start broadcast bound to a stream once it streams). Also
 * catches broadcasts with no row at all (a start that failed after creating
 * one).
 *
 * A broadcast is deleted only if ALL hold:
 * - YouTube lists it as upcoming with lifecycle ready / created;
 * - it is bound to this teacher's reusable stream (so it is this channel's);
 * - its description starts with SLCLASSROOM_BROADCAST_DESCRIPTION_PREFIX
 *   (created by this application, never a broadcast the teacher scheduled);
 * - no active Recording / Live row (any lecture, either feature) uses it.
 * Anything not meeting all of them (missing fields included) is left alone.
 *
 * Concurrency: every row that references a broadcast is created or reused by
 * a start, and every start of this teacher holds the teacher lock held here,
 * so no start can be between creating a broadcast and writing its row while
 * this runs; the rows read here are complete.
 *
 * Fails closed: if the list (any page) or a deletion fails, nothing more is
 * deleted and the start is refused (503, retryable; a timeout is 503
 * YOUTUBE_TIMEOUT; an expired authorization is 401). A delete answered "not
 * found" is already gone. No reusable stream yet: nothing can be bound to it.
 */
export async function cleanUpLeftoverBroadcastsBeforeStart(teacherId: string): Promise<void> {
  const connection = await prisma.youTubeConnection.findUnique({
    where: { teacherId },
    select: { refreshTokenEncrypted: true, liveStreamId: true },
  });

  if (!connection?.liveStreamId) return;

  const { refreshTokenEncrypted, liveStreamId } = connection;
  let upcoming: YouTubeLiveBroadcast[];

  try {
    upcoming = await listUpcomingYouTubeLiveBroadcasts(refreshTokenEncrypted);
  } catch (error) {
    if (error instanceof YouTubeReauthorizationRequiredError) throw error;
    if (error instanceof YouTubeRequestTimeoutError) throw error;

    console.error("Pre-start YouTube cleanup could not list upcoming broadcasts; start refused:", { teacherId, error });
    throw prestartCleanupError();
  }

  const candidates = upcoming.filter(broadcast =>
    typeof broadcast?.id === "string" && broadcast.id.length > 0 &&
    broadcast.contentDetails?.boundStreamId === liveStreamId &&
    typeof broadcast.snippet?.description === "string" &&
    broadcast.snippet.description.startsWith(SLCLASSROOM_BROADCAST_DESCRIPTION_PREFIX) &&
    (broadcast.status?.lifeCycleStatus === "ready" || broadcast.status?.lifeCycleStatus === "created"));

  if (candidates.length === 0) return;

  const inUseArgs = {
    where: { broadcastId: { in: candidates.map(broadcast => broadcast.id) }, status: { in: ACTIVE } },
    select: { broadcastId: true },
  };
  const [recordings, lives] = await Promise.all([
    prisma.youTubeRecording.findMany(inUseArgs),
    prisma.youTubeLiveBroadcast.findMany(inUseArgs),
  ]);
  const inUse = new Set([...recordings, ...lives].map(row => row.broadcastId));

  for (const broadcast of candidates) {
    if (inUse.has(broadcast.id)) continue;

    try {
      await deleteYouTubeLiveBroadcast(refreshTokenEncrypted, broadcast.id);
    } catch (error) {
      if (error instanceof YouTubeApiError && error.status === 404) continue;
      if (error instanceof YouTubeReauthorizationRequiredError) throw error;
      if (error instanceof YouTubeRequestTimeoutError) throw error;

      console.error("Pre-start YouTube cleanup could not delete a leftover broadcast; start refused:", {
        teacherId,
        broadcastId: broadcast.id,
        error,
      });
      throw prestartCleanupError();
    }

    console.warn("Pre-start YouTube cleanup deleted a leftover broadcast that never started:", {
      teacherId,
      broadcastId: broadcast.id,
      lifecycleStatus: broadcast.status?.lifeCycleStatus,
    });
  }
}

/** A never-live broadcast YouTube has not removed yet (nothing was changed; retryable). */
const cleanupPendingError = () =>
  new AppError(
    "YouTube has not removed this unused broadcast yet, so nothing was changed. Please try again in a moment.",
    503,
    "YOUTUBE_BROADCAST_CLEANUP_PENDING"
  );

/** As when YouTube fails to complete a live broadcast (Stop retries it). */
const stopFailedError = () =>
  new AppError(
    "YouTube did not stop the broadcast, so nothing was changed. Please try again in a moment.",
    503,
    "YOUTUBE_BROADCAST_STOP_FAILED"
  );

/**
 * Ends a broadcast no other feature uses.
 * - live / testing / starting on YouTube: completed; a failure is refused
 *   (503) so the teacher can retry — nothing is marked ended while YouTube
 *   may still be broadcasting.
 * - ready / created (never went live): completion is attempted; if YouTube
 *   refuses it for a broadcast that never started, the broadcast is removed
 *   (cleanUpNeverLiveBroadcast) and "never-live" is returned only once
 *   YouTube no longer has it; otherwise refused (503), nothing is changed.
 * - complete / revoked: already over.
 * - not found on YouTube: gone.
 * A lookup that fails for any other reason is refused (503), never treated
 * as "over". A request that timed out (503 YOUTUBE_TIMEOUT) is never taken as
 * an answer either: YouTube may or may not have applied it.
 */
async function endOwnBroadcast(
  refreshTokenEncrypted: string,
  broadcastId: string,
  // Called right before the `complete` request is sent (Stop and failed-start
  // cleanup protect the broadcast: markCompleteRequested). Not used by session
  // cleanup / reconciliation, whose rows are never reused.
  options: { beforeComplete?: () => Promise<void> } = {}
): Promise<{ outcome: "completed" | "already-ended" | "gone" | "never-live"; lifecycleStatus?: string }> {
  let lifecycleStatus: string | undefined;

  try {
    const broadcast = await getYouTubeLiveBroadcast(refreshTokenEncrypted, broadcastId);
    lifecycleStatus = broadcast.status?.lifeCycleStatus;
  } catch (error) {
    if (error instanceof YouTubeReauthorizationRequiredError) throw error;
    if (error instanceof YouTubeRequestTimeoutError) throw error;

    if (error instanceof Error && error.message.includes("not found")) {
      return { outcome: "gone" };
    }

    console.error("YouTube broadcast lookup failed while ending a feature:", { broadcastId, error });

    throw new AppError(
      "Couldn't reach YouTube to check this broadcast, so nothing was stopped. Please try again in a moment.",
      503,
      "YOUTUBE_BROADCAST_CHECK_FAILED"
    );
  }

  if (lifecycleStatus === "complete" || lifecycleStatus === "revoked") {
    return { outcome: "already-ended", lifecycleStatus };
  }

  await options.beforeComplete?.();

  try {
    const answer = await transitionYouTubeLiveBroadcast(refreshTokenEncrypted, broadcastId, "complete");

    // The lifecycle YouTube reported in its answer (may be absent): only a
    // terminal one confirms the end (endedOnYouTube). Session cleanup only
    // reads `outcome`.
    return {
      outcome: "completed",
      // Only an answer about this very broadcast counts.
      lifecycleStatus: answer?.id === broadcastId ? answer.status?.lifeCycleStatus : undefined,
    };
  } catch (error) {
    if (error instanceof YouTubeReauthorizationRequiredError) throw error;
    // No answer is not a refusal: the broadcast may have been completed, or
    // may still go live. Never tolerated as "never went live".
    if (error instanceof YouTubeRequestTimeoutError) throw error;

    // YouTube itself refused the transition for a broadcast that never went
    // live: it is removed (guarded: looked up again, deleted only while ready
    // / created), so it cannot stay bound to the reusable stream and start
    // with a later class. "never-live" only once YouTube no longer has it. A
    // network failure, a server error or any other answer leaves it unknown
    // whether the broadcast was completed (or may still go live): refused
    // below, nothing is marked ended.
    if ((lifecycleStatus === "ready" || lifecycleStatus === "created") && isNeverLiveRefusal(error)) {
      console.warn("YouTube refused to complete a broadcast that never went live; removing it:", {
        broadcastId,
        lifecycleStatus,
      });

      const cleanup = await cleanUpNeverLiveBroadcast(refreshTokenEncrypted, broadcastId);

      switch (cleanup.result) {
        case "deleted":
          return { outcome: "never-live", lifecycleStatus };
        case "gone":
          return { outcome: "gone" };
        case "ended":
          return { outcome: "already-ended", lifecycleStatus: cleanup.broadcast.status?.lifeCycleStatus };
        default:
          // Started meanwhile: as a live broadcast YouTube did not complete
          // (Stop is retried). Otherwise: not removed yet. Nothing changes.
          throw cleanup.started ? stopFailedError() : cleanupPendingError();
      }
    }

    console.error("YouTube broadcast could not be completed:", { broadcastId, lifecycleStatus, error });

    throw stopFailedError();
  }
}

async function loadOwnedLecture(teacherId: string, lectureId: string, feature: YouTubeFeature) {
  const lecture = await prisma.lecture.findUnique({
    where: { id: lectureId },
    include: { class: { select: { teacherId: true } } },
  });

  if (!lecture) {
    throw new AppError("Lecture not found.", 404, "LECTURE_NOT_FOUND");
  }

  if (lecture.class.teacherId !== teacherId) {
    // As before: Live answers "not found", Recording "not authorized".
    throw feature === "live"
      ? new AppError("Lecture not found.", 404, "LECTURE_NOT_FOUND")
      : new AppError("You are not authorized to stop this recording.", 403, "FORBIDDEN");
  }

  return lecture;
}

async function loadConnection(teacherId: string) {
  const connection = await prisma.youTubeConnection.findUnique({ where: { teacherId } });

  if (!connection) {
    throw new AppError("YouTube connection not found.", 404, "YOUTUBE_CONNECTION_NOT_FOUND");
  }

  return connection;
}

const rowKey = (feature: YouTubeFeature) => (feature === "recording" ? "recordingId" : "liveBroadcastId");

/**
 * YouTube itself reported the broadcast complete / revoked (its answer to our
 * `complete`, or a lookup), or a never-live broadcast was removed (deleted, or
 * the delete answered "not found": "never-live" is returned only then): the
 * late-`complete` protection may be cleared. A successful transition whose
 * answer reports anything else (live, ready, none) is not a confirmation. Not
 * "gone" (not found by a lookup).
 */
const endedOnYouTube = (ended: { outcome: string; lifecycleStatus?: string }) =>
  ((ended.outcome === "completed" || ended.outcome === "already-ended") && isTerminalLifecycle(ended.lifecycleStatus)) ||
  ended.outcome === "never-live";

/**
 * YouTube answered our `complete` with HTTP success, but its answer does not
 * report THIS broadcast as complete / revoked (live, ready, unknown, missing,
 * or another broadcast): HTTP success alone is not proof. Nothing is closed;
 * the late-`complete` protection stays (a later fresh lookup decides).
 */
function stopUnconfirmedError(feature: YouTubeFeature) {
  return new AppError(
    feature === "live"
      ? "YouTube has not confirmed that the live stream ended, so it may still be running. Please check again in a moment."
      : "YouTube has not confirmed that the recording ended, so it may still be running. Please check again in a moment.",
    503,
    "YOUTUBE_STOP_UNCONFIRMED"
  );
}

const answeredButUnconfirmed = (ended: { outcome: string; lifecycleStatus?: string }) =>
  ended.outcome === "completed" && !endedOnYouTube(ended);

/**
 * Stop's row was reused by a start (a new version) after this Stop read it:
 * only possible if this Stop stalled past its lock. That newer feature is not
 * this Stop's to end; nothing was closed.
 */
const stopRowChangedError = () =>
  new AppError(
    "The YouTube recording or live stream was restarted while it was being stopped. Please check its state and try again.",
    409,
    "YOUTUBE_FEATURE_CHANGED"
  );

/**
 * Stop's close, pinned to the version Stop read. Not closed because it is
 * already closed (a status check, which takes no lock, saw YouTube end it):
 * as before, nothing more to do. Not closed because it is active at another
 * version (a newer generation): refused, nothing changed.
 */
async function closeStoppedRow(feature: YouTubeFeature, row: FeatureRow, status: YouTubeBroadcastStatus) {
  if (await closeRow(feature, row.id, status, { kind: "version", value: row.version })) return;

  const current = await findRowById(feature, row.lectureId, row.id);

  if (current && ACTIVE.includes(current.status)) {
    throw stopRowChangedError();
  }
}

/**
 * Stop Recording / Stop Live. Idempotent: a feature that is not active
 * answers success with nothing to do. Response fields of the previous routes
 * are kept (recordingId, broadcastId, youtubeUrl, status, message).
 */
export async function stopYouTubeFeature(
  teacherId: string,
  lectureId: string,
  feature: YouTubeFeature
) {
  const lecture = await loadOwnedLecture(teacherId, lectureId, feature);

  return withLectureYouTubeLock(lectureId, async () => {
    const row = await findActiveRow(feature, lecture.id);

    if (!row) {
      return {
        success: true,
        message: feature === "recording"
          ? "No active YouTube recording exists."
          : "No active YouTube Live broadcast exists.",
        broadcastCompleted: false,
        stopJibri: !(await isOtherYouTubeFeatureActive(feature, lecture.id)),
      };
    }

    const connection = await loadConnection(lecture.class.teacherId);

    // Every close below is pinned to the version read here (as failed-start
    // cleanup and the departure do): a Stop that stalled past its lock never
    // closes a newer generation a start made meanwhile (closeStoppedRow).

    // Shared broadcast: the other feature still uses it. End only this feature.
    if (await findActiveSharedFeature(feature, row.broadcastId)) {
      await closeStoppedRow(feature, row, YouTubeBroadcastStatus.COMPLETE);

      if (feature === "live") {
        emitLiveChange({ classId: lecture.classId, kind: "youtube", event: "ended" });
      }

      return {
        success: true,
        [rowKey(feature)]: row.id,
        broadcastId: row.broadcastId,
        youtubeUrl: row.youtubeUrl,
        status: "COMPLETE",
        ...(feature === "recording" ? { sharedWithLive: true } : { sharedWithRecording: true }),
        broadcastCompleted: false,
        stopJibri: false,
      };
    }

    // Its own broadcast. A failed YouTube call throws before the row changes;
    // the broadcast is protected first (a timed-out `complete` may still be
    // applied: no start reuses it until YouTube is seen to end it).
    const ended = await endOwnBroadcast(connection.refreshTokenEncrypted, row.broadcastId, {
      beforeComplete: async () => markCompleteRequested(row.broadcastId, await serverNow()),
    });

    // Only YouTube's own report that this broadcast ended closes the row.
    if (answeredButUnconfirmed(ended)) {
      throw stopUnconfirmedError(feature);
    }

    // A newer generation (reused meanwhile) throws: nothing closed, the protection stays.
    await closeStoppedRow(
      feature,
      row,
      ended.outcome === "gone" ? YouTubeBroadcastStatus.REVOKED : YouTubeBroadcastStatus.COMPLETE
    );

    if (endedOnYouTube(ended)) {
      await clearCompleteRequested(row.broadcastId);
    }

    if (feature === "live") {
      emitLiveChange({ classId: lecture.classId, kind: "youtube", event: "ended" });
    }

    return {
      success: true,
      [rowKey(feature)]: row.id,
      broadcastId: row.broadcastId,
      youtubeUrl: row.youtubeUrl,
      status: ended.outcome === "gone" ? "REVOKED" : ended.lifecycleStatus?.toUpperCase(),
      ...(ended.outcome === "gone"
        ? { message: "This broadcast no longer exists on YouTube; it has been marked as ended." }
        : {}),
      broadcastCompleted: true,
      stopJibri: !(await isOtherYouTubeFeatureActive(feature, lecture.id)),
    };
  });
}

/**
 * Cleanup after a start whose Jibri stream did not confirm (timeout / error).
 *
 * Only the row the failed start created or reactivated is given (the page
 * sends it only when the start said `ownsRow`). The broadcast rule is the
 * normal stop rule, decided NOW (not when the start ran): if another active
 * feature still uses the broadcast, only this row is closed; otherwise the
 * broadcast is ended first, whether or not this start created it (e.g. it
 * shared the other feature's broadcast and that feature stopped meanwhile).
 *
 * Another tab / device may have reused the row after this start made it: its
 * start then incremented the row's `version`. The page sends the version its
 * start reported (`rowVersion`); if the row is no longer at that version, it
 * is in use by that other start: nothing is closed or completed, and Jibri
 * must not be stopped (`reused: true`, `stopJibri: false`). Only a start that
 * reuses or reactivates the row changes `version`; status syncs, privacy and
 * recording visibility/access changes do not. (A legacy ISO token from a page
 * loaded before the version counter is compared with `updatedAt` instead.)
 *
 * The row is closed only once YouTube confirmed the broadcast is over (or
 * explicitly refused a never-live one). A YouTube failure, timeout, missing
 * connection or expired authorization throws (503 / 404 / 401) and leaves
 * the row active: the page reports the cleanup as pending and keeps Stop
 * available, and session cleanup / reconciliation can finish it later.
 */
export async function abortYouTubeFeatureStart(
  teacherId: string,
  lectureId: string,
  feature: YouTubeFeature,
  rowId: string,
  // The row version the failed start reported (older pages: not sent).
  rowVersion?: RowVersionToken
) {
  const lecture = await loadOwnedLecture(teacherId, lectureId, feature);

  return withLectureYouTubeLock(lectureId, async () => {
    const row = await findRowById(feature, lecture.id, rowId);

    if (!row || !ACTIVE.includes(row.status)) {
      return {
        success: true,
        aborted: false,
        broadcastCompleted: false,
        stopJibri: !(await isOtherYouTubeFeatureActive(feature, lecture.id)),
      };
    }

    const reusedAnswer = {
      success: true,
      aborted: false,
      reused: true,
      broadcastCompleted: false,
      stopJibri: false,
    };

    // Reused by another start since: it is that start's now.
    if (rowVersion && !rowIsAt(row, rowVersion)) {
      return reusedAnswer;
    }

    const shared = await findActiveSharedFeature(feature, row.broadcastId);
    let broadcastCompleted = false;
    let endedConfirmed = false;

    if (!shared) {
      // Throws, before anything changes, when YouTube does not confirm.
      const connection = await loadConnection(lecture.class.teacherId);
      const ended = await endOwnBroadcast(connection.refreshTokenEncrypted, row.broadcastId, {
        beforeComplete: async () => markCompleteRequested(row.broadcastId, await serverNow()),
      });

      // Only YouTube's own report that this broadcast ended closes the row.
      if (answeredButUnconfirmed(ended)) {
        throw stopUnconfirmedError(feature);
      }

      broadcastCompleted = ended.outcome !== "never-live";
      endedConfirmed = endedOnYouTube(ended);
    }

    // REVOKED: this start never became an active feature. Conditional on
    // the version too (starts hold this lock, so it cannot change between
    // the check above and here; the condition keeps it that way). The token
    // was checked above; the close is pinned to the version the row had then,
    // because the late-`complete` protection written meanwhile changes
    // updatedAt (a legacy token compares that).
    const closeToken: RowVersionToken | undefined = rowVersion ? { kind: "version", value: row.version } : undefined;

    if (!(await closeRow(feature, row.id, YouTubeBroadcastStatus.REVOKED, closeToken))) {
      // Not closed (reused meanwhile): the protection stays.
      return reusedAnswer;
    }

    // Cleared only after the row closed, and only on YouTube's confirmed end.
    if (endedConfirmed) {
      await clearCompleteRequested(row.broadcastId);
    }

    if (feature === "live") {
      emitLiveChange({ classId: lecture.classId, kind: "youtube", event: "ended" });
    }

    return {
      success: true,
      aborted: true,
      [rowKey(feature)]: row.id,
      broadcastCompleted,
      stopJibri: !(await isOtherYouTubeFeatureActive(feature, lecture.id)),
    };
    // Bounded below the page's own wait for this request, so the page
    // normally gets the real answer instead of retrying into the lock.
  }, { budgetMs: youtubeTimeouts.startAbortMs });
}

/* ------------------------------------------------------------------------ *
 * Ending features when the class session ends
 * ------------------------------------------------------------------------ */

export type YouTubeSessionCleanupResult =
  | { status: "none" | "done" | "skipped"; closed: number; reason?: string }
  /**
   * Not (fully) done; nothing was pretended. Rows whose broadcast YouTube did
   * not confirm as ended stay active, and are reconciled by the next start
   * of this lecture (reconcileStaleYouTubeFeatures), a Stop, or the status
   * checks that read YouTube.
   */
  | {
    status: "pending";
    closed: number;
    /**
     * youtube: YouTube refused or failed; timeout: YouTube did not answer in
     * time; reauth-required: the teacher's YouTube authorization expired (the
     * connection is marked REAUTH_REQUIRED; nothing is retried until the
     * teacher reconnects).
     */
    reason: "lock-busy" | "youtube" | "timeout" | "reauth-required" | "error";
    pendingBroadcastIds: string[];
  };

type LectureForCleanup = { id: string; classId: string; class: { teacherId: string } };

type ActiveFeatureRow = { feature: YouTubeFeature; id: string; broadcastId: string; createdAt: Date };

async function findActiveFeatureRows(lectureId: string): Promise<ActiveFeatureRow[]> {
  const args = {
    where: { lectureId, status: { in: ACTIVE } },
    select: { id: true, broadcastId: true, createdAt: true },
  };

  const [recordings, lives] = await Promise.all([
    prisma.youTubeRecording.findMany(args),
    prisma.youTubeLiveBroadcast.findMany(args),
  ]);

  return [
    ...recordings.map(row => ({ feature: "recording" as const, ...row })),
    ...lives.map(row => ({ feature: "live" as const, ...row })),
  ];
}

/**
 * Ends the given active feature rows of a lecture. Call only while holding
 * the lecture's lock. Per YouTube broadcast: completed at most once, and only
 * when no active row outside `selected` still uses it (then the selected rows
 * are just closed, the broadcast stays for the feature that needs it). Rows
 * are closed only after YouTube confirmed the broadcast is over (completed,
 * already ended, never went live, or gone); a YouTube failure leaves them
 * active and reports the broadcast as pending.
 */
async function endFeatureRows(
  lecture: LectureForCleanup,
  selected: (row: ActiveFeatureRow) => boolean
): Promise<{ closed: number; pendingBroadcastIds: string[]; timedOut: boolean; reauthRequired: boolean }> {
  const all = await findActiveFeatureRows(lecture.id);
  const ending = all.filter(selected);

  if (ending.length === 0) {
    return { closed: 0, pendingBroadcastIds: [], timedOut: false, reauthRequired: false };
  }

  const connection = await prisma.youTubeConnection.findUnique({
    where: { teacherId: lecture.class.teacherId },
  });

  const byBroadcast = new Map<string, ActiveFeatureRow[]>();

  ending.forEach(row => {
    byBroadcast.set(row.broadcastId, [...(byBroadcast.get(row.broadcastId) ?? []), row]);
  });

  let closed = 0;
  let liveEnded = false;
  let timedOut = false;
  // Already known to need reconnecting: Google is not asked again (it would
  // answer invalid_grant every time).
  let reauthRequired = connection?.status === "REAUTH_REQUIRED";
  const pendingBroadcastIds: string[] = [];

  for (const [broadcastId, rows] of byBroadcast) {
    const stillNeeded = all.some(row => row.broadcastId === broadcastId && !ending.includes(row));
    let rowStatus: YouTubeBroadcastStatus = YouTubeBroadcastStatus.COMPLETE;

    if (!stillNeeded) {
      if (!connection || reauthRequired) {
        pendingBroadcastIds.push(broadcastId);
        continue;
      }

      try {
        const ended = await endOwnBroadcast(connection.refreshTokenEncrypted, broadcastId);

        if (ended.outcome === "gone") {
          rowStatus = YouTubeBroadcastStatus.REVOKED;
        }
      } catch (error) {
        console.error("Session-end YouTube cleanup could not end a broadcast; left for reconciliation:", {
          lectureId: lecture.id,
          broadcastId,
          error,
        });
        timedOut = timedOut || error instanceof YouTubeRequestTimeoutError;
        reauthRequired = reauthRequired || error instanceof YouTubeReauthorizationRequiredError;
        pendingBroadcastIds.push(broadcastId);
        continue;
      }
    }

    for (const row of rows) {
      if (await closeRow(row.feature, row.id, rowStatus)) {
        closed += 1;
        liveEnded = liveEnded || row.feature === "live";
      }
    }
  }

  if (liveEnded) {
    emitLiveChange({ classId: lecture.classId, kind: "youtube", event: "ended" });
  }

  return { closed, pendingBroadcastIds, timedOut, reauthRequired };
}

/** The teacher must reconnect YouTube (as the start / stop routes record it). */
async function markReauthRequired(teacherId: string) {
  await prisma.youTubeConnection
    .updateMany({ where: { teacherId }, data: { status: "REAUTH_REQUIRED" } })
    .catch(error => console.error("Failed to mark YouTube connection as REAUTH_REQUIRED:", error));
}

/**
 * The class session of a lecture ended (End Session, or a session replaced by
 * a newer one): end every active Recording / Live of the lecture. Best effort
 * and never throws: ending the session must not depend on YouTube. Runs
 * under the lecture's YouTube lock (taken here; never call it while holding
 * that lock). A busy lock or a YouTube failure leaves the rows as they are and
 * returns "pending" (reconciled by the next start of the lecture).
 */
export async function endYouTubeFeaturesForLecture(
  teacherId: string,
  lectureId: string
): Promise<YouTubeSessionCleanupResult> {
  try {
    const lecture = await prisma.lecture.findUnique({
      where: { id: lectureId },
      select: { id: true, classId: true, class: { select: { teacherId: true } } },
    });

    // Only the lecture's own teacher's session end touches its features.
    if (!lecture || lecture.class.teacherId !== teacherId) {
      return { status: "skipped", closed: 0, reason: "not this teacher's lecture" };
    }

    // Bounded (sessionCleanupMs): a stalled YouTube cannot hold up ending or
    // starting a class session; whatever it did not confirm stays pending.
    return await withLectureYouTubeLock(lectureId, async () => {
      const { closed, pendingBroadcastIds, timedOut, reauthRequired } = await endFeatureRows(lecture, () => true);

      if (pendingBroadcastIds.length > 0) {
        if (reauthRequired) {
          await markReauthRequired(lecture.class.teacherId);
        }

        return {
          status: "pending" as const,
          reason: reauthRequired
            ? ("reauth-required" as const)
            : timedOut ? ("timeout" as const) : ("youtube" as const),
          closed,
          pendingBroadcastIds,
        };
      }

      return { status: closed > 0 ? ("done" as const) : ("none" as const), closed };
    }, {
      budgetMs: youtubeTimeouts.sessionCleanupMs,
      // A start / stop / cleanup holding the lock usually ends within
      // seconds: a few bounded retries before reporting "pending".
      acquireRetryDelaysMs: youtubeTimeouts.sessionCleanupLockRetriesMs,
    });
  } catch (error) {
    const lockBusy = error instanceof AppError && error.code === "YOUTUBE_OPERATION_IN_PROGRESS";

    console.error(
      lockBusy
        ? "Session-end YouTube cleanup skipped: another YouTube action holds the lecture lock; left for reconciliation."
        : "Session-end YouTube cleanup failed; left for reconciliation:",
      { lectureId, error: lockBusy ? undefined : error }
    );

    return {
      status: "pending",
      closed: 0,
      reason: lockBusy ? "lock-busy" : "error",
      pendingBroadcastIds: [],
    };
  }
}

/* ------------------------------------------------------------------------ *
 * Ending features when the teacher closed the classroom tab
 * ------------------------------------------------------------------------ */

/** Why a feature the departure stop tried to end is still active. */
export type TeacherDeparturePendingReason =
  /** YouTube refused, failed, or did not answer a lookup in time. */
  | "youtube"
  /**
   * The last `complete` transition we sent got no answer in time: YouTube
   * may or may not have applied it (ambiguous, see youTubeEndedCloseData).
   */
  | "timeout"
  /** The teacher's YouTube authorization expired (marked REAUTH_REQUIRED). */
  | "reauth-required"
  /** Its broadcast is still used by a row the departure does not cover. */
  | "shared-broadcast"
  /**
   * Automatic retries gave up (DEPARTURE_MAX_TRANSITIONS sent, or
   * DEPARTURE_UNRESOLVED_AFTER_MS since the tab closed) without YouTube
   * confirming the end. Still looked up (rarely); needs the teacher's Stop,
   * YouTube Studio or an operator. Never reported as stopped.
   */
  | "unresolved";

export type TeacherDepartureStopResult =
  | {
    status: "skipped";
    reason:
      | "lecture-not-found"
      | "no-active-session"
      /** No tab-close signal for the session. */
      | "no-departure"
      /** A signal within its reload-confirmation window. */
      | "departure-pending"
      /** A signal cancelled by teacher activity (a refresh, another tab). */
      | "departure-cancelled"
      | "no-active-features";
  }
  /** Another YouTube action (a Stop, a start, another sweeper) holds the lecture lock: retried later. */
  | { status: "busy" }
  /** It could not run (database error): nothing was changed or claimed. */
  | { status: "error" }
  | {
    /** done: every feature of the departure ended on YouTube; pending: some did not (retried). */
    status: "done" | "pending";
    sessionId: string;
    /**
     * Rows closed now: TEACHER_LEFT when this stop's transition ended the
     * broadcast; YOUTUBE_ENDED (or no reason) when YouTube ended it otherwise.
     */
    stopped: YouTubeFeature[];
    /** Still active, with why; nothing was claimed for them. */
    pending: { feature: YouTubeFeature; reason: TeacherDeparturePendingReason }[];
    /**
     * True when anything ended: only the YouTube broadcast was ended. Jibri
     * is stopped by the teacher's browser, which has gone, so it may still
     * be streaming the classroom (students still connected).
     */
    jibriMayStillRun: boolean;
  };

/**
 * A `complete` transition we sent may still be applied by YouTube for this
 * long: no second one for the broadcast before it has passed (whichever
 * process, request or restart asks), and no start may use the broadcast
 * meanwhile. Also how long after our send a YouTube completion can still be
 * counted as ours (youTubeEndedCloseData).
 */
export const TRANSITION_RESEND_COOLDOWN_MS = DEPARTURE_TRANSITION_APPLY_WINDOW_MS;

/**
 * Adaptive schedule for a departure stop YouTube has not confirmed, from the
 * database only (no timers or memory): how often YouTube is looked up
 * (liveBroadcasts.list) again, by time since the tab-close signal, measured
 * from the last departure lookup (autoStopCheckedAt: nothing else writes it,
 * so no unrelated update postpones a check). Plus ONE check
 * DEPARTURE_CHECK_AFTER_SEND_MS after each transition we sent (it may have
 * been applied after we stopped waiting). The teacher's return always looks
 * up at once (lookupNow). The transition (a write) is resent only on such a
 * check, by DEPARTURE_RESEND_SCHEDULE, never within
 * TRANSITION_RESEND_COOLDOWN_MS.
 */
export const DEPARTURE_LOOKUP_SCHEDULE: { untilAgeMs: number; everyMs: number }[] = [
  { untilAgeMs: 5 * 60_000, everyMs: 30_000 },
  { untilAgeMs: 30 * 60_000, everyMs: 2 * 60_000 },
  { untilAgeMs: 2 * 60 * 60_000, everyMs: 5 * 60_000 },
  { untilAgeMs: Infinity, everyMs: 15 * 60_000 },
];

/** The one extra check after a transition was sent. */
export const DEPARTURE_CHECK_AFTER_SEND_MS = 15_000;

/** Resend interval by time since the tab-close signal: 60 s for 5 minutes, then 5 min, then 15 min. */
export const DEPARTURE_RESEND_SCHEDULE: { untilAgeMs: number; everyMs: number }[] = [
  { untilAgeMs: 5 * 60_000, everyMs: TRANSITION_RESEND_COOLDOWN_MS },
  { untilAgeMs: 30 * 60_000, everyMs: 5 * 60_000 },
  { untilAgeMs: Infinity, everyMs: 15 * 60_000 },
];

/**
 * Automatic transitions stop after this many for one feature generation, or
 * this long after the tab closed: the stop becomes "unresolved" (an explicit
 * state, logged once with its diagnostics). Lookups go on by the schedule, so
 * a later end on YouTube is still recorded accurately.
 */
export const DEPARTURE_MAX_TRANSITIONS = 10;
export const DEPARTURE_UNRESOLVED_AFTER_MS = 2 * 60 * 60_000;

const scheduled = (schedule: { untilAgeMs: number; everyMs: number }[], ageMs: number) =>
  schedule.find(step => ageMs < step.untilAgeMs)!.everyMs;

/**
 * No transition is sent with less of the operation's time left than this (it
 * could not be answered): a fifth of a normal request's limit (2 s).
 */
const minTransitionTimeMs = () => youtubeTimeouts.requestMs / 5;

type DepartedSession = {
  id: string;
  startedAt: Date;
  teacherDepartureAt: Date;
  teacherActiveAfterDepartureAt: Date | null;
};

const SKIP_REASON: Record<Exclude<DepartureState, "confirmed">, "no-departure" | "departure-pending" | "departure-cancelled"> = {
  none: "no-departure",
  pending: "departure-pending",
  cancelled: "departure-cancelled",
};

const departureSelect = { id: true, startedAt: true, teacherDepartureAt: true, teacherActiveAfterDepartureAt: true };

/** The lecture's current class session, if its teacher's tab-close is confirmed by `now`. */
async function findDepartedSession(lectureId: string, now: Date) {
  const session = await prisma.classSession.findFirst({
    where: { lectureId, isActive: true },
    orderBy: { startedAt: "desc" },
    select: departureSelect,
  });

  if (!session) return { session: null, reason: "no-active-session" as const };

  const state = departureState(session, now);

  if (state !== "confirmed") {
    return { session: null, reason: SKIP_REASON[state] };
  }

  return { session: session as DepartedSession, reason: null };
}

/**
 * Rows the departure covers: the session's, whose current feature
 * GENERATION started before the tab closed (generationStartedAt; createdAt for
 * rows from before generations were recorded). A start that reuses or
 * reactivates a row begins a new generation (newFeatureGeneration): the old
 * departure no longer covers it, whatever its row ID or broadcast. Every
 * departure write is also conditional on the `version` read.
 */
const activeAtDeparture = (
  session: DepartedSession,
  row: { createdAt: Date; generationStartedAt?: Date | null }
) =>
  row.createdAt >= session.startedAt &&
  (row.generationStartedAt ?? row.createdAt) < session.teacherDepartureAt;

type DepartureRow = ActiveFeatureRow & {
  version: number;
  generationStartedAt: Date | null;
  autoStopAttemptedAt: Date | null;
  autoStopError: string | null;
  autoStopCheckedAt: Date | null;
  autoStopSendCount: number;
  completeRequestedAt: Date | null;
};

/** Active rows of the lecture, with their generation and the departure state of that generation. */
async function findActiveDepartureRows(lectureId: string): Promise<DepartureRow[]> {
  const args = {
    where: { lectureId, status: { in: ACTIVE } },
    select: {
      id: true, broadcastId: true, createdAt: true, version: true, generationStartedAt: true,
      autoStopAttemptedAt: true, autoStopError: true, autoStopCheckedAt: true, autoStopSendCount: true,
      completeRequestedAt: true,
    },
  };

  const [recordings, lives] = await Promise.all([
    prisma.youTubeRecording.findMany(args),
    prisma.youTubeLiveBroadcast.findMany(args),
  ]);

  return [
    ...recordings.map(row => ({ feature: "recording" as const, ...row })),
    ...lives.map(row => ({ feature: "live" as const, ...row })),
  ];
}

type DepartureWrite = {
  autoStopError: string;
  autoStopAttemptedAt?: Date;
  autoStopCheckedAt?: Date;
  autoStopLastError?: string;
  countSend?: boolean;
};

/**
 * Writes on rows still active AND still at the generation this departure
 * read (a start's reuse meanwhile changes `version`: nothing is written).
 * Returns how many rows were written.
 */
async function updateActiveRows(rows: DepartureRow[], write: DepartureWrite): Promise<number> {
  const { countSend, ...fields } = write;
  let written = 0;

  for (const row of rows) {
    const args = {
      where: { id: row.id, status: { in: ACTIVE }, version: row.version },
      data: { ...fields, ...(countSend ? { autoStopSendCount: { increment: 1 } } : {}) },
    };

    written += (row.feature === "recording"
      ? await prisma.youTubeRecording.updateMany(args)
      : await prisma.youTubeLiveBroadcast.updateMany(args)).count;
  }

  return written;
}

/**
 * A transition was recorded as sent (autoStopAttemptedAt, autoStopError
 * "timeout", autoStopSendCount + 1) but never dispatched: each row's send
 * state is written back to the values read before (rows still active and at
 * the generation read only). The diagnostic is kept in autoStopLastError.
 */
async function restoreUnsentRows(rows: DepartureRow[], lastError: string): Promise<void> {
  for (const row of rows) {
    const args = {
      where: { id: row.id, status: { in: ACTIVE }, version: row.version },
      data: {
        autoStopAttemptedAt: row.autoStopAttemptedAt,
        autoStopError: row.autoStopError,
        autoStopSendCount: row.autoStopSendCount,
        autoStopLastError: lastError.slice(0, 500),
      },
    };

    if (row.feature === "recording") {
      await prisma.youTubeRecording.updateMany(args);
    } else {
      await prisma.youTubeLiveBroadcast.updateMany(args);
    }
  }
}

type BroadcastOutcome = {
  closed: DepartureRow[];
  pending: { row: DepartureRow; reason: TeacherDeparturePendingReason }[];
  reauthRequired: boolean;
};

const PENDING_REASONS: TeacherDeparturePendingReason[] = ["youtube", "timeout", "reauth-required", "shared-broadcast", "unresolved"];

const pendingAll = (rows: DepartureRow[], reason: TeacherDeparturePendingReason, reauthRequired = false): BroadcastOutcome =>
  ({ closed: [], pending: rows.map(row => ({ row, reason })), reauthRequired });

/** What the rows say about why they are still active (shown in the notice). */
const currentReason = (rows: DepartureRow[]): TeacherDeparturePendingReason => {
  const reason = rows.find(row => row.autoStopError)?.autoStopError;

  return PENDING_REASONS.includes(reason as TeacherDeparturePendingReason)
    ? (reason as TeacherDeparturePendingReason)
    : "youtube";
};

/** A short diagnostic of a YouTube failure (stored in autoStopLastError). */
function describeFailure(step: "lookup" | "token" | "transition" | "delete", error: unknown): string {
  const detail = error instanceof YouTubeApiError
    ? `HTTP ${error.status}${error.reason ? " " + error.reason : ""}`
    : error instanceof YouTubeRequestTimeoutError
      ? "no answer in time"
      : error instanceof YouTubeReauthorizationRequiredError
        ? "authorization expired"
        : error instanceof Error ? error.message : String(error);

  return `${step}: ${detail}`.slice(0, 500);
}

async function closeDepartureRows(
  rows: DepartureRow[],
  status: YouTubeBroadcastStatus,
  closeData: CloseData
): Promise<BroadcastOutcome> {
  const closed: DepartureRow[] = [];

  for (const row of rows) {
    // Only at the generation read: a restarted feature is never closed here.
    if (await closeRow(row.feature, row.id, status, { kind: "version", value: row.version }, closeData)) closed.push(row);
  }

  return { closed, pending: [], reauthRequired: false };
}

const lastSentMs = (rows: DepartureRow[]) => Math.max(0, ...rows.map(row => row.autoStopAttemptedAt?.getTime() ?? 0));

/**
 * Whether YouTube should be asked about these rows now (the adaptive
 * schedule; state in the database only). Never looked up by a departure yet:
 * at once, so the first stop is prompt. Otherwise from the last departure
 * lookup (autoStopCheckedAt), which nothing else writes.
 */
function isCheckDue(rows: DepartureRow[], departureAt: Date, nowMs: number) {
  const checks = rows.map(row => row.autoStopCheckedAt?.getTime() ?? 0);

  if (checks.every(at => at === 0)) return true;

  const lastSent = lastSentMs(rows);
  const lastCheck = Math.max(...checks);

  // The one check after a send (not done yet, and its time has come).
  if (lastSent && lastCheck < lastSent + DEPARTURE_CHECK_AFTER_SEND_MS && nowMs >= lastSent + DEPARTURE_CHECK_AFTER_SEND_MS) {
    return true;
  }

  return nowMs - lastCheck >= scheduled(DEPARTURE_LOOKUP_SCHEDULE, nowMs - departureAt.getTime());
}

/** Automatic transitions have given up for this generation (see DEPARTURE_MAX_TRANSITIONS). */
function hasGivenUp(rows: DepartureRow[], departureAt: Date, nowMs: number) {
  return Math.max(...rows.map(row => row.autoStopSendCount ?? 0)) >= DEPARTURE_MAX_TRANSITIONS ||
    nowMs - departureAt.getTime() >= DEPARTURE_UNRESOLVED_AFTER_MS;
}

/** Whether a transition may be sent (again): never within the cooldown, then by the resend schedule. */
function isResendDue(rows: DepartureRow[], departureAt: Date, nowMs: number) {
  const lastSent = lastSentMs(rows);

  if (!lastSent) return true;

  const interval = Math.max(TRANSITION_RESEND_COOLDOWN_MS, scheduled(DEPARTURE_RESEND_SCHEDULE, nowMs - departureAt.getTime()));

  return nowMs - lastSent >= interval;
}

/**
 * The last send's state (for youTubeEndedCloseData): from the row that holds
 * it, with the broadcast's earliest unconfirmed `complete` request on any of
 * the rows (completeRequestedAt).
 */
const lastSendState = (rows: DepartureRow[]): DepartureSendState | null => {
  const row = rows.find(row => row.autoStopError === "timeout" && row.autoStopAttemptedAt) ?? rows[0];

  if (!row) return null;

  const requested = rows.map(row => row.completeRequestedAt?.getTime()).filter((at): at is number => at !== undefined);

  return {
    autoStopAttemptedAt: row.autoStopAttemptedAt,
    autoStopError: row.autoStopError,
    completeRequestedAt: requested.length > 0 ? new Date(Math.min(...requested)) : null,
  };
};

/**
 * A fresh lookup reports the departure's broadcast complete / revoked: its rows
 * close (at the generation read; youTubeEndedCloseData decides the reason),
 * then the protection is cleared once every row closed.
 */
async function closeEndedForDeparture(
  broadcast: YouTubeLiveBroadcast,
  broadcastId: string,
  rows: DepartureRow[],
  clock: () => Date
): Promise<BroadcastOutcome> {
  const closeData = broadcast.status?.lifeCycleStatus === "complete"
    ? youTubeEndedCloseData(broadcast, clock(), lastSendState(rows))
    : {};

  // Close first (at the generation read); clear only once every row closed.
  const outcome = await closeDepartureRows(rows, YouTubeBroadcastStatus.COMPLETE, closeData);

  if (outcome.closed.length === rows.length) {
    await clearCompleteRequested(broadcastId);
  }

  return outcome;
}

/**
 * The departure's broadcast never went live (YouTube refused to complete a
 * ready / created one, or the transitions gave up on one): removed by
 * cleanUpNeverLiveBroadcast. A delete is not a transition: nothing here
 * counts toward DEPARTURE_MAX_TRANSITIONS or changes the send time.
 *
 * - Removed (deleted, or the delete answered "not found"): the rows close
 *   COMPLETE with NO stop reason (it never went live: no TEACHER_LEFT notice),
 *   then the protection is cleared once every row closed.
 * - Not found by the fresh lookup: closed REVOKED (as the departure's lookup does).
 * - Complete / revoked now: closed as such (closeEndedForDeparture).
 * - Anything else (started meanwhile, unknown, refused, failed, no answer):
 *   nothing closes; pending `pendingReason` (the refusal was an answer, so
 *   never the ambiguous "timeout"), and the departure's normal schedule looks
 *   it up again (a broadcast deleted after all is then "not found").
 * Every write is conditional on the rows' generation.
 */
async function cleanUpNeverLiveForDeparture(
  refreshTokenEncrypted: string,
  broadcastId: string,
  rows: DepartureRow[],
  clock: () => Date,
  options: { pendingReason: "youtube" | "unresolved"; checkedAt?: Date }
): Promise<BroadcastOutcome> {
  const checked = options.checkedAt ? { autoStopCheckedAt: options.checkedAt } : {};
  let cleanup: NeverLiveCleanup;

  try {
    cleanup = await cleanUpNeverLiveBroadcast(refreshTokenEncrypted, broadcastId);
  } catch (error) {
    const reauth = error instanceof YouTubeReauthorizationRequiredError;

    if (!reauth) console.error("Teacher-departure stop: removing a never-live broadcast got no answer; retried later:", { broadcastId });

    await updateActiveRows(rows, {
      autoStopError: reauth ? "reauth-required" : options.pendingReason,
      autoStopLastError: describeFailure("delete", error),
      ...checked,
    });
    return pendingAll(rows, reauth ? "reauth-required" : options.pendingReason, reauth);
  }

  switch (cleanup.result) {
    case "deleted": {
      const outcome = await closeDepartureRows(rows, YouTubeBroadcastStatus.COMPLETE, { autoStopError: null });

      if (outcome.closed.length === rows.length) {
        await clearCompleteRequested(broadcastId);
      }

      return outcome;
    }
    case "gone":
      return closeDepartureRows(rows, YouTubeBroadcastStatus.REVOKED, {});
    case "ended":
      return closeEndedForDeparture(cleanup.broadcast, broadcastId, rows, clock);
    default:
      await updateActiveRows(rows, {
        autoStopError: options.pendingReason,
        autoStopLastError: cleanup.detail.slice(0, 500),
        ...checked,
      });
      return pendingAll(rows, options.pendingReason);
  }
}

/**
 * Ends one YouTube broadcast for the departure (all covered rows on it:
 * Recording and Live sharing it get ONE transition). Under the lecture lock,
 * inside withYouTubeAccessTokenReuse. Never throws a YouTube error. Every
 * write is conditional on the rows' generation; every time is the database
 * clock (`clock`).
 *
 * 1. Lookup (unless the schedule says it is not due: isCheckDue), recorded
 *    in autoStopCheckedAt. Already complete / revoked: closed
 *    (youTubeEndedCloseData). Not found: closed REVOKED, no reason.
 * 2. Gave up (hasGivenUp): a ready / created broadcast (never went live) is
 *    removed (cleanUpNeverLiveForDeparture: not a transition, so the cap does
 *    not apply); otherwise, or if not removed, stays pending "unresolved";
 *    logged once.
 * 3. Not resent before isResendDue: never within
 *    TRANSITION_RESEND_COOLDOWN_MS of our last send (autoStopAttemptedAt,
 *    written by any process before it sends), then by the resend schedule.
 * 4. The send time is written on the rows BEFORE sending (autoStopError
 *    "timeout": no answer yet), and only if it was written on every row at
 *    the generation read: otherwise nothing is sent.
 * 5. Answered: closed TEACHER_LEFT. A never-live broadcast YouTube refused to
 *    complete (invalidTransition) is removed instead (guarded delete), its
 *    rows closed with no stop reason (cleanUpNeverLiveForDeparture). No
 *    answer in time: stays pending "timeout". Refused / failed: pending
 *    "youtube" (not ours if it ends). Failures are kept in autoStopLastError.
 */
async function endBroadcastForDeparture(
  refreshTokenEncrypted: string,
  broadcastId: string,
  rows: DepartureRow[],
  departureAt: Date,
  options: { lookupNow: boolean; clock: () => Date }
): Promise<BroadcastOutcome> {
  const { clock } = options;

  if (!options.lookupNow && !isCheckDue(rows, departureAt, clock().getTime())) {
    return pendingAll(rows, currentReason(rows));
  }

  const checkedAt = clock();
  let broadcast: YouTubeLiveBroadcast;

  try {
    broadcast = await getYouTubeLiveBroadcast(refreshTokenEncrypted, broadcastId);
  } catch (error) {
    if (error instanceof YouTubeReauthorizationRequiredError) {
      await updateActiveRows(rows, {
        autoStopError: "reauth-required", autoStopCheckedAt: checkedAt, autoStopLastError: describeFailure("lookup", error),
      });
      return pendingAll(rows, "reauth-required", true);
    }

    if (!(error instanceof YouTubeRequestTimeoutError) && error instanceof Error && error.message.includes("not found")) {
      return closeDepartureRows(rows, YouTubeBroadcastStatus.REVOKED, {});
    }

    console.error("Teacher-departure stop could not look up a broadcast; retried later:", { broadcastId, error });

    // A failed lookup does not change what is known about the last send.
    const reason = currentReason(rows) === "unresolved" ? "unresolved" : "youtube";

    await updateActiveRows(rows, {
      autoStopError: reason, autoStopCheckedAt: checkedAt, autoStopLastError: describeFailure("lookup", error),
    });
    return pendingAll(rows, reason);
  }

  const lifecycleStatus = broadcast.status?.lifeCycleStatus;

  if (lifecycleStatus === "complete" || lifecycleStatus === "revoked") {
    return closeEndedForDeparture(broadcast, broadcastId, rows, clock);
  }

  if (hasGivenUp(rows, departureAt, clock().getTime())) {
    if (lifecycleStatus === "ready" || lifecycleStatus === "created") {
      // Never went live: removing it is not a transition, so the transition
      // cap does not apply to it (guarded: looked up again, deleted only
      // while ready / created). Not removed: reported unresolved below.
      const cleaned = await cleanUpNeverLiveForDeparture(refreshTokenEncrypted, broadcastId, rows, clock, {
        checkedAt,
        pendingReason: "unresolved",
      });

      if (cleaned.pending.length === 0 || cleaned.reauthRequired) {
        return cleaned;
      }
    }

    if (currentReason(rows) !== "unresolved") {
      console.error("Teacher-departure stop UNRESOLVED: automatic retries gave up; needs Stop, YouTube Studio or an operator:", {
        broadcastId,
        rows: rows.map(row => ({
          feature: row.feature, id: row.id, sends: row.autoStopSendCount, lastSentAt: row.autoStopAttemptedAt, lastReason: row.autoStopError,
        })),
        departureAt,
      });
    }

    await updateActiveRows(rows, { autoStopError: "unresolved", autoStopCheckedAt: checkedAt });
    return pendingAll(rows, "unresolved");
  }

  if (!isResendDue(rows, departureAt, clock().getTime())) {
    // Checked (autoStopCheckedAt) for the schedule; the earlier transition may still apply.
    const reason = lastSentMs(rows) ? currentReason(rows) : "youtube";

    await updateActiveRows(rows, { autoStopError: reason, autoStopCheckedAt: checkedAt });
    return pendingAll(rows, reason);
  }

  if (youtubeDeadlineRemainingMs() < minTransitionTimeMs()) {
    await updateActiveRows(rows, { autoStopError: currentReason(rows), autoStopCheckedAt: checkedAt });
    return pendingAll(rows, currentReason(rows));
  }

  // The token first: the transition below reuses it, so nothing between the
  // write and the send can fail without the request being sent.
  try {
    await getYouTubeAccessToken(refreshTokenEncrypted);
  } catch (error) {
    const reauth = error instanceof YouTubeReauthorizationRequiredError;

    if (!reauth) console.error("Teacher-departure stop could not get a YouTube token; retried later:", { broadcastId, error });

    await updateActiveRows(rows, {
      autoStopError: reauth ? "reauth-required" : "youtube",
      autoStopCheckedAt: checkedAt,
      autoStopLastError: describeFailure("token", error),
    });
    return pendingAll(rows, reauth ? "reauth-required" : "youtube", reauth);
  }

  const marked = await updateActiveRows(rows, {
    autoStopAttemptedAt: clock(), autoStopError: "timeout", autoStopCheckedAt: checkedAt, countSend: true,
  });

  if (marked < rows.length) {
    // A row changed since it was read (closed, or restarted by a start): not sent.
    return pendingAll(rows, currentReason(rows));
  }

  // Protected before the request (a timeout leaves it: YouTube may still apply it).
  await markCompleteRequested(broadcastId, clock());

  let completed: YouTubeLiveBroadcast;

  try {
    completed = await transitionYouTubeLiveBroadcast(refreshTokenEncrypted, broadcastId, "complete", {
      timeoutMs: youtubeTimeouts.transitionMs,
    });
  } catch (error) {
    if (error instanceof YouTubeRequestTimeoutError && !error.dispatched) {
      // Never dispatched (the deadline passed before the request was handed
      // to fetch, e.g. slow database writes above): nothing reached YouTube.
      // Not a sent transition: each row's send state goes back to what was
      // read (send time, count, last outcome; at the generation read), so no
      // cooldown, start refusal or TEACHER_LEFT attribution follows from it.
      // The protection marker stays (it is only ever cleared by a confirmed end).
      console.error("Teacher-departure stop: the transition was not sent (no time left); retried later:", { broadcastId });
      await restoreUnsentRows(rows, describeFailure("transition", error) + " (not sent)");
      return pendingAll(rows, currentReason(rows));
    }

    if ((lifecycleStatus === "ready" || lifecycleStatus === "created") && isNeverLiveRefusal(error)) {
      // An answer (a refusal): nothing of it can still apply. The broadcast
      // never went live: removed (guarded), never reported as a stop of a
      // live broadcast.
      return cleanUpNeverLiveForDeparture(refreshTokenEncrypted, broadcastId, rows, clock, {
        pendingReason: "youtube",
      });
    }

    if (error instanceof YouTubeRequestTimeoutError) {
      // Sent, unanswered: YouTube may still apply it. Left as "timeout".
      console.error("Teacher-departure stop: YouTube did not answer the transition in time (it may still apply it):", { broadcastId });
      await updateActiveRows(rows, { autoStopError: "timeout", autoStopLastError: describeFailure("transition", error) });
      return pendingAll(rows, "timeout");
    }

    const reauth = error instanceof YouTubeReauthorizationRequiredError;

    if (!reauth) console.error("Teacher-departure stop: YouTube did not complete the broadcast; retried later:", { broadcastId, error });

    await updateActiveRows(rows, {
      autoStopError: reauth ? "reauth-required" : "youtube",
      autoStopLastError: describeFailure("transition", error),
    });
    return pendingAll(rows, reauth ? "reauth-required" : "youtube", reauth);
  }

  // HTTP success alone is not proof: only an answer about THIS broadcast that
  // reports it complete / revoked is. Otherwise (live, ready, unknown,
  // missing, another broadcast, no body) the rows stay active and protected,
  // as after an unanswered request: YouTube may still apply it, and the next
  // fresh lookup decides ("timeout": the outcome is not known).
  const answeredStatus = completed?.id === broadcastId ? completed.status?.lifeCycleStatus : undefined;

  if (!isTerminalLifecycle(answeredStatus)) {
    console.error("Teacher-departure stop: YouTube answered the transition without confirming the end; retried later:", {
      broadcastId,
      answeredId: completed?.id ?? null,
      lifeCycleStatus: completed?.status?.lifeCycleStatus ?? null,
    });

    await updateActiveRows(rows, {
      autoStopError: "timeout",
      autoStopLastError: (completed?.id === broadcastId
        ? `transition: answered without confirming the end (${answeredStatus ?? "no status"})`
        : `transition: answered about another broadcast (${completed?.id ?? "no id"})`).slice(0, 500),
    });
    return pendingAll(rows, "timeout");
  }

  // Confirmed. The rows close first (at the generation read; a database error
  // propagates: nothing is cleared); the protection is cleared only once every
  // row closed.
  const outcome = await closeDepartureRows(rows, YouTubeBroadcastStatus.COMPLETE, {
    stopReason: YouTubeFeatureStopReason.TEACHER_LEFT,
    endedAt: youTubeActualEndTime(completed) ?? clock(),
    autoStopError: null,
  });

  if (outcome.closed.length === rows.length) {
    await clearCompleteRequested(broadcastId);
  }

  return outcome;
}

/**
 * Under the lecture lock, before a Recording / Live start in the lecture's
 * current session (startInCurrentSession). Times are the database clock.
 *
 * The start is the teacher's own action in this classroom: teacher activity
 * (within the 15 s window it cancels a pending tab-close signal; after it, it
 * is the return). A restart while an earlier departure stop is unresolved is
 * allowed: the start's reuse / reactivation of a covered row begins a new
 * generation (newFeatureGeneration), which that departure never covers, and
 * a start that shares a covered row's broadcast makes the departure leave
 * that broadcast alone (it is used outside the departure).
 *
 * Refused (409, retry) only while a departure transition was sent to any
 * covered broadcast less than TRANSITION_RESEND_COOLDOWN_MS ago: YouTube may
 * still apply it, and the start could use that very broadcast. Nothing about
 * that transition is assumed: after the interval, the start's own lookup
 * (checkExistingBroadcast) decides whether the broadcast is still usable.
 */
export async function assertNoDepartureStopBeforeStart(
  lectureId: string,
  sessionId: string,
  at?: Date
): Promise<void> {
  const now = at ?? await serverNow();
  const before = await prisma.classSession.findFirst({
    where: { id: sessionId, isActive: true },
    select: departureSelect,
  });

  if (!before) return;

  // Never before the signal (a defence: all times are on the database clock).
  const seenAt = new Date(Math.max(now.getTime(), before.teacherDepartureAt?.getTime() ?? 0));

  await recordTeacherActivity(sessionId, null, seenAt);

  const session = await prisma.classSession.findFirst({
    where: { id: sessionId, isActive: true },
    select: departureSelect,
  });

  if (!session) return;

  const state = departureState(
    session,
    new Date(Math.max(seenAt.getTime(), session.teacherActiveAfterDepartureAt?.getTime() ?? 0))
  );

  if (state === "pending") {
    // The activity above could not be recorded: the departure may still be confirmed.
    throw new AppError(
      "Your classroom is reconnecting. Please try again in a moment.",
      409,
      "YOUTUBE_DEPARTURE_STOP_PENDING"
    );
  }

  if (state !== "confirmed") return;

  const inFlight = (await findActiveDepartureRows(lectureId))
    .filter(row => activeAtDeparture(session as DepartedSession, row))
    .filter(row => row.autoStopAttemptedAt && now.getTime() - row.autoStopAttemptedAt.getTime() < TRANSITION_RESEND_COOLDOWN_MS);

  if (inFlight.length === 0) return;

  const waitSeconds = Math.ceil(Math.max(...inFlight.map(row =>
    TRANSITION_RESEND_COOLDOWN_MS - (now.getTime() - row.autoStopAttemptedAt!.getTime()))) / 1000);
  const names = Array.from(new Set(inFlight.map(row => (row.feature === "live" ? "Live" : "Recording")))).join(" and ");

  throw new AppError(
    `Your earlier YouTube ${names} is being stopped right now because you closed the classroom. Please try again in ${waitSeconds} seconds.`,
    409,
    "YOUTUBE_DEPARTURE_STOP_PENDING"
  );
}

/**
 * The teacher of the lecture's current class session closed the classroom
 * tab (a tab-close signal confirmed by its reload window: lib/teacher-presence.ts):
 * end the Recording / Live generations that were active when the tab closed,
 * on YouTube. The class session, its students and End Session are not touched.
 *
 * - Only rows of the session whose generation started before the signal, at
 *   the generation read: anything the teacher started or restarted after
 *   coming back is theirs. Rows whose broadcast another active row still
 *   uses are not ended (pending "shared-broadcast").
 * - Each broadcast is ended by endBroadcastForDeparture: YouTube is asked by
 *   an adaptive schedule (`lookupNow` for the teacher's return), at most one
 *   transition per resend interval (never within TRANSITION_RESEND_COOLDOWN_MS),
 *   the send recorded first, until DEPARTURE_MAX_TRANSITIONS /
 *   DEPARTURE_UNRESOLVED_AFTER_MS ("unresolved"); rows close only once
 *   YouTube confirmed the end. When nothing is due, it returns the recorded
 *   state without taking the lock or asking YouTube. The broadcasts are ended
 *   side by side, with one Google access token for the whole stop.
 * - stopReason TEACHER_LEFT only for this stop's own transition (answered,
 *   or a later completion youTubeEndedCloseData accepts); a broadcast
 *   YouTube ended otherwise is YOUTUBE_ENDED (no departure notice).
 * - Runs under the lecture's lock, never waiting for it: a busy lock returns
 *   "busy". The departure is checked again under the lock. All YouTube
 *   requests end within departureStopMs and before the lock's safety margin.
 * - Times are the database clock (lib/server-clock.ts).
 * - An expired authorization marks the connection REAUTH_REQUIRED and is not
 *   sent to Google again until the teacher reconnects.
 * - Jibri is NOT stopped (no server-side way to): see jibriMayStillRun.
 *
 * Never throws.
 */
export async function endYouTubeFeaturesForDepartedTeacher(
  lectureId: string,
  at?: Date,
  options: { lookupNow?: boolean } = {}
): Promise<TeacherDepartureStopResult> {
  const lookupNow = options.lookupNow ?? false;

  try {
    const now = at ?? await serverNow();
    // YouTube timing (send, check, cooldown): the database clock, moving on.
    const clock = serverNowSync;

    const lecture = await prisma.lecture.findUnique({
      where: { id: lectureId },
      select: { id: true, classId: true, class: { select: { teacherId: true } } },
    });

    if (!lecture) {
      return { status: "skipped", reason: "lecture-not-found" };
    }

    // Cheap checks first: no lock is taken without a confirmed departure,
    // while nothing it covers is active, or while YouTube is not due to be
    // asked about any of it (all checked again under the lock).
    const before = await findDepartedSession(lectureId, now);

    if (!before.session) {
      return { status: "skipped", reason: before.reason };
    }

    const departed = before.session;
    const coveredBefore = (await findActiveDepartureRows(lectureId)).filter(row => activeAtDeparture(departed, row));

    if (coveredBefore.length === 0) {
      return { status: "skipped", reason: "no-active-features" };
    }

    if (!lookupNow && !coveredBefore.some(row => isCheckDue([row], departed.teacherDepartureAt, clock().getTime()))) {
      return {
        status: "pending",
        sessionId: departed.id,
        stopped: [],
        pending: coveredBefore.map(row => ({ feature: row.feature, reason: currentReason([row]) })),
        jibriMayStillRun: false,
      };
    }

    return await withLectureYouTubeLock(lectureId, async (): Promise<TeacherDepartureStopResult> => {
      const found = await findDepartedSession(lectureId, now);

      if (!found.session) {
        return { status: "skipped", reason: found.reason };
      }

      const session = found.session;
      const all = await findActiveDepartureRows(lectureId);
      const covered = all.filter(row => activeAtDeparture(session, row));

      if (covered.length === 0) {
        return { status: "skipped", reason: "no-active-features" };
      }

      // The classroom's Jibri may outlive these features, so the teacher's
      // shutdown fence is made a confirmed one BEFORE any of them is closed
      // (lib/jibri-shutdown-gate.ts): the tab-close signal's provisional
      // fence is upgraded in every mode; a new one is armed with the mode
      // "on" (lib/jibri-fence-control.ts). If that fails, nothing is closed
      // now (retried by the next check).
      await armJibriFence(session.id, session.teacherDepartureAt, {
        armNew: armsFences((await readJibriFenceControl()).mode),
      });

      const usedOutside = new Set(all.filter(row => !activeAtDeparture(session, row)).map(row => row.broadcastId));
      const shared = covered.filter(row => usedOutside.has(row.broadcastId));
      const byBroadcast = new Map<string, DepartureRow[]>();

      for (const row of covered.filter(row => !usedOutside.has(row.broadcastId))) {
        byBroadcast.set(row.broadcastId, [...(byBroadcast.get(row.broadcastId) ?? []), row]);
      }

      await updateActiveRows(shared, { autoStopError: "shared-broadcast" });

      const connection = await prisma.youTubeConnection.findUnique({
        where: { teacherId: lecture.class.teacherId },
      });

      const groups = Array.from(byBroadcast.entries());
      let outcomes: BroadcastOutcome[];

      if (!connection) {
        outcomes = groups.map(([, rows]) => pendingAll(rows, "youtube"));
      } else if (connection.status === "REAUTH_REQUIRED") {
        // Google is not asked again until the teacher reconnects.
        outcomes = groups.map(([, rows]) => pendingAll(rows, "reauth-required", true));
      } else {
        outcomes = await withYouTubeAccessTokenReuse(() => Promise.all(
          groups.map(([broadcastId, rows]) =>
            endBroadcastForDeparture(connection.refreshTokenEncrypted, broadcastId, rows, session.teacherDepartureAt, {
              lookupNow,
              clock,
            }))
        ));
      }

      const closed = outcomes.flatMap(outcome => outcome.closed);
      const pending = [
        ...shared.map(row => ({ row, reason: "shared-broadcast" as const })),
        ...outcomes.flatMap(outcome => outcome.pending),
      ];

      if (outcomes.some(outcome => outcome.reauthRequired)) {
        await markReauthRequired(lecture.class.teacherId);
      }

      if (closed.some(row => row.feature === "live")) {
        emitLiveChange({ classId: lecture.classId, kind: "youtube", event: "ended" });
      }

      const stoppedFeatures = Array.from(new Set(closed.map(row => row.feature)));
      const pendingList = pending.map(({ row, reason }) => ({ feature: row.feature, reason }));

      if (stoppedFeatures.length > 0) {
        console.warn("Teacher closed the classroom: YouTube features ended (Jibri may still be streaming):", {
          lectureId,
          sessionId: session.id,
          stopped: stoppedFeatures,
        });
      }

      if (pending.length > 0) {
        console.error("Teacher closed the classroom: YouTube did not confirm ending these features; retried later:", {
          lectureId,
          sessionId: session.id,
          pending: pendingList,
        });
      }

      return {
        status: pending.length > 0 ? "pending" : "done",
        sessionId: session.id,
        stopped: stoppedFeatures,
        pending: pendingList,
        jibriMayStillRun: stoppedFeatures.length > 0,
      };
    }, {
      // Its own budget; the lock's deadline caps it too (departureStopMs +
      // lockSafetyMarginMs <= lockTtlMs). Never waits for a held lock.
      budgetMs: youtubeTimeouts.departureStopMs,
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "YOUTUBE_OPERATION_IN_PROGRESS") {
      return { status: "busy" };
    }

    console.error("Teacher-departure YouTube stop failed; retried by the next sweep:", { lectureId, error });

    return { status: "error" };
  }
}

/**
 * A class session of the lecture started (`sessionStartedAt`): end its
 * features left from earlier sessions (a cleanup that stayed pending), so the
 * new session starts clean instead of waiting for its first Recording / Live
 * start. Bounded like session cleanup (lock retries and YouTube requests
 * within sessionCleanupMs); never throws; nothing is reported done unless
 * YouTube confirmed it. Rows of the new session are never touched (they are
 * created after it started), and stale rows are never reused: the start gate
 * (reconcileStaleYouTubeFeatures under the start lock) still applies.
 */
export async function reconcileYouTubeFeaturesForNewSession(
  teacherId: string,
  lectureId: string,
  sessionStartedAt: Date
): Promise<YouTubeSessionCleanupResult> {
  try {
    const owned = await prisma.lecture.findUnique({
      where: { id: lectureId },
      select: { class: { select: { teacherId: true } } },
    });

    if (!owned || owned.class.teacherId !== teacherId) {
      return { status: "skipped", closed: 0, reason: "not this teacher's lecture" };
    }

    return await withLectureYouTubeLock(lectureId, async () => {
      const result = await reconcileStaleYouTubeFeatures(lectureId, sessionStartedAt);

      switch (result.status) {
        case "done":
          return { status: result.closed > 0 ? ("done" as const) : ("none" as const), closed: result.closed };
        case "reauth-required":
          await markReauthRequired(teacherId);
          return {
            status: "pending" as const,
            reason: "reauth-required" as const,
            closed: result.closed,
            pendingBroadcastIds: result.pendingBroadcastIds,
          };
        case "pending":
          return {
            status: "pending" as const,
            reason: "youtube" as const,
            closed: result.closed,
            pendingBroadcastIds: result.pendingBroadcastIds,
          };
        default:
          return { status: "pending" as const, reason: "error" as const, closed: 0, pendingBroadcastIds: [] };
      }
    }, {
      budgetMs: youtubeTimeouts.sessionCleanupMs,
      acquireRetryDelaysMs: youtubeTimeouts.sessionCleanupLockRetriesMs,
    });
  } catch (error) {
    const lockBusy = error instanceof AppError && error.code === "YOUTUBE_OPERATION_IN_PROGRESS";

    console.error("YouTube reconciliation at session start did not finish; left for the next start:", {
      lectureId,
      error: lockBusy ? "lock busy" : error,
    });

    return { status: "pending", closed: 0, reason: lockBusy ? "lock-busy" : "error", pendingBroadcastIds: [] };
  }
}

export type YouTubeReconciliationResult =
  /** No stale row is left active. */
  | { status: "done"; closed: number }
  /** Stale rows YouTube did not confirm as ended are still active. */
  | { status: "pending"; closed: number; pendingBroadcastIds: string[] }
  /**
   * Stale rows are still active because the teacher's YouTube authorization
   * expired: the start must ask the teacher to reconnect (401), not retry.
   */
  | { status: "reauth-required"; closed: number; pendingBroadcastIds: string[] }
  /** It could not run (no active session, database error): unknown. */
  | { status: "failed"; closed: 0 };

/**
 * Reconciliation, run by every Recording / Live start while it holds the
 * lecture's lock: active feature rows created BEFORE the lecture's current
 * class session started (`sessionStartedAt`; looked up when not given)
 * belong to an earlier session (its cleanup did not finish: busy lock,
 * YouTube failure, crash), not to this session's stream. They are ended like
 * a session end. Never throws. Anything but "done" means stale rows may still
 * be active: the start must not go ahead (it could reuse them).
 */
export async function reconcileStaleYouTubeFeatures(
  lectureId: string,
  sessionStartedAt?: Date
): Promise<YouTubeReconciliationResult> {
  try {
    const startedAt = sessionStartedAt ?? (await prisma.classSession.findFirst({
      where: { lectureId, isActive: true },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    }))?.startedAt;

    if (!startedAt) {
      return { status: "failed", closed: 0 };
    }

    const lecture = await prisma.lecture.findUnique({
      where: { id: lectureId },
      select: { id: true, classId: true, class: { select: { teacherId: true } } },
    });

    if (!lecture) {
      return { status: "failed", closed: 0 };
    }

    const { closed, pendingBroadcastIds, reauthRequired } =
      await endFeatureRows(lecture, row => row.createdAt < startedAt);

    if (pendingBroadcastIds.length === 0) {
      return { status: "done", closed };
    }

    return reauthRequired
      ? { status: "reauth-required", closed, pendingBroadcastIds }
      : { status: "pending", closed, pendingBroadcastIds };
  } catch (error) {
    console.error("YouTube stale-feature reconciliation failed:", { lectureId, error });
    return { status: "failed", closed: 0 };
  }
}
