import { NextRequest, NextResponse } from "next/server";

import {
  updateAchievement,
  deleteAchievement,
} from "@/services/teacher-profile-service";
import { requireAppSession } from "@/lib/auth-session";

interface RouteParams {
  params: {
    id: string;
  };
}

export async function PUT(
  request: NextRequest,
  { params }: RouteParams
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
      await updateAchievement(
        session.userId,
        params.id,
        body
      );

    return NextResponse.json(
      achievement
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to update achievement";

    return NextResponse.json(
      { message },
      { status: 400 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const session = await requireAppSession();

    if (!session?.userId || session.role !== "TEACHER") {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const result =
      await deleteAchievement(
        session.userId,
        params.id
      );

    return NextResponse.json(
      result
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to delete achievement";

    return NextResponse.json(
      { message },
      { status: 400 }
    );
  }
}