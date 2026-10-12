import { NextRequest, NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { startYouTubeRecording } from "@/lib/youtube-lecture";
import {
    YouTubeReauthorizationRequiredError,
} from "@/lib/youtube-auth";

import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";

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


        // The classroom's class session: only its current session may start
        // anything (a page left open on an ended / replaced session gets 409).
        const sessionId =
            typeof body.sessionId === "string"
                ? body.sessionId.trim()
                : "";

        if (!sessionId) {
            return NextResponse.json(
                {
                    success: false,
                    error: "sessionId is required.",
                    code: "VALIDATION_ERROR",
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
                isLive,
                sessionId
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


        // A deliberate refusal from the reuse checks, e.g.
        // YOUTUBE_BROADCAST_CHECK_FAILED (503) or YOUTUBE_BROADCAST_BUSY (409).
        if (error instanceof AppError) {
            return NextResponse.json(
                {
                    success: false,
                    error: error.message,
                    code: error.code,
                },
                { status: error.statusCode }
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