import { NextRequest, NextResponse } from "next/server";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { confirmStudent } from "../../../../../services/student-service";

// Errors: { success: false, error: { message, code } } with 401 UNAUTHORIZED,
// 404 STUDENT_NOT_FOUND, 409 STUDENT_ALREADY_APPROVED / STUDENT_DECISION_BUSY,
// 500 INTERNAL_SERVER_ERROR.
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireTeacherSession();
    await confirmStudent(session.teacherId, params.id);

    return NextResponse.json({
      success: true,
      message: "Student confirmed successfully.",
    });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
