import { NextResponse } from "next/server";
import {
  getStudentQuizAnalytics,
  type QuizAnalyticsPeriod,
} from "@/services/student-service";

const PERIODS: QuizAnalyticsPeriod[] = ["month", "3months", "year"];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ StudentId: string }> }
) {
  try {
    const { StudentId } = await params;

    const { searchParams } = new URL(request.url);
    const raw = searchParams.get("period");
    const period = PERIODS.includes(raw as QuizAnalyticsPeriod)
      ? (raw as QuizAnalyticsPeriod)
      : undefined;

    const data = await getStudentQuizAnalytics(StudentId, { period });

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        message: "Failed to load quiz analytics",
      },
      { status: 500 }
    );
  }
}
