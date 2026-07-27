import { NextResponse } from "next/server";
import { confirmAllPendingStudents } from "../../../../services/student-service";

export async function PUT() {
  try {
    const count = await confirmAllPendingStudents();

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