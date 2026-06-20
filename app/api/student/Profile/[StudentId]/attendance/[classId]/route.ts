import { NextResponse } from "next/server";
import { getStudentAttendanceSummary, getStudentClassAttendance, getStudentClassesForTeacher } from "@/services/student-service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ StudentId: string; classId: string }> }
) {
  try {
    const { StudentId, classId } = await params;

    const classes = await getStudentClassAttendance(StudentId, classId);

    return NextResponse.json({
      success: true,
      data: classes,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        message: "Failed to load student classes",
      },
      { status: 500 }
    );
  }
}