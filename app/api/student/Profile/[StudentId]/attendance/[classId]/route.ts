import { reportRouteError } from "@/lib/error-handler";
import { NextResponse } from "next/server";
import { accessErrorResponse, requireTeacherOwnedClass, requireTeacherOwnedStudent } from "@/lib/teacher-student-access";
import { getStudentClassAttendance } from "@/services/student-service";

export const dynamic = "force-dynamic";

// Teacher-only (/dashboard/students/[id]): the signed-in teacher's own student
// (401 without a teacher session, 404 for an unknown or another teacher's student).
// The class must also be one of that teacher's classes.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ StudentId: string; classId: string }> }
) {
  try {
    const { StudentId, classId: rawClassId } = await params;
    const { teacherId, studentId } = await requireTeacherOwnedStudent(StudentId);
    const classId = await requireTeacherOwnedClass(teacherId, rawClassId);

    const data = await getStudentClassAttendance(studentId, classId);

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
        message: "Failed to load student classes",
      },
      { status: 500 }
    );
  }
}
