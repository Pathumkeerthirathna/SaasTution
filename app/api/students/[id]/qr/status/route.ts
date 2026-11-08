import { apiSuccess } from "@/lib/api-response";
import { studentQrErrorResponse, toPublicQrStatus, withNoStore } from "@/lib/student-qr-http";
import { requireTeacherOwnedStudent } from "@/lib/teacher-student-access";
import { getQrStatus } from "@/services/student-qr-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/students/[id]/qr/status — QR status of a student the signed-in
 * teacher owns (401 without a teacher session; 404 for an unknown student or
 * another teacher's). Safe fields only; never token material.
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const { studentId } = await requireTeacherOwnedStudent(context.params?.id);
    const status = await getQrStatus(studentId);
    return withNoStore(apiSuccess(toPublicQrStatus(status)));
  } catch (error) {
    return studentQrErrorResponse(error, request);
  }
}
