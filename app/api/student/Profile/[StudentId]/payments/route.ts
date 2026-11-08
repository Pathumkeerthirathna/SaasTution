import { reportRouteError } from "@/lib/error-handler";
import { NextResponse } from "next/server";
import { accessErrorResponse, requireTeacherOwnedStudent } from "@/lib/teacher-student-access";
import { getStudentPaymentSummary } from "@/services/student-service";

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

    const data = await getStudentPaymentSummary(studentId);

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
        message: "Failed to load student payments",
      },
      { status: 500 }
    );
  }
}
