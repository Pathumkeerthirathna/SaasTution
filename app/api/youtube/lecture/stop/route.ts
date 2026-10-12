import { NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { stopYouTubeFeature } from "@/lib/youtube-feature-lifecycle";
import { youtubeRouteErrorResponse } from "@/lib/youtube-route-errors";

/*
 * Stop Live. The rules live in stopYouTubeFeature
 * (lib/youtube-feature-lifecycle.ts): under the lecture lock; a broadcast the
 * recording still uses is not completed (students are told Live ended); a
 * YouTube failure changes nothing (503); a broadcast YouTube no longer knows
 * is closed; `stopJibri` says whether the page may stop Jibri.
 */
export async function POST(
    request: Request
) {
    let teacherId: string | null = null;

    try {
        const body = await request.json();

        const lectureId =
            typeof body.lectureId === "string"
                ? body.lectureId.trim()
                : "";

        if (!lectureId) {
            return NextResponse.json(
                {
                    success: false,
                    error: "Lecture ID is required.",
                },
                { status: 400 }
            );
        }

        const session = await requireTeacherSession();

        teacherId = session.teacherId;

        return NextResponse.json(
            await stopYouTubeFeature(teacherId, lectureId, "live")
        );

    } catch (error) {
        console.error(
            "Stop YouTube lecture failed:",
            error
        );

        return youtubeRouteErrorResponse(
            error,
            teacherId,
            "Failed to update YouTube broadcast."
        );
    }
}
