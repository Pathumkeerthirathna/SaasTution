import { apiSuccess } from "@/lib/api-response";
import { checkSameOriginRequest } from "@/lib/same-origin";
import {
  crossOriginRejectedResponse,
  studentQrErrorResponse,
  toPublicQrStatus,
  withNoStore,
} from "@/lib/student-qr-http";
import { requireTeacherOwnedStudent } from "@/lib/teacher-student-access";
import { getQrStatus, regenerateToken } from "@/services/student-qr-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/students/[id]/qr/regenerate — replaces the QR of a student the
 * signed-in teacher owns (max 5 per rolling 24 hours, shared with the
 * student's own regenerations). Same-origin only (lib/same-origin.ts),
 * checked before anything else; then 401 / 404 as for the other QR routes.
 * The student comes from the URL and is checked against the teacher; any
 * body is ignored. Returns the new status only.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) return crossOriginRejectedResponse(origin);

  try {
    const { teacherId, studentId } = await requireTeacherOwnedStudent(context.params?.id);
    await regenerateToken(studentId, { role: "TEACHER", id: teacherId });
    const status = await getQrStatus(studentId);
    return withNoStore(apiSuccess(toPublicQrStatus(status), { message: "The student's QR code was regenerated." }));
  } catch (error) {
    return studentQrErrorResponse(error, request);
  }
}
