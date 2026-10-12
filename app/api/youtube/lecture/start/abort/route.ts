import { NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { abortYouTubeFeatureStart, parseRowVersionToken } from "@/lib/youtube-feature-lifecycle";
import { youtubeRouteErrorResponse } from "@/lib/youtube-route-errors";

/*
 * POST /api/youtube/lecture/start/abort
 *   { lectureId, feature: "recording" | "live", rowId, rowVersion?, ownsBroadcast? }
 *
 * Sent by the teacher's page when a Recording / Live start it made did not get
 * its Jibri stream confirmed (timeout or Jibri error), for the row that start
 * created (`ownsRow`). See abortYouTubeFeatureStart: ends the broadcast if no
 * other active feature uses it, closes that row only once YouTube confirmed,
 * and answers `stopJibri`. YouTube trouble: 503 (401 / 404), row unchanged.
 * (`ownsBroadcast` is still accepted from older pages and ignored: the
 * broadcast rule is decided by the server at cleanup time.) `rowVersion` is
 * the row version the start reported, an integer: if another start (another
 * tab) reused the row since, nothing is closed and `reused: true,
 * stopJibri: false`. An ISO timestamp (pages loaded before the version
 * counter) is still accepted for one release; an unusable value is 400.
 */
export async function POST(request: Request) {
    let teacherId: string | null = null;

    try {
        const teacherSession = await requireTeacherSession();

        teacherId = teacherSession.teacherId;

        const body = await request.json();

        const lectureId = typeof body.lectureId === "string" ? body.lectureId.trim() : "";
        const rowId = typeof body.rowId === "string" ? body.rowId.trim() : "";
        const feature = body.feature === "recording" || body.feature === "live" ? body.feature : null;
        const rowVersion = parseRowVersionToken(body.rowVersion);

        if (!lectureId || !rowId || !feature || rowVersion === "invalid") {
            return NextResponse.json(
                {
                    success: false,
                    error: "lectureId, rowId and feature (recording | live) are required; rowVersion, when given, must be the version the start reported.",
                    code: "VALIDATION_ERROR",
                },
                { status: 400 }
            );
        }

        return NextResponse.json(
            await abortYouTubeFeatureStart(
                teacherId,
                lectureId,
                feature,
                rowId,
                rowVersion
            )
        );
    } catch (error) {
        console.error("YouTube start cleanup failed:", error);

        return youtubeRouteErrorResponse(error, teacherId, "Failed to clean up the YouTube start.");
    }
}
