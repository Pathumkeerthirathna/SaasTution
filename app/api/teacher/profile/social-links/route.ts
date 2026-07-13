import { NextRequest, NextResponse } from "next/server";

import { requireAppSession } from "@/lib/auth-session";

import {
  getSocialLinks,
  updateSocialLinks,
} from "@/services/teacher-profile-service";

export async function GET(request:Request) {
  try {

    const { searchParams } = new URL(request.url);

    const teacherId = searchParams.get("teacherId");

    if (!teacherId) {
      throw new Error("Teacher id is required.");
    }

    const data =
      await getSocialLinks(
        teacherId
      );

    return NextResponse.json(data);

  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load social links";

    return NextResponse.json(
      { message },
      { status: 400 }
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

  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to update social links";

    return NextResponse.json(
      { message },
      { status: 400 }
    );
  }
}