import { reportRouteError } from "@/lib/error-handler";
import { NextResponse } from "next/server";
import { accessErrorResponse, requireTeacherOwnedStudent } from "@/lib/teacher-student-access";
import {
  getStudentQuizAnalytics,
  type QuizAnalyticsPeriod,
} from "@/services/student-service";

const PERIODS: QuizAnalyticsPeriod[] = ["month", "3months", "year"];

export const dynamic = "force-dynamic";

// Teacher-only (/dashboard/students/[id]): the signed-in teacher's own student
// (401 without a teacher session, 404 for an unknown or another teacher's student).
export async function GET(
  request: Request,
  { params }: { params: Promise<{ StudentId: string }> }
) {
  try {
    const { StudentId } = await params;
    const { studentId } = await requireTeacherOwnedStudent(StudentId);

    const { searchParams } = new URL(request.url);
    const raw = searchParams.get("period");
    const period = PERIODS.includes(raw as QuizAnalyticsPeriod)
      ? (raw as QuizAnalyticsPeriod)
      : undefined;

    const data = await getStudentQuizAnalytics(studentId, { period });

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    // Access refusals keep their status (401 / 404); only unexpected errors
    // are reported and answered with 500, as before.
    const refused = accessErrorResponse(error);

    if (refused) {
      return refused;
    }

    reportRouteError(error, { request });

    return NextResponse.json(
      {
        success: false,
        message: "Failed to load quiz analytics",
      },
      { status: 500 }
    );
  }
}
