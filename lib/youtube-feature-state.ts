import { prisma } from "@/lib/prisma";
import { YouTubeBroadcastStatus } from "@prisma/client";

/*
 * Shared broadcasts.
 *
 * Recording and Live can use the SAME Unlisted YouTube broadcast. That
 * relationship is persisted without extra columns: a YouTubeRecording row and
 * a YouTubeLiveBroadcast row with the same `broadcastId` (unique within each
 * table, so at most one row of each per broadcast). Each feature is active
 * while its own row is READY / LIVE. Stopping a feature ends only its row; the
 * YouTube broadcast is completed only when the other table has no active row
 * for it any more. A reload therefore finds the relationship in the database.
 */
export type YouTubeFeature = "recording" | "live";

export const ACTIVE_FEATURE_STATUSES: YouTubeBroadcastStatus[] = [
    YouTubeBroadcastStatus.READY,
    YouTubeBroadcastStatus.LIVE,
];

/** The OTHER feature's active row on this exact YouTube broadcast, or null. */
export async function findActiveSharedFeature(
    feature: YouTubeFeature,
    broadcastId: string
) {
    const where = {
        broadcastId,
        status: { in: ACTIVE_FEATURE_STATUSES },
    };
    const select = { id: true, lectureId: true, broadcastId: true, status: true };

    return feature === "recording"
        ? prisma.youTubeLiveBroadcast.findFirst({ where, select })
        : prisma.youTubeRecording.findFirst({ where, select });
}

/**
 * Whether the OTHER feature is still active for this lecture on any broadcast
 * (shared or separate). Jitsi runs one Jibri stream per conference, feeding
 * the teacher's one reusable YouTube stream, so Jibri may only be stopped when
 * neither feature is active any more.
 */
export async function isOtherYouTubeFeatureActive(
    feature: YouTubeFeature,
    lectureId: string
): Promise<boolean> {
    const where = {
        lectureId,
        status: { in: ACTIVE_FEATURE_STATUSES },
    };
    const select = { id: true };

    const row = feature === "recording"
        ? await prisma.youTubeLiveBroadcast.findFirst({ where, select })
        : await prisma.youTubeRecording.findFirst({ where, select });

    return Boolean(row);
}
