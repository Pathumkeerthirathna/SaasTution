import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
    getYouTubeLiveBroadcast,
    transitionYouTubeLiveBroadcast,
    updateYouTubeLiveBroadcastPrivacy,
} from "@/lib/youtube-live";
import { YouTubeBroadcastStatus } from "@prisma/client";

export async function POST(
    request: Request
) {
    try {
        const body = await request.json();

        const lectureId =
            typeof body.lectureId === "string"
                ? body.lectureId.trim()
                : "";

        const recordingActive =
                body.recordingActive === true;

        if (!lectureId) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Lecture ID is required.",
                },
                { status: 400 }
            );
        }

        // We'll add the teacher authentication/
        // authorization here using your existing
        // session pattern in the next step.

        const lecture =
            await prisma.lecture.findUnique({
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
            return NextResponse.json(
                {
                    success: false,
                    error: "Lecture not found.",
                },
                { status: 404 }
            );
        }

        const liveBroadcast =
            await prisma.youTubeLiveBroadcast.findFirst({
                where: {
                    lectureId: lecture.id,
                    status: {
                        in: [
                            YouTubeBroadcastStatus.READY,
                            YouTubeBroadcastStatus.LIVE,
                        ],
                    },
                },
                orderBy: {
                    createdAt: "desc",
                },
            });

        if (!liveBroadcast) {
            return NextResponse.json({
                success: true,
                message: "No active YouTube Live broadcast exists.",
            });
        }

        const connection =
            await prisma.youTubeConnection.findUnique({
                where: {
                    teacherId:
                        lecture.class.teacherId,
                },
            });

        if (!connection) {
            return NextResponse.json(
                {
                    success: false,
                    error: "YouTube connection not found.",
                },
                { status: 404 }
            );
        }

        const broadcast =
            await getYouTubeLiveBroadcast(
                connection.refreshTokenEncrypted,
                liveBroadcast.broadcastId
            );

        

        // let updatedBroadcast = broadcast;

        // if (recordingActive) {
        //     console.log(
        //         "⏺ Recording is still active → changing YouTube privacy to UNLISTED."
        //     );

        //     updatedBroadcast =
        //         await updateYouTubeLiveBroadcastPrivacy(
        //             connection.refreshTokenEncrypted,
        //             lecture.youtubeBroadcastId,
        //             "unlisted"
        //         );

        //     await prisma.lecture.update({
        //         where: {
        //             id: lecture.id,
        //         },
        //         data: {
        //             youtubePrivacy: "UNLISTED",
        //         },
        //     });
        // } else {
        //     console.log(
        //         "⏹ Recording is already stopped → YouTube broadcast will end."
        //     );
        // }

        const lifecycleStatus =
                broadcast.status?.lifeCycleStatus;

            console.log(
                "⏹ STOPPING YOUTUBE LIVE BROADCAST:",
                {
                    liveBroadcastId:
                        liveBroadcast.id,

                    broadcastId:
                        liveBroadcast.broadcastId,

                    lifecycleStatus,
                }
            );

            let completedBroadcast =
                broadcast;

            if (
                lifecycleStatus === "live" ||
                lifecycleStatus === "ready"
            ) {
                completedBroadcast =
                    await transitionYouTubeLiveBroadcast(
                        connection.refreshTokenEncrypted,
                        liveBroadcast.broadcastId,
                        "complete"
                    );
            }

        // Keep our row in sync so the broadcast stops showing as live
        // on the dashboards.
        await prisma.youTubeLiveBroadcast.update({
            where: { id: liveBroadcast.id },
            data: {
                status: YouTubeBroadcastStatus.COMPLETE,
                endedAt: new Date(),
            },
        });

        return NextResponse.json({
            success: true,

            broadcastId:
                liveBroadcast.broadcastId,

            youtubeUrl:
                liveBroadcast.youtubeUrl,

            status:
                completedBroadcast.status
                    ?.lifeCycleStatus
                    ?.toUpperCase(),
        });

    } catch (error) {
        console.error(
            "Stop YouTube lecture failed:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                error:
                    "Failed to update YouTube broadcast.",
            },
            { status: 500 }
        );
    }
}