import { NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";
import { getYouTubeLiveStream } from "@/lib/youtube-live";

export async function GET() {
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

            ingestionAddress:
                stream.cdn?.ingestionInfo
                    ?.ingestionAddress,

            streamName:
                stream.cdn?.ingestionInfo
                    ?.streamName,
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