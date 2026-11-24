import { apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { listStudentRecordedLectures } from "@/services/recorded-lecture-student-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * The signed-in student's recorded lectures (Recorded Lectures RL-4.2).
 *
 *   GET /api/student/recorded-lectures?scope=all|dashboard&lectureId=&classId=&cursor=&limit=
 *
 * Outside the middleware matcher like the other /api/student routes: the
 * handler authenticates itself (requireStudentSession, every request), and
 * the service authorises every row (approved student, active enrollment,
 * active class and lecture, active READY recording).
 */
export async function GET(request: Request) {
  try {
    const session = await requireStudentSession();
    const params = new URL(request.url).searchParams;
    const list = await listStudentRecordedLectures({
      studentId: session.studentId,
      query: {
        scope: params.get("scope"),
        section: params.get("section"),
        lectureId: params.get("lectureId"),
        classId: params.get("classId"),
        cursor: params.get("cursor"),
        limit: params.get("limit"),
      },
    });
    return apiSuccess(list);
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
