import { apiSuccess } from "@/lib/api-response";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { requireTeacherSession } from "@/lib/auth-session";
import {
  getTeacherProfileSections,
  reorderTeacherProfileSections,
} from "@/services/teacher-profile-section-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireTeacherSession();
    const sections = await getTeacherProfileSections(session.teacherId);

    return apiSuccess(sections);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await requireTeacherSession();

    const body = (await request.json()) as { order?: unknown };

    if (
      !Array.isArray(body.order) ||
      body.order.some((item) => typeof item !== "string")
    ) {
      throw new AppError(
        "`order` must be an array of section types.",
        400,
        "VALIDATION_ERROR"
      );
    }

    const sections = await reorderTeacherProfileSections(
      session.teacherId,
      body.order as string[]
    );

    return apiSuccess(sections);
  } catch (error) {
    return handleRouteError(error);
  }
}
