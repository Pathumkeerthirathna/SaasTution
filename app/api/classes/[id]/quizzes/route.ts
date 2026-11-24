import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { createQuizSchema } from "@/lib/lecture-validation";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { createClassQuizForTeacher, listClassQuizzesForTeacher } from "@/services/class-quizzes-service";
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
 * GET /api/classes/[id]/quizzes[?lectureId=]
 *
 * Teacher, own active class only (404 CLASS_NOT_FOUND otherwise). Without
 * lectureId: the class's General Quizzes (its default lecture, resolved on
 * the server; 409 DEFAULT_LECTURE_MISSING when the class has none). With
 * lectureId: that NORMAL lecture's quizzes; another class's lecture, a
 * default lecture or a removed one is 404 LECTURE_NOT_FOUND
 * (services/class-quizzes-service.ts).
 *
 * 200 { class: { id, name }, section: "GENERAL" | "LECTURE", label,
 *       lecture: { id, isDefault, title, date },   (title / date null for GENERAL)
 *       quizzes: [{ id, lectureId, title, maxAttempts, startDateTime, endDateTime,
 *                   questions: [{ id, text, orderIndex, answerType,
 *                                 options: [{ id, text, isCorrect, orderIndex }] }] }] }
 *       (as GET /api/lectures/[id]/quizzes)
 * Edit / delete / results: the existing /api/lectures/[lecture.id]/quizzes/[quizId]... routes.
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const session = await requireTeacherSession();
    const classId = classIdOf(context);
    return apiSuccess(await listClassQuizzesForTeacher(session.teacherId, classId, { lectureId: lectureIdOf(request) }));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

/**
 * POST /api/classes/[id]/quizzes[?lectureId=]
 * Body: the lecture API's createQuizSchema
 *   { title, maxAttempts?, startDateTime, endDateTime,
 *     questions: [{ text, answerType, options: [{ text, isCorrect }] }] }
 *
 * Same-origin first (403), then the teacher session (401), the body (400),
 * then the scope exactly as GET (404 / 409). Without lectureId the quiz is
 * created on the class's default lecture; a lecture id in the body is ignored
 * (only the query parameter selects a lecture, and only a normal one).
 *
 * 201 { class, section, label, lecture, quiz }   (quiz as the lecture API returns it)
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
    const parsed = createQuizSchema.safeParse(body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid request payload.";
      return apiError(firstIssue, 400, "VALIDATION_ERROR", parsed.error.flatten());
    }

    const created = await createClassQuizForTeacher({
      teacherId: session.teacherId,
      classId,
      lectureId,
      quiz: parsed.data,
    });
    return apiSuccess(created, { status: 201, message: "Quiz added successfully." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
