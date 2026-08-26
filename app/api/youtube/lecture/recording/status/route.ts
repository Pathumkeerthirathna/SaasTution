import { NextRequest, NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { checkYouTubeRecordingStatus } from "@/lib/youtube-lecture";

export async function GET(
  request: NextRequest
) {
  try {
    const teacherSession =
      await requireTeacherSession();

    const { searchParams } =
      new URL(request.url);

    const lectureId =
      searchParams.get("lectureId");

    if (!lectureId) {
      return NextResponse.json(
        {
          success: false,
          error: "lectureId is required.",
        },
        { status: 400 }
      );
    }

    const status =
      await checkYouTubeRecordingStatus(
        teacherSession.teacherId,
        lectureId
      );

    return NextResponse.json({
      success: true,
      ...status,
    });

  } catch (error) {
    console.error(
      "❌ YouTube recording status check failed:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to check YouTube recording status.",
      },
      { status: 500 }
    );
  }
}