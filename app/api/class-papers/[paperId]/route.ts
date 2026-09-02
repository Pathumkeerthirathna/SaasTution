import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import {
  deleteClassPaperForTeacher,
  getClassPaperForTeacher,
} from "@/services/class-paper-service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: { paperId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const paper = await getClassPaperForTeacher(session.teacherId, params.paperId);
    return apiSuccess({ paper });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: { paperId: string } }
) {
  try {
    const session = await requireTeacherSession();
    const result = await deleteClassPaperForTeacher(session.teacherId, params.paperId);
    return apiSuccess(result, { message: "Paper removed." });
  } catch (error) {
    return handleRouteError(error);
  }
}
