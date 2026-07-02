import { NextRequest, NextResponse } from "next/server";

import { requireAppSession } from "@/lib/auth-session";

import {
  getSocialLinks,
  updateSocialLinks,
} from "@/services/teacher-profile-service";

export async function GET() {
  try {

    const session =
      await requireAppSession();

    if (
      !session?.userId ||
      session.role !== "TEACHER"
    ) {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const data =
      await getSocialLinks(
        session.userId
      );

    return NextResponse.json(data);

  } catch (error: any) {

    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to load social links.",
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

    if (
      !session?.userId ||
      session.role !== "TEACHER"
    ) {
      return NextResponse.json(
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const body =
      await request.json();

    const result =
      await updateSocialLinks(
        session.userId,
        body
      );

    return NextResponse.json(result);

  } catch (error: any) {

    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to update social links.",
      },
      {
        status: 400,
      }
    );

  }
}