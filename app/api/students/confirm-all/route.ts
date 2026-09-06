import { NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { confirmAllPendingStudents } from "../../../../services/student-service";

export async function PUT() {
  try {
    const session = await requireTeacherSession();
    const count = await confirmAllPendingStudents(session.teacherId);

    return NextResponse.json({
      success: true,
      count,
      message: `${count} student(s) confirmed successfully.`,
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