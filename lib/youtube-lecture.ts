import { prisma } from "@/lib/prisma";
import {
    createYouTubeLiveBroadcast,
    bindYouTubeLiveBroadcast,
    getYouTubeLiveStream,
} from "@/lib/youtube-live";

export async function startYouTubeLecture(
    teacherId: string,
    lectureId: string
) {
    // 1. Get lecture
    const lecture = await prisma.lecture.findUnique({
        where: {
            id: lectureId,
        },
        include: {
            class: {
                select: {
                    teacherId: true,
                },
            },
        },
    });

    if (!lecture) {
        throw new Error("Lecture not found.");
    }

    if (lecture.class.teacherId !== teacherId) {
        throw new Error(
            "You are not authorized to start YouTube streaming for this lecture."
        );
    }

    // 2. Get teacher's YouTube connection
    const connection =
        await prisma.youTubeConnection.findUnique({
            where: {
                teacherId,
            },
        });

    if (!connection) {
        throw new Error(
            "Teacher has not connected a YouTube channel."
        );
    }

    // 3. Teacher must have reusable stream
    if (!connection.liveStreamId) {
        throw new Error(
            "Teacher does not have a reusable YouTube live stream."
        );
    }

    const liveStream =
        await getYouTubeLiveStream(
            connection.refreshTokenEncrypted,
            connection.liveStreamId
        );

    const streamName =
        liveStream.cdn?.ingestionInfo?.streamName;

    if (!streamName) {
        throw new Error(
            "YouTube reusable live stream does not have a stream key."
        );
    }

    // 4. Don't create another broadcast
    if (lecture.youtubeBroadcastId) {
        return {
            broadcastId: lecture.youtubeBroadcastId,
            videoId: lecture.youtubeVideoId,
            youtubeUrl: lecture.youtubeUrl,
            privacy: lecture.youtubePrivacy,
            status: lecture.youtubeStatus,
            streamName,
            alreadyStarted: true,
        };
    }

    // 5. Create new broadcast
    const broadcast =
        await createYouTubeLiveBroadcast(
            connection.refreshTokenEncrypted,
            {
                title: lecture.title,

                description:
                    `SLClassroom - ${lecture.title}`,

                scheduledStartTime:
                    new Date(
                        Date.now() + 60 * 1000
                    ),

                // Normal SLClassroom recording
                // is UNLISTED by default.
                privacyStatus: "unlisted",
            }
        );

    if (!broadcast.id) {
        throw new Error(
            "YouTube did not return a broadcast ID."
        );
    }

    // 6. Bind broadcast to teacher's reusable stream
    const boundBroadcast =
        await bindYouTubeLiveBroadcast(
            connection.refreshTokenEncrypted,
            broadcast.id,
            connection.liveStreamId
        );

    // 7. YouTube broadcast ID is also the
    // associated video ID for the live broadcast.
    const videoId = broadcast.id;

    const youtubeUrl =
        `https://www.youtube.com/watch?v=${videoId}`;

    // 8. Save everything against the Lecture
    await prisma.lecture.update({
        where: {
            id: lecture.id,
        },
        data: {
            youtubeBroadcastId:
                broadcast.id,

            youtubeVideoId:
                videoId,

            youtubeUrl,

            youtubePrivacy:
                "UNLISTED",

            youtubeStatus:
                "READY",
        },
    });

    return {
        broadcastId: broadcast.id,

        videoId,

        youtubeUrl,

        privacy: "UNLISTED",

        status: "READY",

        boundStreamId:
            boundBroadcast.contentDetails
                ?.boundStreamId,

        streamName,

        alreadyStarted: false,
    };
}