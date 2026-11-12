import { NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { confirmAllPendingStudents } from "../../../../services/student-service";

// Approves the teacher's ACTIVE pending students. `count` is the number
// actually approved. Errors: { success: false, error: { message, code } } with
// 401 UNAUTHORIZED, 409 STUDENT_DECISION_BUSY, 500 INTERNAL_SERVER_ERROR.
export async function PUT(request: Request) {
  try {
    const session = await requireTeacherSession();
    const count = await confirmAllPendingStudents(session.teacherId);

    return NextResponse.json({
      success: true,
      count,
      message: `${count} student(s) confirmed successfully.`,
    });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
