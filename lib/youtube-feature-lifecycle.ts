import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import { emitLiveChange } from "@/lib/session-events";
import { YouTubeReauthorizationRequiredError } from "@/lib/youtube-auth";
import {
  getYouTubeLiveBroadcast,
  transitionYouTubeLiveBroadcast,
} from "@/lib/youtube-live";
import {
  findActiveSharedFeature,
  isOtherYouTubeFeatureActive,
  type YouTubeFeature,
} from "@/lib/youtube-feature-state";
import { withLectureYouTubeLock } from "@/lib/youtube-operation-lock";
import { YouTubeApiError, YouTubeRequestTimeoutError, youtubeTimeouts } from "@/lib/youtube-request";
import { YouTubeBroadcastStatus } from "@prisma/client";

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
async function closeRow(feature: YouTubeFeature, id: string, status: YouTubeBroadcastStatus, token?: RowVersionToken) {
  const args = {
    where: { id, status: { in: ACTIVE }, ...versionCondition(token) },
    data: { status, endedAt: new Date() },
  };

  const result = feature === "recording"
    ? await prisma.youTubeRecording.updateMany(args)
    : await prisma.youTubeLiveBroadcast.updateMany(args);

  return result.count > 0;
}

/**
 * YouTube's explicit refusal to complete a broadcast that cannot make that
 * transition (it never went live): HTTP 403, reason "invalidTransition".
 * Anything else is not taken as a refusal.
 */
const isNeverLiveRefusal = (error: unknown) =>
  error instanceof YouTubeApiError && error.status === 403 && error.reason === "invalidTransition";

/**
 * Ends a broadcast no other feature uses.
 * - live / testing / starting on YouTube: completed; a failure is refused
 *   (503) so the teacher can retry — nothing is marked ended while YouTube
 *   may still be broadcasting.
 * - ready / created (never went live): completion is attempted, but YouTube
 *   may refuse it for a broadcast that never started; that is tolerated.
 * - complete / revoked: already over.
 * - not found on YouTube: gone.
 * A lookup that fails for any other reason is refused (503), never treated
 * as "over". A request that timed out (503 YOUTUBE_TIMEOUT) is never taken as
 * an answer either: YouTube may or may not have applied it.
 */
async function endOwnBroadcast(
  refreshTokenEncrypted: string,
  broadcastId: string
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

  try {
    await transitionYouTubeLiveBroadcast(refreshTokenEncrypted, broadcastId, "complete");

    return { outcome: "completed", lifecycleStatus: "complete" };
  } catch (error) {
    if (error instanceof YouTubeReauthorizationRequiredError) throw error;
    // No answer is not a refusal: the broadcast may have been completed, or
    // may still go live. Never tolerated as "never went live".
    if (error instanceof YouTubeRequestTimeoutError) throw error;

    // Tolerated only when YouTube itself refused the transition for a
    // broadcast that never went live. A network failure, a server error or
    // any other answer leaves it unknown whether the broadcast was completed
    // (or may still go live): refused below, nothing is marked ended.
    if ((lifecycleStatus === "ready" || lifecycleStatus === "created") && isNeverLiveRefusal(error)) {
      console.warn("YouTube refused to complete a broadcast that never went live (tolerated):", {
        broadcastId,
        lifecycleStatus,
      });

      return { outcome: "never-live", lifecycleStatus };
    }

    console.error("YouTube broadcast could not be completed:", { broadcastId, lifecycleStatus, error });

    throw new AppError(
      "YouTube did not stop the broadcast, so nothing was changed. Please try again in a moment.",
      503,
      "YOUTUBE_BROADCAST_STOP_FAILED"
    );
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

    // Shared broadcast: the other feature still uses it. End only this feature.
    if (await findActiveSharedFeature(feature, row.broadcastId)) {
      await closeRow(feature, row.id, YouTubeBroadcastStatus.COMPLETE);

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

    // Its own broadcast. A failed YouTube call throws before anything changes.
    const ended = await endOwnBroadcast(connection.refreshTokenEncrypted, row.broadcastId);

    await closeRow(
      feature,
      row.id,
      ended.outcome === "gone" ? YouTubeBroadcastStatus.REVOKED : YouTubeBroadcastStatus.COMPLETE
    );

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

    if (!shared) {
      // Throws, before anything changes, when YouTube does not confirm.
      const connection = await loadConnection(lecture.class.teacherId);
      const ended = await endOwnBroadcast(connection.refreshTokenEncrypted, row.broadcastId);

      broadcastCompleted = ended.outcome !== "never-live";
    }

    // REVOKED: this start never became an active feature. Conditional on
    // the version too (starts hold this lock, so it cannot change between
    // the check above and here; the condition keeps it that way).
    if (!(await closeRow(feature, row.id, YouTubeBroadcastStatus.REVOKED, rowVersion))) {
      return reusedAnswer;
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
