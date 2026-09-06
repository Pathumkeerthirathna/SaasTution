import { apiSuccess } from "@/lib/api-response";
import { requireAdminSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { unblockTeacherAccount } from "@/services/admin-teacher-service";

export async function POST(
  request: Request,
  context: { params: { teacherId: string } }
) {
  try {
    await requireAdminSession();

    const teacher = await unblockTeacherAccount(context.params.teacherId);

    return apiSuccess({ teacher }, { message: "Teacher unblocked." });
  } catch (error) {
    return handleRouteError(error);
  }
}
