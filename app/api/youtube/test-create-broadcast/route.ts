import { NextRequest, NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";
import { createYouTubeLiveBroadcast } from "@/lib/youtube-live";

export async function POST(request: NextRequest) {
    try {
        const teacherSession = await requireTeacherSession();

        const body = await request.json();

        const lectureId = body.lectureId as string | undefined;

        if (!lectureId) {
            return NextResponse.json(
                {
                    error: "lectureId is required.",
                },
                { status: 400 }
            );
        }

        const lecture = await prisma.lecture.findUnique({
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

        /*
         * IMPORTANT:
         *
         * Make sure the lecture belongs to the
         * currently logged-in teacher.
         *
         * We will replace this with the exact
         * Class → Teacher relationship from your
         * schema once we inspect it.
         */

        const connection =
            await prisma.youTubeConnection.findUnique({
                where: {
                    teacherId: teacherSession.teacherId,
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

        if (lecture.youtubeBroadcastId) {
            return NextResponse.json({
                success: true,
                message:
                    "This lecture already has a YouTube broadcast.",
                broadcastId:
                    lecture.youtubeBroadcastId,
                videoId:
                    lecture.youtubeVideoId,
                youtubeUrl:
                    lecture.youtubeUrl,
            });
        }

        const broadcast =
            await createYouTubeLiveBroadcast(
                connection.refreshTokenEncrypted,
                {
                    title: lecture.title,
                    description:
                        `SLClassroom - ${lecture.title}`,
                    scheduledStartTime:
                        lecture.date,
                    privacyStatus: "unlisted",
                }
            );

        if (!broadcast.id) {
            return NextResponse.json(
                {
                    error:
                        "YouTube did not return a broadcast ID.",
                },
                { status: 500 }
            );
        }

        const videoId = broadcast.id;

        const youtubeUrl =
            `https://www.youtube.com/watch?v=${videoId}`;

        await prisma.lecture.update({
            where: {
                id: lecture.id,
            },
            data: {
                youtubeBroadcastId: broadcast.id,
                youtubeVideoId: videoId,
                youtubeUrl,
                youtubePrivacy: "UNLISTED",
                youtubeStatus:
                    "CREATED",
            },
        });

        return NextResponse.json({
            success: true,
            message:
                "YouTube broadcast created successfully.",

            broadcastId:
                broadcast.id,

            videoId,

            youtubeUrl,

            privacyStatus:
                broadcast.status?.privacyStatus,

            lifeCycleStatus:
                broadcast.status?.lifeCycleStatus,
        });

    } catch (error) {

        console.error(
            "Create YouTube broadcast failed:",
            error
        );

        return NextResponse.json(
            {
                error:
                    "Failed to create YouTube broadcast.",
            },
            { status: 500 }
        );
    }
}