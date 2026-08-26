import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
    getYouTubeLiveBroadcast,
    transitionYouTubeLiveBroadcast,
} from "@/lib/youtube-live";
import { YouTubeBroadcastStatus } from "@prisma/client";
import { requireTeacherSession } from "@/lib/auth-session";


export async function POST(request: Request) {
    try {
        const teacherSession =
            await requireTeacherSession();

        const body =
            await request.json();

        const lectureId =
            typeof body.lectureId === "string"
                ? body.lectureId.trim()
                : "";

        if (!lectureId) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Lecture ID is required.",
                },
                { status: 400 }
            );
        }

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

        if (
            lecture.class.teacherId !==
            teacherSession.teacherId
        ) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        "You are not authorized to stop this recording.",
                },
                { status: 403 }
            );
        }

        /*
         * Find the latest active/ready recording
         * for this lecture.
         */
        const recording =
            await prisma.youTubeRecording.findFirst({
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

        if (!recording) {
            return NextResponse.json({
                success: true,
                message:
                    "No active YouTube recording exists.",
            });
        }

        const connection =
            await prisma.youTubeConnection.findUnique({
                where: {
                    teacherId:
                        teacherSession.teacherId,
                },
            });

        if (!connection) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        "YouTube connection not found.",
                },
                { status: 404 }
            );
        }

        const broadcast =
            await getYouTubeLiveBroadcast(
                connection.refreshTokenEncrypted,
                recording.broadcastId
            );

        const lifecycleStatus =
            broadcast.status?.lifeCycleStatus;

        console.log(
            "⏹ STOPPING YOUTUBE RECORDING:",
            {
                recordingId:
                    recording.id,

                broadcastId:
                    recording.broadcastId,

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
                    recording.broadcastId,
                    "complete"
                );

                console.log(
                    "⏹ Completing ONLY recording broadcast:",
                    {
                        recordingBroadcastId:
                            recording.broadcastId,

                        reusableStreamId:
                            connection.liveStreamId,

                        lifecycleStatus,
                    }
                );
        }

        await prisma.youTubeRecording.update({
            where: {
                id: recording.id,
            },
            data: {
                status:
                    YouTubeBroadcastStatus.COMPLETE,

                endedAt:
                    new Date(),
            },
        });

        return NextResponse.json({
            success: true,

            recordingId:
                recording.id,

            broadcastId:
                recording.broadcastId,

            youtubeUrl:
                recording.youtubeUrl,

            status:
                completedBroadcast.status
                    ?.lifeCycleStatus
                    ?.toUpperCase(),
        });

    } catch (error) {
        console.error(
            "Stop YouTube recording failed:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Failed to stop YouTube recording.",
            },
            { status: 500 }
        );
    }
}