import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { uploadErrorResponse } from "@/lib/recorded-lectures/upload-errors";
import { listTeacherLectureRecordings } from "@/services/recorded-lecture-teacher-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * A lecture's recorded lectures for its teacher (every state of the active
 * recordings, with upload progress). 404 for a lecture that is not the
 * teacher's own active lecture. Uploading uses ./uploads (RL-3).
 */
export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const session = await requireTeacherSession();
    const result = await listTeacherLectureRecordings({ teacherId: session.teacherId, lectureId: context.params.id });
    const response = apiSuccess(result);
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) {
    return uploadErrorResponse(error, request);
  }
}
