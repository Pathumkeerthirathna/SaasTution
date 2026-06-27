import { NextRequest, NextResponse } from "next/server";

import {
  getTeacherSubjects,
  updateTeacherSubjects,
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

    const subjects =
      await getTeacherSubjects(
        session.userId
      );

    return NextResponse.json(subjects);
  } catch (error: any) {
    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to load subjects",
      },
      { status: 400 }
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

    const result =
      await updateTeacherSubjects(
        session.userId,
        body.subjects
      );

    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to save subjects",
      },
      { status: 400 }
    );
  }
}