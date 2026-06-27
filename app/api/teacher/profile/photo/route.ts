import { NextRequest, NextResponse } from "next/server";

import {
  updateProfilePhoto,
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
      profileImageUrl,
    } = await request.json();

    const result =
      await updateProfilePhoto(
        session.userId,
        profileImageUrl
      );

    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to update photo",
      },
      { status: 400 }
    );
  }
}