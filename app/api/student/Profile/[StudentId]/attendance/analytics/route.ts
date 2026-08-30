import { NextResponse } from "next/server";
import { getStudentAttendanceAnalytics } from "@/services/student-service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ StudentId: string }> }
) {
  try {
    const { StudentId } = await params;

    const { searchParams } = new URL(request.url);
    const monthsParam = Number(searchParams.get("months"));
    const months = Number.isFinite(monthsParam) ? monthsParam : undefined;

    const data = await getStudentAttendanceAnalytics(StudentId, { months });

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        message: "Failed to load attendance analytics",
      },
      { status: 500 }
    );
  }
}
