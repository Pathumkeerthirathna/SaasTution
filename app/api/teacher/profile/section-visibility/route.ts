import { apiError, apiSuccess } from "@/lib/api-response";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { requireTeacherSessionForbiddingOtherRoles } from "@/lib/auth-session";
import { checkSameOriginRequest } from "@/lib/same-origin";
import {
  ProfileSection,
  getSectionVisibility,
  updateSectionVisibility,
} from "@/services/teacher-profile-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECTIONS: ProfileSection[] = ["qualification", "achievements", "subjects", "paymentDetails"];

export async function GET(request: Request) {
  try {
    const session = await requireTeacherSessionForbiddingOtherRoles();
    const visibility = await getSectionVisibility(session.teacherId);

    return apiSuccess(visibility);
  } catch (error) {
    return handleRouteError(error, { request });
  }
}

export async function PATCH(request: Request) {
  // Same-origin only (CSRF), before authentication - like the payment account mutations.
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) {
    return apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  }

  try {
    const session = await requireTeacherSessionForbiddingOtherRoles();

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
    return handleRouteError(error, { request });
  }
}
