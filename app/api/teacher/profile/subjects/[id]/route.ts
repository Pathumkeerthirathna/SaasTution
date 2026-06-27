import { NextResponse } from "next/server";

import {
  deleteTeacherSubject,
} from "@/services/teacher-profile-service";
import { requireAppSession } from "@/lib/auth-session";

interface RouteParams {
  params: {
    id: string;
  };
}

export async function DELETE(
  request: Request,
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
          "Failed to delete subject",
      },
      { status: 400 }
    );
  }
}