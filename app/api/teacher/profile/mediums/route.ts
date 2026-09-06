import { NextRequest, NextResponse } from "next/server";

import { getOptionalSession, requireAppSession } from "@/lib/auth-session";

import {
  getTeacherMediums,
  isProfilePublic,
  updateTeacherMediums,
} from "@/services/teacher-profile-service";

export async function GET(request:Request) {
  try {

    const { searchParams } = new URL(request.url);

    const teacherId = searchParams.get("teacherId");

    if (!teacherId) {
      throw new Error("Teacher id is required.");
    }

    const session = await getOptionalSession();
    const isOwner = session?.role === "TEACHER" && session.userId === teacherId;

    if (!isOwner && !(await isProfilePublic(teacherId))) {
      return NextResponse.json([]);
    }

    const mediums =
      await getTeacherMediums(
        teacherId
      );

    return NextResponse.json(
      mediums
    );

  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load teacher mediums.";

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

  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to update teacher mediums.";

    return NextResponse.json(
      { message },
      { status: 400 }
    );
  }
}