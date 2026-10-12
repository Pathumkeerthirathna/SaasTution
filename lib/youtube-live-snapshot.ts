import { prisma } from "@/lib/prisma";
import { getYouTubeLiveBroadcast } from "@/lib/youtube-live";
import { YouTubeBroadcastStatus, YouTubePrivacy } from "@prisma/client";

/**
 * The classroom's "is this lecture live on YouTube" snapshot, sent as the
 * `live-status` event of GET /api/sessions/[id]/live-updates.
 */
export type LiveStatusPayload = {
  isLive: boolean;
  youtubeUrl: string | null;
};

/**
 * Who the snapshot is for. Decided by the route only AFTER authentication:
 * "teacher" = a teacher session that owns the class, "student" = an enrolled
 * student session. Never taken from the request on its own.
 */
export type LiveSnapshotAudience = "teacher" | "student";

const NOT_LIVE: LiveStatusPayload = { isLive: false, youtubeUrl: null };

// Privacies a student may be shown. A PRIVATE broadcast is only viewable by
// the channel owner (the teacher), so its status and URL never reach students.
const STUDENT_VISIBLE_PRIVACIES: YouTubePrivacy[] = [
  YouTubePrivacy.PUBLIC,
  YouTubePrivacy.UNLISTED,
];

// Only these two lifeCycleStatus values mean YouTube considers the
// broadcast definitively over. Everything else — including transitional
// states like "liveStarting"/"testStarting" that a broadcast passes
// through for a few seconds right after starting — must still count as
// ongoing. Using a deny-list here (instead of an allow-list of "known
// ongoing" statuses) means a status we didn't anticipate never gets
// mistaken for "ended" and wrongly closes out a broadcast that's still
// actually live.
// An active feature row (as everywhere in the lifecycle code).
const ACTIVE_ROW_STATUSES: YouTubeBroadcastStatus[] = [
  YouTubeBroadcastStatus.READY,
  YouTubeBroadcastStatus.LIVE,
];

// Whether the row is still active now. If the database cannot be read, the
// earlier read (active) stands.
async function isActiveRow(id: string) {
  const row = await prisma.youTubeLiveBroadcast
    .findFirst({ where: { id, status: { in: ACTIVE_ROW_STATUSES } }, select: { id: true } })
    .catch(() => ({ id }));

  return Boolean(row);
}

const ENDED_YOUTUBE_LIFECYCLE_STATUSES = new Set([
  "complete",
  "revoked",
]);

/**
 * Teacher: unchanged — the newest READY/LIVE broadcast of any privacy, shown
 * as live while YouTube does not report it ended (so "Stop Live" stays
 * available for a broadcast that is starting).
 *
 * Student: only a PUBLIC or UNLISTED broadcast that YouTube reports as
 * actually `live`. A PRIVATE broadcast, or one that is merely `ready` (created,
 * not streaming yet), is reported as not live, without a URL. If YouTube
 * cannot be asked right now, only a row already confirmed LIVE is shown.
 */
