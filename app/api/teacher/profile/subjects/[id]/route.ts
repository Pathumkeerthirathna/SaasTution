import { NextRequest, NextResponse } from "next/server";

import {
  updateTeacherSubject,
  deleteTeacherSubject,
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

    const session =
      await requireAppSession();

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
      await updateTeacherSubject(
        session.userId,
        params.id,
        body
      );

    return NextResponse.json(subject);

  } catch (error: any) {

    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to update subject.",
      },
      {
        status: 400,
      }
    );

  }
}

export async function DELETE(
  request: NextRequest,
  { params }: RouteParams
) {
  try {

    const session =
      await requireAppSession();

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

    const result =
      await deleteTeacherSubject(
        session.userId,
        params.id
      );

    return NextResponse.json(result);

  } catch (error: any) {

    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to delete subject.",
      },
      {
        status: 400,
      }
    );

  }
}