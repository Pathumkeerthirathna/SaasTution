import { apiSuccess } from "@/lib/api-response";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { getSectionVisibility } from "@/services/teacher-profile-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const teacherId = searchParams.get("teacherId");

    if (!teacherId) {
      throw new AppError("Teacher id is required.", 400, "VALIDATION_ERROR");
    }

    const visibility = await getSectionVisibility(teacherId);

    return apiSuccess(visibility);
  } catch (error) {
    return handleRouteError(error);
  }
}
