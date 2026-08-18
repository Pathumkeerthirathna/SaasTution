import { NextRequest, NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { startYouTubeLecture } from "@/lib/youtube-lecture";

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

        const result =
            await startYouTubeLecture(
                teacherSession.teacherId,
                lectureId
            );

        return NextResponse.json({
            success: true,
            message:
                result.alreadyStarted
                    ? "YouTube broadcast already exists."
                    : "YouTube lecture started successfully.",

            ...result,
        });

    } catch (error) {
        console.error(
            "Start YouTube lecture failed:",
            error
        );

        const message =
            error instanceof Error
                ? error.message
                : "Failed to start YouTube lecture.";

        if (
            message === "Lecture not found."
        ) {
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
            message.includes(
                "not connected"
            )
        ) {
            return NextResponse.json(
                {
                    success: false,
                    error: message,
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