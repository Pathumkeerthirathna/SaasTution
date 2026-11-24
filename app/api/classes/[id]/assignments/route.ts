import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { createAssignmentSchema } from "@/lib/lecture-validation";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { createClassAssignmentForTeacher, listClassAssignmentsForTeacher } from "@/services/class-assignments-service";
import { parseNotesLectureParam } from "@/services/class-notes-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function classIdOf(context: { params: { id: string } }): string {
  const classId = context.params.id?.trim();
  if (!classId) throw new AppError("Class id is required.", 400, "VALIDATION_ERROR");
  return classId;
}

function lectureIdOf(request: Request): string | null {
  return parseNotesLectureParam(new URL(request.url).searchParams.get("lectureId"));
}

/**
 * GET /api/classes/[id]/assignments[?lectureId=]
 *
 * Teacher, own active class only (404 CLASS_NOT_FOUND otherwise). Without
 * lectureId: the class's General Assignments (its default lecture, resolved
 * on the server; 409 DEFAULT_LECTURE_MISSING when the class has none). With
 * lectureId: that NORMAL lecture's assignments; another class's lecture, a
 * default lecture or a removed one is 404 LECTURE_NOT_FOUND
 * (services/class-assignments-service.ts).
 *
 * 200 { class: { id, name }, section: "GENERAL" | "LECTURE", label,
 *       lecture: { id, isDefault, title, date },   (title / date null for GENERAL)
 *       assignments: [{ id, title, description, dueDate }] }   (as GET /api/lectures/[id]/assignments)
 * Update / delete / submissions / files / marks: the existing
 * /api/lectures/[lecture.id]/assignments/[assignmentId]/... routes.
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const session = await requireTeacherSession();
    const classId = classIdOf(context);
    return apiSuccess(await listClassAssignmentsForTeacher(session.teacherId, classId, { lectureId: lectureIdOf(request) }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

/**
 * POST /api/classes/[id]/assignments[?lectureId=]
 * Body: { title, description, dueDate }  (the lecture API's createAssignmentSchema)
 *
 * Same-origin first (403), then the teacher session (401), the body (400),
 * then the scope exactly as GET (404 / 409). Without lectureId the assignment
 * is created on the class's default lecture; a lecture id in the body is
 * ignored (only the query parameter selects a lecture, and only a normal one).
 *
 * 201 { class, section, label, lecture, assignment: { id, lectureId, title, description, dueDate } }
 */
export async function POST(request: Request, context: { params: { id: string } }) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) {
    return apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  }

  try {
    const session = await requireTeacherSession();
    const classId = classIdOf(context);
    const lectureId = lectureIdOf(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("Invalid request payload.", 400, "VALIDATION_ERROR");
    }
    const parsed = createAssignmentSchema.safeParse(body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const created = await createClassAssignmentForTeacher({
      teacherId: session.teacherId,
      classId,
      lectureId,
      assignment: parsed.data,
    });
    return apiSuccess(created, { status: 201, message: "Assignment added successfully." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
