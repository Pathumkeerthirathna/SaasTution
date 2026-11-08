import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { checkSameOriginRequest } from "@/lib/same-origin";
import {
  crossOriginRejectedResponse,
  studentQrErrorResponse,
  toPublicQrStatus,
  withNoStore,
} from "@/lib/student-qr-http";
import { getOrCreateActiveToken, getQrStatus } from "@/services/student-qr-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/students/me/qr/issue — issues the signed-in student's first QR
 * (reason ISSUE) if there is none. Idempotent: with an active QR nothing
 * changes. Never counts towards the regeneration limit. Same-origin only
 * (lib/same-origin.ts), checked before the session or the database. The
 * student comes from the session; any body is ignored. Returns the status
 * only — the image is fetched from GET /api/students/me/qr.
 */
export async function POST(request: Request) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) return crossOriginRejectedResponse(origin);

  try {
    const session = await requireStudentSession();
    await getOrCreateActiveToken(session.studentId, { role: "STUDENT", id: session.studentId });
    const status = await getQrStatus(session.studentId);
    return withNoStore(apiSuccess(toPublicQrStatus(status)));
  } catch (error) {
    return studentQrErrorResponse(error, request);
  }
}
