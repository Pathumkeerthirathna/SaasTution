import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { requireTeacherOwnedStudent } from "@/lib/teacher-student-access";
import { getStudentDevicesByStudentId } from "@/services/student-device.service";

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

    const devices = await getStudentDevicesByStudentId(studentId);

    return apiSuccess(devices);
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
