import { NextRequest, NextResponse } from "next/server";

import { requireAppSession } from "@/lib/auth-session";

import {
  getAboutMe,
  updateAboutMe,
} from "@/services/teacher-profile-service";

export async function GET() {
  try {
    const session = await requireAppSession();

    if (!session?.userId || session.role !== "TEACHER") {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const profile = await getAboutMe(session.userId);

    return NextResponse.json(profile);
  } catch (error: any) {
    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to load About Me.",
      },
      {
        status: 400,
      }
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

    const body = await request.json();

    const profile = await updateAboutMe(
      session.userId,
      body.aboutMe
    );

    return NextResponse.json(profile);
  } catch (error: any) {
    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to update About Me.",
      },
      {
        status: 400,
      }
    );
  }
}