import { NextResponse } from "next/server";
import { getStudentPaymentSummary } from "@/services/student-service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ StudentId: string }> }
) {
  try {
    const { StudentId } = await params;

    const data = await getStudentPaymentSummary(StudentId);

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        message: "Failed to load student payments",
      },
      { status: 500 }
    );
  }
}
