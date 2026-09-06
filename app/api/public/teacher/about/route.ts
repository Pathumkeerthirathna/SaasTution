import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { getAboutMe, isProfilePublic } from "@/services/teacher-profile-service";

export async function GET(
  request: Request
) {
  try {
    const { searchParams } = new URL(request.url);

    const teacherId = searchParams.get("teacherId");

    if (!teacherId) {
      throw new Error("Teacher ID is required.");
    }

    if (!(await isProfilePublic(teacherId))) {
      return apiSuccess({ aboutMe: null });
    }

    const teacher = await getAboutMe(teacherId);

    return apiSuccess(teacher);

  } catch (error) {
    return handleRouteError(error);
  }
}