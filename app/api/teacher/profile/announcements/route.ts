import { apiSuccess } from "@/lib/api-response";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { requireTeacherSession } from "@/lib/auth-session";
import {
  addTeacherAnnouncement,
  getTeacherAnnouncements,
} from "@/services/teacher-announcement-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireTeacherSession();
    const announcements = await getTeacherAnnouncements(session.teacherId);

    return apiSuccess(announcements);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireTeacherSession();

    const form = await request.formData();
    const description = String(form.get("description") ?? "");
    const fileEntry = form.get("image");
    const file = fileEntry instanceof File ? fileEntry : null;

    if (!file) {
      throw new AppError("An image is required.", 400, "VALIDATION_ERROR");
    }

    const announcement = await addTeacherAnnouncement(session.teacherId, {
      description,
      file,
    });

    return apiSuccess(announcement, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
