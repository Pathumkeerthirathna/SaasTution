import { apiSuccess } from "@/lib/api-response";
import { requireAdminSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { getAdminTeacherStorageSummary } from "@/services/admin-teacher-storage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/teachers/[teacherId]/storage (Stage 3.4, administrators only):
 * the teacher's storage usage per category (committed and reserved), the
 * effective limit and its source, the individual override and the
 * subscription plan. Byte counts are decimal strings; no storage key, path or
 * hash is returned.
 */
export async function GET(request: Request, context: { params: { teacherId: string } }) {
  try {
    await requireAdminSession();
    const summary = await getAdminTeacherStorageSummary(context.params.teacherId);
    return apiSuccess(summary);
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
