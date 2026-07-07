import { apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { getPublicTeacherProfile } from "@/services/teacher-profile-service";

interface RouteParams {
  params: Promise<{
    slug: string;
  }>;
}

export async function GET(
  request: Request,
  { params }: RouteParams
) {
  try {
    const { slug } = await params;

    const teacher = await getPublicTeacherProfile(slug);

    return apiSuccess(teacher);
    
  } catch (error) {
    return handleRouteError(error);
  }
}