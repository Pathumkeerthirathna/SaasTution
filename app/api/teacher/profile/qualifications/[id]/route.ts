import { NextRequest, NextResponse } from "next/server";

import {
  updateQualification,
  deleteQualification,
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

    const qualification =
      await updateQualification(
        session.userId,
        params.id,
        body
      );

    return NextResponse.json(
      qualification
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to update qualifications";

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
      await deleteQualification(
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
        : "Failed to delete qualifications";

    return NextResponse.json(
      { message },
      { status: 400 }
    );
  }
}