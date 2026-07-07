import { NextRequest, NextResponse } from "next/server";

import {
  getQualifications,
  addQualification,
} from "@/services/teacher-profile-service";
import { requireAppSession } from "@/lib/auth-session";

export async function GET(request:Request) {
  try {
    const { searchParams } = new URL(request.url);
        
    const teacherId = searchParams.get("teacherId");

    if (!teacherId) {
      throw new Error("Teacher id is required.");
    }

    const qualifications =
      await getQualifications(
        teacherId
      );

    return NextResponse.json(
      qualifications
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to load qualifications",
      },
      { status: 400 }
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
        { message: "Unauthorized" },
        { status: 401 }
      );
    }

    const body =
      await request.json();

    const qualification =
      await addQualification(
        session.userId,
        body
      );

    return NextResponse.json(
      qualification
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        message:
          error.message ??
          "Failed to add qualification",
      },
      { status: 400 }
    );
  }
}