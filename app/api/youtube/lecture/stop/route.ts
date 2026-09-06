import { NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";
import { emitLiveChange } from "@/lib/session-events";
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

        const session = await requireTeacherSession();

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

        if (!lecture || lecture.class.teacherId !== session.teacherId) {
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

        // YouTube can no longer recognize this broadcast at all (deleted,
        // expired, etc.) even though our row still says READY/LIVE. That
        // must not block the teacher from stopping — treat it as already
        // ended on YouTube's side and just heal our own row.
        let broadcast: Awaited<ReturnType<typeof getYouTubeLiveBroadcast>> | null = null;

        try {
            broadcast =
                await getYouTubeLiveBroadcast(
                    connection.refreshTokenEncrypted,
                    liveBroadcast.broadcastId
                );
        } catch (error) {
            console.error(
                "YouTube broadcast lookup failed while stopping — treating as already ended:",
                error
            );
        }

        if (!broadcast) {
            await prisma.youTubeLiveBroadcast.update({
                where: { id: liveBroadcast.id },
                data: {
                    status: YouTubeBroadcastStatus.REVOKED,
                    endedAt: new Date(),
                },
            });

            emitLiveChange({ classId: lecture.classId, kind: "youtube", event: "ended" });

            return NextResponse.json({
                success: true,

                broadcastId:
                    liveBroadcast.broadcastId,

                youtubeUrl:
                    liveBroadcast.youtubeUrl,

                status: "REVOKED",

                message:
                    "This broadcast no longer exists on YouTube; it has been marked as ended.",
            });
        }

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

            // Only skip the transition call when YouTube already considers
            // the broadcast over — for every other status, including
            // transitional ones like "liveStarting"/"testStarting" that a
            // broadcast can be sitting in right when the teacher hits stop,
            // it still needs to be told to complete. Otherwise the DB row
            // gets marked COMPLETE below while YouTube keeps the broadcast
            // running.
            if (
                lifecycleStatus !== "complete" &&
                lifecycleStatus !== "revoked"
            ) {
                try {
                    completedBroadcast =
                        await transitionYouTubeLiveBroadcast(
                            connection.refreshTokenEncrypted,
                            liveBroadcast.broadcastId,
                            "complete"
                        );
                } catch (error) {
                    // Some lifecycle states (e.g. "created", before the
                    // broadcast was ever bound to a stream) reject a direct
                    // transition to "complete". The teacher's stop action
                    // must still succeed and our row still needs to stop
                    // showing as live — only the extra YouTube-side
                    // transition is skipped.
                    console.error(
                        "Failed to transition YouTube broadcast to complete while stopping:",
                        error
                    );
                }
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

        emitLiveChange({ classId: lecture.classId, kind: "youtube", event: "ended" });

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