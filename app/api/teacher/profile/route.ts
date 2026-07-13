import { NextRequest, NextResponse } from "next/server";

import {
  getTeacherProfile,
  updateTeacherProfile,
} from "@/services/teacher-profile-service";
import { requireAppSession } from "@/lib/auth-session";


export async function GET() {
  try {
    const session = await requireAppSession();

    if (!session?.userId || session.role !== "TEACHER") {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const profile =
      await getTeacherProfile(
        session.userId
      );

    return NextResponse.json(profile);
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { message: "Failed to load profile" },
      { status: 500 }
    );
  }
}

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

    const body =
      await request.json();

    const profile =
      await updateTeacherProfile(
        session.userId,
        body
      );

    return NextResponse.json(profile);
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to update profile";

    return NextResponse.json(
      { message },
      { status: 400 }
    );
  }
}