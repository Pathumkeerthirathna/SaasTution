import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { buildTeacherStorageView } from "@/lib/storage-quota/teacher-view";
import { getTeacherStorageUsage } from "@/services/teacher-storage-usage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/teacher/storage (Stage 3.5): the signed-in teacher's OWN storage
 * usage, read only. The teacher is taken from the session only - no query
 * parameter, body or header can name another teacher. Usage comes from
 * getTeacherStorageUsage (database rows; no filesystem scan). Byte counts are
 * decimal strings; no override value, admin identity, limit history, storage
 * key, path or hash is returned (lib/storage-quota/teacher-view.ts).
 */
export async function GET(request: Request) {
  try {
    const session = await requireTeacherSession();
    const usage = await getTeacherStorageUsage(session.teacherId);
    return apiSuccess(buildTeacherStorageView(usage));
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
