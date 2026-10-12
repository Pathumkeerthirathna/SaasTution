import { prisma } from "@/lib/prisma";

/**
 * Saves the teacher's YouTube connection after OAuth (create or reconnect).
 *
 * The reusable stream ID belongs to one channel: when the teacher connects a
 * DIFFERENT channel, it is cleared, so the next start creates a stream on the
 * new channel instead of using one the new channel does not have. (A start
 * creating a stream at the same moment saves it only if the connection still
 * has the channel it read; see ensureReusableStreamId.) Reconnecting the same
 * channel keeps it. Either way the connection is CONNECTED again.
 */
export async function saveYouTubeConnection(
  teacherId: string,
  connection: { channelId: string; channelTitle?: string | null; refreshTokenEncrypted: string }
) {
  const existing = await prisma.youTubeConnection.findUnique({
    where: { teacherId },
    select: { channelId: true },
  });

  const channelChanged = Boolean(existing) && existing?.channelId !== connection.channelId;

  await prisma.youTubeConnection.upsert({
    where: { teacherId },
    create: {
      teacherId,
      channelId: connection.channelId,
      channelTitle: connection.channelTitle,
      refreshTokenEncrypted: connection.refreshTokenEncrypted,
      status: "CONNECTED",
    },
    update: {
      channelId: connection.channelId,
      channelTitle: connection.channelTitle,
      refreshTokenEncrypted: connection.refreshTokenEncrypted,
      // A fresh refresh token clears any prior reauth requirement.
      status: "CONNECTED",
      ...(channelChanged ? { liveStreamId: null } : {}),
    },
  });

  return { channelChanged };
}
