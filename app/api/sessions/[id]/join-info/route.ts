import { apiError, apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { getSessionJoinInfo, getSessionJoinInfoForTeacher } from "@/services/session-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: {
    params: { id: string };
  }
) {
  try {
    const sessionId = context.params.id;
    const { searchParams } = new URL(request.url);
    const role = searchParams.get("role")?.trim();
    const studentId = searchParams.get("studentId")?.trim();

    if (!sessionId?.trim()) {
      return apiError("Session id is required.", 400, "VALIDATION_ERROR");
    }

    if (role === "teacher") {
      const joinInfo = await getSessionJoinInfoForTeacher(sessionId);
      return apiSuccess(joinInfo);
    }

    if (!studentId) {
      return apiError("studentId query parameter is required.", 400, "VALIDATION_ERROR");
    }

    const joinInfo = await getSessionJoinInfo(sessionId, studentId);

    return apiSuccess(joinInfo);
  } catch (error) {
    return handleRouteError(error);
  }
}
