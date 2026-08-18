import { NextRequest, NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";
import { bindYouTubeLiveBroadcast } from "@/lib/youtube-live";

export async function POST(request: NextRequest) {
    try {
        const teacherSession =
            await requireTeacherSession();

        const body = await request.json();

        const lectureId =
            body.lectureId as string | undefined;

        if (!lectureId) {
            return NextResponse.json(
                {
                    error: "lectureId is required.",
                },
                { status: 400 }
            );
        }

        const lecture =
            await prisma.lecture.findUnique({
                where: {
                    id: lectureId,
                },
            });

        if (!lecture) {
            return NextResponse.json(
                {
                    error: "Lecture not found.",
                },
                { status: 404 }
            );
        }

        if (!lecture.youtubeBroadcastId) {
            return NextResponse.json(
                {
                    error:
                        "Lecture does not have a YouTube broadcast.",
                },
                { status: 400 }
            );
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
                    error:
                        "YouTube account is not connected.",
                },
                { status: 404 }
            );
        }

        if (!connection.liveStreamId) {
            return NextResponse.json(
                {
                    error:
                        "Teacher does not have a reusable YouTube live stream.",
                },
                { status: 400 }
            );
        }

        const broadcast =
            await bindYouTubeLiveBroadcast(
                connection.refreshTokenEncrypted,
                lecture.youtubeBroadcastId,
                connection.liveStreamId
            );

        await prisma.lecture.update({
            where: {
                id: lecture.id,
            },
            data: {
                youtubeStatus: "READY",
            },
        });

        return NextResponse.json({
            success: true,
            message:
                "YouTube broadcast successfully bound to reusable stream.",

            broadcastId:
                broadcast.id,

            videoId:
                lecture.youtubeVideoId,

            boundStreamId:
                broadcast.contentDetails
                    ?.boundStreamId,

            lifeCycleStatus:
                broadcast.status
                    ?.lifeCycleStatus,

            privacyStatus:
                broadcast.status
                    ?.privacyStatus,
        });

    } catch (error) {
        console.error(
            "Bind YouTube broadcast failed:",
            error
        );

        return NextResponse.json(
            {
                error:
                    "Failed to bind YouTube broadcast.",
            },
            { status: 500 }
        );
    }
}