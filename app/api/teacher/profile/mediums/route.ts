import { NextRequest, NextResponse } from "next/server";

import { requireAppSession } from "@/lib/auth-session";

import {
  getTeacherMediums,
  updateTeacherMediums,
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

    const mediums =
      await getTeacherMediums(
        session.userId
      );

    return NextResponse.json(
      mediums
    );

  } catch (error: any) {

    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to load teacher mediums.",
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

    const session =
      await requireAppSession();

    if (!session?.userId || session.role !== "TEACHER") {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const body =
      await request.json();

    const profile =
      await updateTeacherMediums(
        session.userId,
        body.mediumIds
      );

    return NextResponse.json(
      profile
    );

  } catch (error: any) {

    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to update mediums.",
      },
      {
        status: 400,
      }
    );

  }
}