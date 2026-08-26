import { NextRequest, NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { startYouTubeRecording } from "@/lib/youtube-lecture";
import {
    YouTubeReauthorizationRequiredError,
} from "@/lib/youtube-auth";

import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
    try {
        const teacherSession =
            await requireTeacherSession();

        const body = await request.json();

        const lectureId =
            typeof body.lectureId === "string"
                ? body.lectureId.trim()
                : "";

        if (!lectureId) {
            return NextResponse.json(
                {
                    success: false,
                    error: "lectureId is required.",
                },
                { status: 400 }
            );
        }

        const isLive =
            body.isLive === true;

        console.log(isLive);

        const result =
            await startYouTubeRecording(
                teacherSession.teacherId,
                lectureId,
                isLive
            );

        return NextResponse.json({
            success: true,

            message:
                result.alreadyStarted
                    ? "YouTube recording already exists."
                    : "YouTube recording prepared successfully.",

            ...result,
        });

    } catch (error) {

        
        console.error(
            "Start YouTube recording failed:",
            error
        );

    
        // 👇 FIRST: YouTube authorization problem

        const teacherSession =
            await requireTeacherSession();
            
        if (
            error instanceof
            YouTubeReauthorizationRequiredError
        ) {
            await prisma.youTubeConnection.update({
                where: {
                    teacherId:
                        teacherSession.teacherId,
                },
                data: {
                    status: "REAUTH_REQUIRED",
                },
            });

            return NextResponse.json(
                {
                    success: false,
                    error:
                        "Your YouTube connection needs to be renewed.",
                    code:
                        "YOUTUBE_REAUTH_REQUIRED",
                },
                { status: 401 }
            );
        }


        const message =
            error instanceof Error
                ? error.message
                : "Failed to start YouTube recording.";

        if (message === "Lecture not found.") {
            return NextResponse.json(
                {
                    success: false,
                    error: message,
                },
                { status: 404 }
            );
        }

        if (
            message.includes(
                "not authorized"
            )
        ) {
            return NextResponse.json(
                {
                    success: false,
                    error: message,
                },
                { status: 403 }
            );
        }

        if (
            message ===
            "Teacher has not connected a YouTube channel."
        ) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        "Your YouTube channel is not connected.",
                    code:
                        "YOUTUBE_NOT_CONNECTED",
                },
                { status: 400 }
            );
        }

        return NextResponse.json(
            {
                success: false,
                error: message,
            },
            { status: 500 }
        );
    }
}