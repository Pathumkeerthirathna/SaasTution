import { apiSuccess } from "@/lib/api-response";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { requireTeacherSession } from "@/lib/auth-session";
import {
  deleteTeacherAnnouncement,
  updateTeacherAnnouncement,
} from "@/services/teacher-announcement-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: { params: { id: string } }
) {
  try {
    const session = await requireTeacherSession();
    const { id } = context.params;

    if (!id?.trim()) {
      throw new AppError("Announcement id is required.", 400, "VALIDATION_ERROR");
    }

    const form = await request.formData();
    const description = String(form.get("description") ?? "");
    const fileEntry = form.get("image");
    const file = fileEntry instanceof File && fileEntry.size > 0 ? fileEntry : null;

    const announcement = await updateTeacherAnnouncement(session.teacherId, id, {
      description,
      file,
    });

    return apiSuccess(announcement);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: { id: string } }
) {
  try {
    const session = await requireTeacherSession();
    const { id } = context.params;

    if (!id?.trim()) {
      throw new AppError("Announcement id is required.", 400, "VALIDATION_ERROR");
    }

    const result = await deleteTeacherAnnouncement(session.teacherId, id);

    return apiSuccess(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
