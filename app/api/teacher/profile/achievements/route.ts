import { NextRequest, NextResponse } from "next/server";

import {
  getAchievements,
  addAchievement,
} from "@/services/teacher-profile-service";
import { requireAppSession } from "@/lib/auth-session";

export async function GET(request:Request) {
  try {
    const { searchParams } = new URL(request.url);
        
    const teacherId = searchParams.get("teacherId");

    if (!teacherId) {
      throw new Error("Teacher id is required.");
    }

    const achievements =
      await getAchievements(
        teacherId
      );

    return NextResponse.json(
      achievements
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load achievements";

    return NextResponse.json(
      { message },
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
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to add achievement";

    return NextResponse.json(
      { message },
      { status: 400 }
    );
  }
}