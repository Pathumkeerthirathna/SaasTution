import { NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";
import { createYouTubeLiveStream } from "@/lib/youtube-live";

export async function POST() {
    try {
        const teacherSession = await requireTeacherSession();

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

        // Don't create another stream if this teacher
        // already has one stored.
        if (connection.liveStreamId) {
            return NextResponse.json({
                success: true,
                message:
                    "Teacher already has a reusable YouTube live stream.",
                liveStreamId: connection.liveStreamId,
            });
        }

        const liveStream =
            await createYouTubeLiveStream(
                connection.refreshTokenEncrypted
            );

        if (!liveStream.id) {
            return NextResponse.json(
                {
                    error:
                        "YouTube did not return a live stream ID.",
                },
                { status: 500 }
            );
        }

        await prisma.youTubeConnection.update({
            where: {
                teacherId: teacherSession.teacherId,
            },
            data: {
                liveStreamId: liveStream.id,
            },
        });

        return NextResponse.json({
            success: true,
            message:
                "Reusable YouTube live stream created.",
            liveStreamId: liveStream.id,
            ingestionAddress:
                liveStream.cdn?.ingestionInfo
                    ?.ingestionAddress,
            streamName:
                liveStream.cdn?.ingestionInfo
                    ?.streamName,
            streamStatus:
                liveStream.status?.streamStatus,
        });
    } catch (error) {
        console.error(
            "Create YouTube live stream failed:",
            error
        );

        return NextResponse.json(
            {
                error:
                    "Failed to create YouTube live stream.",
            },
            { status: 500 }
        );
    }
}