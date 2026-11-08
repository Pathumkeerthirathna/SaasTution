import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { checkSameOriginRequest } from "@/lib/same-origin";
import {
  crossOriginRejectedResponse,
  studentQrErrorResponse,
  toPublicQrStatus,
  withNoStore,
} from "@/lib/student-qr-http";
import { getQrStatus, regenerateToken } from "@/services/student-qr-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/students/me/qr/regenerate — replaces the signed-in student's QR
 * (max 5 per rolling 24 hours, shared with teacher regenerations).
 * Same-origin only (lib/same-origin.ts), checked before anything else. The
 * student comes from the session; any body is ignored. Returns the new
 * status only — the new QR image is fetched from GET /api/students/me/qr.
 */
export async function POST(request: Request) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) return crossOriginRejectedResponse(origin);

  try {
    const session = await requireStudentSession();
    await regenerateToken(session.studentId, { role: "STUDENT", id: session.studentId });
    const status = await getQrStatus(session.studentId);
    return withNoStore(apiSuccess(toPublicQrStatus(status), { message: "Your QR code was regenerated." }));
  } catch (error) {
    return studentQrErrorResponse(error, request);
  }
}
