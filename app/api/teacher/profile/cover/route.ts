import { NextRequest, NextResponse } from "next/server";

import {
  updateCoverPhoto,
} from "@/services/teacher-profile-service";

import { requireAppSession } from "@/lib/auth-session";

export async function PUT(
  request: NextRequest
) {
  try {
    const session = await requireAppSession();

    if (!session?.userId || session.role !== "TEACHER") {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const {
      coverImageUrl,
    } = await request.json();

    const result =
      await updateCoverPhoto(
        session.userId,
        coverImageUrl
      );

    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to update cover photo",
      },
      { status: 400 }
    );
  }
}