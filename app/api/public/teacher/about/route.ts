import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { getAboutMe } from "@/services/teacher-profile-service";

export async function GET(
  request: Request
) {
  try {
    const { searchParams } = new URL(request.url);

    const teacherId = searchParams.get("teacherId");

    if (!teacherId) {
      throw new Error("Teacher ID is required.");
    }

    const teacher = await getAboutMe(teacherId);

    return apiSuccess(teacher);
    
  } catch (error) {
    return handleRouteError(error);
  }
}