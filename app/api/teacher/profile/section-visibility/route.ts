import { apiSuccess } from "@/lib/api-response";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { requireTeacherSession } from "@/lib/auth-session";
import {
  ProfileSection,
  getSectionVisibility,
  updateSectionVisibility,
} from "@/services/teacher-profile-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECTIONS: ProfileSection[] = ["qualification", "achievements", "subjects"];

export async function GET() {
  try {
    const session = await requireTeacherSession();
    const visibility = await getSectionVisibility(session.teacherId);

    return apiSuccess(visibility);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireTeacherSession();

    const body = (await request.json()) as {
      section?: string;
      visible?: boolean;
    };

    if (!body.section || !SECTIONS.includes(body.section as ProfileSection)) {
      throw new AppError(
        "A valid section is required.",
        400,
        "VALIDATION_ERROR"
      );
    }

    if (typeof body.visible !== "boolean") {
      throw new AppError(
        "`visible` must be a boolean.",
        400,
        "VALIDATION_ERROR"
      );
    }

    const visibility = await updateSectionVisibility(
      session.teacherId,
      body.section as ProfileSection,
      body.visible
    );

    return apiSuccess(visibility);
  } catch (error) {
    return handleRouteError(error);
  }
}
