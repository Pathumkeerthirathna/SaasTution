import { NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";
import { getYouTubeLiveStream } from "@/lib/youtube-live";
import { debugRouteDisabledResponse } from "@/lib/debug-routes";

/*
 * Developer-only (404 in production): the teacher's reusable stream status.
 * The stream key (RTMP stream name / ingestion address) is never returned.
 */
export async function GET() {
    const disabled = debugRouteDisabledResponse();

    if (disabled) {
        return disabled;
    }

    try {
        const teacherSession =
            await requireTeacherSession();

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
                        "YouTube channel is not connected.",
                },
                { status: 400 }
            );
        }

        if (!connection.liveStreamId) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        "Reusable YouTube live stream does not exist.",
                },
                { status: 400 }
            );
        }

        const stream =
            await getYouTubeLiveStream(
                connection.refreshTokenEncrypted,
                connection.liveStreamId
            );

        return NextResponse.json({
            success: true,

            streamId: stream.id,

            streamStatus:
                stream.status?.streamStatus,
        });

    } catch (error) {
        console.error(
            "Get YouTube stream failed:",
            error
        );

        return NextResponse.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Failed to get YouTube stream.",
            },
            { status: 500 }
        );
    }
}