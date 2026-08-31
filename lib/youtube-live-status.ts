import { prisma } from "@/lib/prisma";
import { getYouTubeLiveBroadcast } from "@/lib/youtube-live";
import { YouTubeBroadcastStatus } from "@prisma/client";

/**
 * A YouTube live broadcast that the YouTube API currently reports as `live`,
 * shaped for rendering a "Live now" card on a dashboard.
 */
export type LiveBroadcastView = {
    id: string;
    videoId: string;
    youtubeUrl: string;
    lectureTitle: string;
    className: string;
    teacherName: string;
    startedAt: string | null;
};

type GetActiveLivesOptions =
    | { teacherId: string; studentId?: undefined }
    | { studentId: string; teacherId?: undefined };

/*
 * The stored `YouTubeLiveBroadcast.status` is not a reliable signal — it is
 * written as `READY` at creation and only flips to `LIVE` in narrow cases.
 * So before showing anything we re-check the real lifecycle against the
 * YouTube Data API and reconcile our row.
 *
 * Only broadcasts created within this window are worth checking; anything
 * older is treated as stale and ignored.
 */
const CANDIDATE_WINDOW_MS = 12 * 60 * 60 * 1000;

const CANDIDATE_STATUSES: YouTubeBroadcastStatus[] = [
    YouTubeBroadcastStatus.CREATED,
    YouTubeBroadcastStatus.READY,
    YouTubeBroadcastStatus.TESTING,
    YouTubeBroadcastStatus.LIVE,
];

/**
 * Return the YouTube live broadcasts that are genuinely live right now for the
 * given teacher (all privacies) or student (PRIVATE hidden — an embedded
 * PRIVATE video cannot play for a viewer who is not the channel owner).
 *
 * Never throws: any failure resolves to `[]` so a dashboard render is safe.
 */
export async function getActiveYouTubeLives(
    options: GetActiveLivesOptions
): Promise<LiveBroadcastView[]> {
    try {
        const cutoff = new Date(Date.now() - CANDIDATE_WINDOW_MS);

        const candidates = await prisma.youTubeLiveBroadcast.findMany({
            where: {
                endedAt: null,
                status: { in: CANDIDATE_STATUSES },
                createdAt: { gte: cutoff },
                lecture:
                    options.teacherId !== undefined
                        ? { class: { teacherId: options.teacherId } }
                        : {
                              class: {
                                  students: {
                                      some: {
                                          studentId: options.studentId,
                                          isActive: true,
                                      },
                                  },
                              },
                          },
            },
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                broadcastId: true,
                videoId: true,
                youtubeUrl: true,
                privacy: true,
                status: true,
                startedAt: true,
                lecture: {
                    select: {
                        title: true,
                        class: {
                            select: {
                                name: true,
                                teacherId: true,
                                teacher: { select: { name: true } },
                            },
                        },
                    },
                },
            },
        });

        if (candidates.length === 0) return [];

        const teacherIds = [
            ...new Set(candidates.map((c) => c.lecture.class.teacherId)),
        ];

        const connections = await prisma.youTubeConnection.findMany({
            where: { teacherId: { in: teacherIds } },
            select: { teacherId: true, refreshTokenEncrypted: true },
        });

        const tokenByTeacher = new Map(
            connections.map((c) => [c.teacherId, c.refreshTokenEncrypted])
        );

        const isStudent = options.studentId !== undefined;

        const resolved = await Promise.allSettled(
            candidates.map((candidate) =>
                resolveCandidate(candidate, tokenByTeacher, isStudent)
            )
        );

        return resolved
            .filter(
                (r): r is PromiseFulfilledResult<LiveBroadcastView | null> =>
                    r.status === "fulfilled"
            )
            .map((r) => r.value)
            .filter((v): v is LiveBroadcastView => v !== null);
    } catch (error) {
        console.error("getActiveYouTubeLives failed:", error);
        return [];
    }
}

type Candidate = {
    id: string;
    broadcastId: string;
    videoId: string;
    youtubeUrl: string;
    privacy: string;
    status: YouTubeBroadcastStatus;
    startedAt: Date | null;
    lecture: {
        title: string;
        class: {
            name: string;
            teacherId: string;
            teacher: { name: string };
        };
    };
};

function toView(candidate: Candidate, startedAt: Date | null): LiveBroadcastView {
    return {
        id: candidate.id,
        videoId: candidate.videoId,
        youtubeUrl: candidate.youtubeUrl,
        lectureTitle: candidate.lecture.title,
        className: candidate.lecture.class.name,
        teacherName: candidate.lecture.class.teacher.name,
        startedAt: startedAt ? startedAt.toISOString() : null,
    };
}

async function resolveCandidate(
    candidate: Candidate,
    tokenByTeacher: Map<string, string>,
    isStudent: boolean
): Promise<LiveBroadcastView | null> {
    // PRIVATE broadcasts can't be embedded for students.
    if (isStudent && candidate.privacy === "PRIVATE") return null;

    const refreshToken = tokenByTeacher.get(candidate.lecture.class.teacherId);

    // No connection to verify against — trust the stored status.
    if (!refreshToken) {
        return candidate.status === YouTubeBroadcastStatus.LIVE
            ? toView(candidate, candidate.startedAt)
            : null;
    }

    let lifecycle: string | undefined;

    try {
        const broadcast = await getYouTubeLiveBroadcast(
            refreshToken,
            candidate.broadcastId
        );
        lifecycle = broadcast.status?.lifeCycleStatus;
    } catch (error) {
        // Transient / reauth failure — fall back to the stored status so an
        // actually-live stream we already marked LIVE stays visible.
        console.error(
            `YouTube lifecycle check failed for broadcast ${candidate.broadcastId}:`,
            error
        );
        return candidate.status === YouTubeBroadcastStatus.LIVE
            ? toView(candidate, candidate.startedAt)
            : null;
    }

    const now = new Date();

    if (lifecycle === "live") {
        const startedAt = candidate.startedAt ?? now;
        if (candidate.status !== YouTubeBroadcastStatus.LIVE) {
            await prisma.youTubeLiveBroadcast.update({
                where: { id: candidate.id },
                data: { status: YouTubeBroadcastStatus.LIVE, startedAt },
            });
        }
        return toView(candidate, startedAt);
    }

    if (lifecycle === "complete" || lifecycle === "revoked") {
        const nextStatus =
            lifecycle === "complete"
                ? YouTubeBroadcastStatus.COMPLETE
                : YouTubeBroadcastStatus.REVOKED;
        if (candidate.status !== nextStatus) {
            await prisma.youTubeLiveBroadcast.update({
                where: { id: candidate.id },
                data: { status: nextStatus, endedAt: now },
            });
        }
        return null;
    }

    if (
        lifecycle === "testing" &&
        candidate.status !== YouTubeBroadcastStatus.TESTING
    ) {
        await prisma.youTubeLiveBroadcast.update({
            where: { id: candidate.id },
            data: { status: YouTubeBroadcastStatus.TESTING },
        });
    }

    return null;
}
