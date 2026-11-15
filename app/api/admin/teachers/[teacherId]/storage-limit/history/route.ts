import { apiSuccess } from "@/lib/api-response";
import { requireAdminSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { buildPaginationMeta, parsePaginationParams } from "@/lib/pagination";
import { listTeacherStorageLimitHistory } from "@/services/admin-teacher-storage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/teachers/[teacherId]/storage-limit/history?page=&pageSize=
 * (Stage 3.4, administrators only): the teacher's storage-limit changes,
 * newest first, paginated. Read only.
 */
export async function GET(request: Request, context: { params: { teacherId: string } }) {
  try {
    await requireAdminSession();
    const pagination = parsePaginationParams(new URL(request.url).searchParams);
    const { items, totalItems } = await listTeacherStorageLimitHistory(context.params.teacherId, pagination);
    return apiSuccess({ items, pagination: buildPaginationMeta(totalItems, pagination.page, pagination.pageSize) });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
