import { apiError, apiSuccess } from "@/lib/api-response";
import { requireAdminSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { blockTeacherAccount } from "@/services/admin-teacher-service";

export async function POST(
  request: Request,
  context: { params: { teacherId: string } }
) {
  try {
    await requireAdminSession();

    const body = (await request.json()) as { reason?: string };
    const reason = body.reason?.trim() ?? "";

    if (!reason) {
      return apiError(
        "Please provide a reason for blocking this teacher.",
        400,
        "VALIDATION_ERROR"
      );
    }

    const teacher = await blockTeacherAccount(context.params.teacherId, reason);

    return apiSuccess({ teacher }, { message: "Teacher blocked." });
  } catch (error) {
    return handleRouteError(error);
  }
}
