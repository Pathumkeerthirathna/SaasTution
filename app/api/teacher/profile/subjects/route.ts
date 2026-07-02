import { NextRequest, NextResponse } from "next/server";

import {
  getTeacherSubjects,
  addTeacherSubject,
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

    const subjects = await getTeacherSubjects(
      session.userId
    );

    return NextResponse.json(subjects);

  } catch (error: any) {

    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to load teacher subjects.",
      },
      {
        status: 400,
      }
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
        {
          message: "Unauthorized",
        },
        {
          status: 401,
        }
      );
    }

    const body =
      await request.json();

    const subject =
      await addTeacherSubject(
        session.userId,
        body
      );

    return NextResponse.json(subject);

  } catch (error: any) {

    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to add subject.",
      },
      {
        status: 400,
      }
    );

  }
}