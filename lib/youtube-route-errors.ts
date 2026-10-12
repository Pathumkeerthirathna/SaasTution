import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/error-handler";
import { YouTubeReauthorizationRequiredError } from "@/lib/youtube-auth";

/**
 * Error response for the YouTube Recording / Live routes:
 * { success: false, error, code? } with the AppError's status (e.g. 409
 * YOUTUBE_OPERATION_IN_PROGRESS, 503 YOUTUBE_BROADCAST_CHECK_FAILED), or 401
 * YOUTUBE_REAUTH_REQUIRED (and the connection marked REAUTH_REQUIRED, as the
 * start routes do), or 500 with `fallbackMessage`.
 */
export async function youtubeRouteErrorResponse(
  error: unknown,
  teacherId: string | null,
  fallbackMessage: string
) {
  if (error instanceof YouTubeReauthorizationRequiredError) {
    if (teacherId) {
      await prisma.youTubeConnection
        .updateMany({ where: { teacherId }, data: { status: "REAUTH_REQUIRED" } })
        .catch(statusError =>
          console.error("Failed to mark YouTube connection as REAUTH_REQUIRED:", statusError)
        );
    }

    return NextResponse.json(
      {
        success: false,
        error: "Your YouTube connection needs to be renewed.",
        code: "YOUTUBE_REAUTH_REQUIRED",
      },
      { status: 401 }
    );
  }

  if (error instanceof AppError) {
    return NextResponse.json(
      { success: false, error: error.message, code: error.code },
      { status: error.statusCode }
    );
  }

  return NextResponse.json({ success: false, error: fallbackMessage }, { status: 500 });
}
