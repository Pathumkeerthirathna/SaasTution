import { NextRequest, NextResponse } from "next/server";

import {
  getTeacherMediums,
  updateTeacherMediums,
} from "@/services/teacher-profile-service";
import { requireAppSession } from "@/lib/auth-session";

export async function GET() {
  try {
    const session = await requireAppSession();

    if (!session?.userId) {
      return NextResponse.json(
        {
          message: "Unauthorized",
        },
        {
          status: 401,
        }
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
          "Failed to load teacher mediums",
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

    if (!session?.userId) {
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

    const result =
      await updateTeacherMediums(
        session.userId,
        body.mediumIds
      );

    return NextResponse.json(
      result
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to update mediums",
      },
      {
        status: 400,
      }
    );
  }
}