export async function getLiveSnapshot(
  lectureId: string | null,
  audience: LiveSnapshotAudience
): Promise<LiveStatusPayload> {
  if (!lectureId) {
    return NOT_LIVE;
  }

  const isStudent = audience !== "teacher";

  const liveBroadcast = await prisma.youTubeLiveBroadcast.findFirst({
    where: {
      lectureId,
      status: {
        in: [YouTubeBroadcastStatus.READY, YouTubeBroadcastStatus.LIVE],
      },
      // Students: PRIVATE rows are never even candidates.
      ...(isStudent ? { privacy: { in: STUDENT_VISIBLE_PRIVACIES } } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      broadcastId: true,
      youtubeUrl: true,
      privacy: true,
      status: true,
      lecture: { select: { class: { select: { teacherId: true } } } },
    },
  });

  // No candidate row in YouTubeLiveBroadcast at all — nothing is live.
  if (!liveBroadcast) {
    return NOT_LIVE;
  }

  // Defence in depth: whatever the query returned, a student never gets a
  // PRIVATE broadcast.
  if (isStudent && !STUDENT_VISIBLE_PRIVACIES.includes(liveBroadcast.privacy)) {
    return NOT_LIVE;
  }

  // A database row alone isn't trusted: confirm the teacher's YouTube
  // channel still reports this exact broadcast as ongoing before telling
  // the client to show "Stop Live". A teacher without a live YouTube
  // connection has nothing to verify against.
  const connection = await prisma.youTubeConnection.findUnique({
    where: { teacherId: liveBroadcast.lecture.class.teacherId },
    select: { refreshTokenEncrypted: true },
  });

  if (!connection) {
    return NOT_LIVE;
  }

  try {
    const broadcast = await getYouTubeLiveBroadcast(
      connection.refreshTokenEncrypted,
      liveBroadcast.broadcastId
    );

    const lifeCycleStatus = broadcast.status?.lifeCycleStatus;

    if (lifeCycleStatus && ENDED_YOUTUBE_LIFECYCLE_STATUSES.has(lifeCycleStatus)) {
      // The channel says this broadcast has ended (or was revoked) even
      // though our row still looked active — self-heal the stale row so
      // future checks don't keep re-verifying it against YouTube.
      await prisma.youTubeLiveBroadcast
        .updateMany({
          where: { id: liveBroadcast.id, status: { in: ACTIVE_ROW_STATUSES } },
          data: { status: YouTubeBroadcastStatus.COMPLETE, endedAt: new Date() },
        })
        .catch(() => {});

      return NOT_LIVE;
    }

    // The row was read before YouTube was asked; a Stop may have closed it
    // meanwhile. Promoted only while still READY (a stale answer never
    // reactivates a closed row), and shown only while still active.
    let promoted = 0;

    if (
      lifeCycleStatus === "live" &&
      liveBroadcast.status !== YouTubeBroadcastStatus.LIVE
    ) {
      // A status sync, not a reuse: the row's `version` is not touched.
      ({ count: promoted } = await prisma.youTubeLiveBroadcast
        .updateMany({
          where: { id: liveBroadcast.id, status: YouTubeBroadcastStatus.READY },
          data: { status: YouTubeBroadcastStatus.LIVE },
        })
        .catch(() => ({ count: 0 })));
    }

    if (promoted !== 1 && !(await isActiveRow(liveBroadcast.id))) {
      return NOT_LIVE;
    }

    // Students: only a broadcast YouTube reports as actually live.
    if (isStudent && lifeCycleStatus !== "live") {
      return NOT_LIVE;
    }

    return { isLive: true, youtubeUrl: liveBroadcast.youtubeUrl };
  } catch (error) {
    console.error(
      "Failed to verify YouTube broadcast status against the channel:",
      error
    );

    // A "not found" response is a definitive signal — YouTube has deleted
    // or expired this broadcast — so self-heal the stale row instead of
    // leaving it stuck as READY/LIVE forever. Any other failure (network
    // blip, YouTube API hiccup) is inconclusive, so fall back to trusting
    // the database row rather than hiding "Stop Live" for a class that may
    // well still be live.
    const broadcastDefinitelyGone =
      error instanceof Error && error.message.includes("not found");

    if (broadcastDefinitelyGone) {
      await prisma.youTubeLiveBroadcast
        .updateMany({
          where: { id: liveBroadcast.id, status: { in: ACTIVE_ROW_STATUSES } },
          data: { status: YouTubeBroadcastStatus.REVOKED, endedAt: new Date() },
        })
        .catch(() => {});

      return NOT_LIVE;
    }

    // Students: fall back only to a row already confirmed LIVE (a READY row
    // may never have gone live).
    if (isStudent && liveBroadcast.status !== YouTubeBroadcastStatus.LIVE) {
      return NOT_LIVE;
    }

    // The lookup may have taken long (up to its time limit): only a row
    // that is still active is reported.
    if (!(await isActiveRow(liveBroadcast.id))) {
      return NOT_LIVE;
    }

    return { isLive: true, youtubeUrl: liveBroadcast.youtubeUrl };
  }
}
