import { NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";
import { getYouTubeAccessToken } from "@/lib/youtube-auth";
import { debugRouteDisabledResponse } from "@/lib/debug-routes";

/*
 * Developer-only (404 in production): checks that the teacher's YouTube
 * token can be refreshed. Only a yes/no is returned, never the token.
 */
export async function GET() {
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

        const accessToken =
            await getYouTubeAccessToken(
                connection.refreshTokenEncrypted
            );

        return NextResponse.json({
            success: true,
            message:
                "Successfully obtained a YouTube access token.",
            teacherId: teacherSession.teacherId,
            channelId: connection.channelId,
            hasAccessToken: Boolean(accessToken),
        });
    } catch (error) {
        console.error(
            "YouTube token test failed:",
            error
        );

        return NextResponse.json(
            {
                error:
                    "Failed to obtain YouTube access token.",
            },
            { status: 500 }
        );
    }
}