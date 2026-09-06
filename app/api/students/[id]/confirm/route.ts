import { NextRequest, NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { confirmStudent } from "../../../../../services/student-service";

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireTeacherSession();
    await confirmStudent(session.teacherId, params.id);

    return NextResponse.json({
      success: true,
      message: "Student confirmed successfully.",
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message:
          error instanceof Error ? error.message : "Internal server error.",
      },
      { status: 400 }
    );
  }
}