import { NextResponse } from "next/server";
import { getStudentClassesForTeacher, getStudentQuizSummary } from "@/services/student-service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ StudentId: string }> }
) {
  try {
    const { StudentId } = await params;

    const classes = await getStudentQuizSummary(StudentId);

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