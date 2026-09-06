import { requireStudentSession, requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { prisma } from "@/lib/prisma";
import { subscribeLiveChanges } from "@/lib/session-events";
import { getYouTubeLiveBroadcast } from "@/lib/youtube-live";
import { YouTubeBroadcastStatus } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toSseChunk(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

type LiveStatusPayload = {
  isLive: boolean;
  youtubeUrl: string | null;
};

// Only these two lifeCycleStatus values mean YouTube considers the
// broadcast definitively over. Everything else — including transitional
// states like "liveStarting"/"testStarting" that a broadcast passes
// through for a few seconds right after starting — must still count as
// ongoing. Using a deny-list here (instead of an allow-list of "known
// ongoing" statuses) means a status we didn't anticipate never gets
// mistaken for "ended" and wrongly closes out a broadcast that's still
// actually live.
const ENDED_YOUTUBE_LIFECYCLE_STATUSES = new Set([
  "complete",
  "revoked",
]);

async function getLiveSnapshot(
  lectureId: string | null
): Promise<LiveStatusPayload> {
  if (!lectureId) {
    return { isLive: false, youtubeUrl: null };
  }

  const liveBroadcast = await prisma.youTubeLiveBroadcast.findFirst({
    where: {
      lectureId,
      status: {
        in: [YouTubeBroadcastStatus.READY, YouTubeBroadcastStatus.LIVE],
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      broadcastId: true,
      youtubeUrl: true,
      status: true,
      lecture: { select: { class: { select: { teacherId: true } } } },
    },
  });

  // No candidate row in YouTubeLiveBroadcast at all — nothing is live.
  if (!liveBroadcast) {
    return { isLive: false, youtubeUrl: null };
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
    return { isLive: false, youtubeUrl: null };
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
        .update({
          where: { id: liveBroadcast.id },
          data: { status: YouTubeBroadcastStatus.COMPLETE, endedAt: new Date() },
        })
        .catch(() => {});

      return { isLive: false, youtubeUrl: null };
    }

    if (
      lifeCycleStatus === "live" &&
      liveBroadcast.status !== YouTubeBroadcastStatus.LIVE
    ) {
      await prisma.youTubeLiveBroadcast
        .update({
          where: { id: liveBroadcast.id },
          data: { status: YouTubeBroadcastStatus.LIVE },
        })
        .catch(() => {});
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
        .update({
          where: { id: liveBroadcast.id },
          data: { status: YouTubeBroadcastStatus.REVOKED, endedAt: new Date() },
        })
        .catch(() => {});

      return { isLive: false, youtubeUrl: null };
    }

    return { isLive: true, youtubeUrl: liveBroadcast.youtubeUrl };
  }
}

export async function GET(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const sessionId = context.params.id;

    if (!sessionId?.trim()) {
      throw new AppError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    const { searchParams } = new URL(request.url);
    const role = searchParams.get("role")?.trim();

    const classSession = await prisma.classSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        classId: true,
        lectureId: true,
        class: { select: { teacherId: true } },
      },
    });

    if (!classSession) {
      throw new AppError("Class session not found.", 404, "SESSION_NOT_FOUND");
    }

    if (role === "teacher") {
      const teacherSession = await requireTeacherSession();

      if (classSession.class.teacherId !== teacherSession.teacherId) {
        throw new AppError("Session not found.", 404, "SESSION_NOT_FOUND");
      }
    } else {
      const studentSession = await requireStudentSession();

      const enrolled = await prisma.student.findFirst({
        where: {
          id: studentSession.studentId,
          status: 0,
          classes: {
            some: {
              classId: classSession.classId,
              isActive: true,
            },
          },
        },
        select: { id: true },
      });

      if (!enrolled) {
        throw new AppError(
          "Student is not enrolled in this class.",
          403,
          "STUDENT_NOT_IN_CLASS"
        );
      }
    }

    const { classId, lectureId } = classSession;

    const encoder = new TextEncoder();
    let cleanup = () => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;

        const send = (event: string, payload: unknown) => {
          if (closed) {
            return;
          }

          controller.enqueue(encoder.encode(toSseChunk(event, payload)));
        };

        // Covers a client connecting after the stream already started.
        getLiveSnapshot(lectureId)
          .then((snapshot) => send("live-status", snapshot))
          .catch(() => {
            send("live-status", { isLive: false, youtubeUrl: null });
          });

        const unsubscribe = subscribeLiveChanges((payload) => {
          if (payload.classId !== classId || payload.kind !== "youtube") {
            return;
          }

          if (payload.event === "ended") {
            send("live-status", { isLive: false, youtubeUrl: null });
            return;
          }

          getLiveSnapshot(lectureId)
            .then((snapshot) => send("live-status", snapshot))
            .catch(() => {});
        });

        const keepAliveIntervalId = setInterval(() => {
          send("ping", { timestamp: new Date().toISOString() });
        }, 15_000);

        cleanup = () => {
          if (closed) {
            return;
          }

          closed = true;
          clearInterval(keepAliveIntervalId);
          unsubscribe();
          request.signal.removeEventListener("abort", cleanup);
          controller.close();
        };

        request.signal.addEventListener("abort", cleanup);
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
