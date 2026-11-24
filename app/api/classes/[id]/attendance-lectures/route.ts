import { apiError, apiSuccess } from "@/lib/api-response";
import { withNoStore } from "@/lib/attendance-http";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { createLectureSchema } from "@/lib/lecture-validation";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { createAttendanceLectureForTeacher } from "@/services/attendance-lecture-create-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/classes/[id]/attendance-lectures — creates a normal lecture for
 * QR attendance after the teacher confirmed it on the Attendance page
 * (services/attendance-lecture-create-service.ts).
 *
 * Body: { title, date, endDate?, allowAdditionalSession? } — the fields and
 * validation of POST /api/lectures (createLectureSchema: Sri Lankan
 * "YYYY-MM-DDTHH:MM" times, end after start, at most 12 hours), the class
 * from the path. allowAdditionalSession: true only after the teacher
 * confirmed a session overlapping an existing lecture (409
 * ATTENDANCE_LECTURE_EXISTS otherwise).
 *
 * Same-origin first (403), then the teacher session (401), then the body
 * (400). Another teacher's or an unknown class: 404 CLASS_NOT_FOUND. 201
 * { lecture }. Always no-store.
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) {
    return withNoStore(apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED"));
  }

  try {
    const { teacherId } = await requireTeacherSession();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return withNoStore(apiError("The request body must be JSON.", 400, "INVALID_JSON"));
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return withNoStore(apiError("Invalid request payload.", 400, "VALIDATION_ERROR"));
    }

    // A classId in the body is ignored: the class is the path's.
    const { allowAdditionalSession, ...fields } = body as Record<string, unknown>;
    delete fields.classId;
    if (allowAdditionalSession !== undefined && typeof allowAdditionalSession !== "boolean") {
      return withNoStore(apiError("allowAdditionalSession must be true or false.", 400, "VALIDATION_ERROR"));
    }

    const parsed = createLectureSchema.safeParse({ ...fields, classId: context.params.id });
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return withNoStore(apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten()));
    }

    const lecture = await createAttendanceLectureForTeacher(teacherId, {
      ...parsed.data,
      allowAdditionalSession: allowAdditionalSession === true,
    });

    return withNoStore(apiSuccess({ lecture }, { status: 201, message: "Lecture created successfully." }));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
