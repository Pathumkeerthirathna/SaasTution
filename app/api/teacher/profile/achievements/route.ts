import { NextRequest, NextResponse } from "next/server";

import {
  getAchievements,
  addAchievement,
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

    const achievements =
      await getAchievements(
        session.userId
      );

    return NextResponse.json(
      achievements
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to load achievements",
      },
      { status: 400 }
    );
  }
}

export async function POST(
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

    const achievement =
      await addAchievement(
        session.userId,
        body
      );

    return NextResponse.json(
      achievement
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to add achievement",
      },
      { status: 400 }
    );
  }
}