import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { studentQrErrorResponse, toPublicQrStatus, withNoStore } from "@/lib/student-qr-http";
import { getQrStatus } from "@/services/student-qr-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/students/me/qr/status — the signed-in student's QR status
 * (configured, active QR, regenerations left, next allowed time). The
 * student comes from the session only; no token material is returned.
 */
export async function GET(request: Request) {
  try {
    const session = await requireStudentSession();
    const status = await getQrStatus(session.studentId);
    return withNoStore(apiSuccess(toPublicQrStatus(status)));
  } catch (error) {
    return studentQrErrorResponse(error, request);
  }
}
