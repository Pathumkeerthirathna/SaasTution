import { apiSuccess } from "@/lib/api-response";
import { withNoStore } from "@/lib/attendance-http";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { getOutstandingStudentIdsForClass } from "@/services/class-access-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/classes/[id]/outstanding-students: the unique ids of the class's
 * students who still owe money (any fee month, active enrolments, non-deleted
 * students; services/class-access-service.ts getOutstandingStudentIdsForClass),
 * for the QR attendance scanner's payment warning. Only the class's own
 * teacher (404 CLASS_NOT_FOUND otherwise). Read-only; ids only, no amounts,
 * names or payment history. Always no-store.
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const session = await requireTeacherSession();
    const studentIds = await getOutstandingStudentIdsForClass(session.teacherId, context.params.id);
    return withNoStore(apiSuccess({ studentIds }));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
