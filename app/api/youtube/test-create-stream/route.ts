import { NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import { debugRouteDisabledResponse } from "@/lib/debug-routes";
import { ensureTeacherReusableStream } from "@/lib/youtube-lecture";

/*
 * Developer-only (404 in production): ensures the teacher's reusable YouTube
 * stream exists. Created under the teacher's stream lock like every stream
 * creation, so it never races a start into a second stream. The stream key
 * (RTMP stream name / ingestion address) is never returned.
 */
export async function POST() {
    const disabled = debugRouteDisabledResponse();

    if (disabled) {
        return disabled;
    }

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

        const liveStreamId = await ensureTeacherReusableStream(
            teacherSession.teacherId,
            connection.refreshTokenEncrypted
        );

        return NextResponse.json({
            success: true,
            message: "The teacher has a reusable YouTube live stream.",
            liveStreamId,
        });
    } catch (error) {
        console.error(
            "Create YouTube live stream failed:",
            error
        );

        return NextResponse.json(
            {
                error:
                    error instanceof AppError
                        ? error.message
                        : "Failed to create YouTube live stream.",
            },
            { status: error instanceof AppError ? error.statusCode : 500 }
        );
    }
}
