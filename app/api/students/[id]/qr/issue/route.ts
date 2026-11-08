import { apiSuccess } from "@/lib/api-response";
import { checkSameOriginRequest } from "@/lib/same-origin";
import {
  crossOriginRejectedResponse,
  studentQrErrorResponse,
  toPublicQrStatus,
  withNoStore,
} from "@/lib/student-qr-http";
import { requireTeacherOwnedStudent } from "@/lib/teacher-student-access";
import { getOrCreateActiveToken, getQrStatus } from "@/services/student-qr-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/students/[id]/qr/issue — issues the first QR (reason ISSUE,
 * created by the teacher) of a student the signed-in teacher owns, if there
 * is none. Idempotent; never counts towards the regeneration limit.
 * Same-origin only, checked before anything else; then 401 without a teacher
 * session and 404 for an unknown student or another teacher's. Any body is
 * ignored. Returns the status only.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) return crossOriginRejectedResponse(origin);

  try {
    const { teacherId, studentId } = await requireTeacherOwnedStudent(context.params?.id);
    await getOrCreateActiveToken(studentId, { role: "TEACHER", id: teacherId });
    const status = await getQrStatus(studentId);
    return withNoStore(apiSuccess(toPublicQrStatus(status)));
  } catch (error) {
    return studentQrErrorResponse(error, request);
  }
}
