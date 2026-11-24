import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { withNoStore } from "@/lib/attendance-http";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { getClassAttendanceMatrixForTeacher, parseMatrixMonth } from "@/services/class-attendance-matrix-service";

export const dynamic = "force-dynamic";

const classIdSchema = z.string().trim().uuid("Invalid id format.");

/**
 * GET /api/classes/[id]/attendance-matrix?month=YYYY-MM — one Sri Lankan
 * calendar month of the class's attendance: students × actual lectures
 * (services/class-attendance-matrix-service.ts). Read only. `month`
 * omitted: the current Asia/Colombo month. The teacher comes only from the
 * session (401); another teacher's, a deleted or an unknown class: 404
 * CLASS_NOT_FOUND; a bad id or month: 400. Always no-store.
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const { teacherId } = await requireTeacherSession();

    const classId = classIdSchema.safeParse(context.params.id);
    if (!classId.success) return withNoStore(apiError("Invalid id format.", 400, "VALIDATION_ERROR"));

    const month = parseMatrixMonth(new URL(request.url).searchParams.get("month"), new Date());
    if (!month) return withNoStore(apiError("The month must be YYYY-MM (2000–2100).", 400, "VALIDATION_ERROR"));

    const matrix = await getClassAttendanceMatrixForTeacher({ teacherId, classId: classId.data, month });
    return withNoStore(apiSuccess(matrix));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
