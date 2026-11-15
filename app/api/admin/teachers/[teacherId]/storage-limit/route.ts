import { apiError, apiSuccess } from "@/lib/api-response";
import { requireAdminSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { parseStorageLimitRequest } from "@/lib/storage-quota/limit-input";
import { assertTeacherIdFormat, getAdminTeacherStorageSummary, setTeacherStorageLimit } from "@/services/admin-teacher-storage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUT /api/admin/teachers/[teacherId]/storage-limit (Stage 3.4, administrators only).
 * Body, exactly one of (decimal GB: 1 GB = 1,000,000,000 bytes):
 *   { "limitGB": "50" }               set the individual override (up to 9 decimals; 0 .. 1,000,000)
 *   { "limitBytes": "50000000000" }   the same, in bytes, as a decimal string
 *   { "removeOverride": true }        remove it: back to the active plan's limit, or unlimited
 * 0 is a real limit (nothing more may be stored), never "unlimited". The
 * override and its audit row are written in one transaction; the
 * administrator is the session's. A limit below the current usage is saved
 * (files are never touched) and reported as over the limit. Responds with
 * the updated storage summary and whether anything changed.
 */
export async function PUT(request: Request, context: { params: { teacherId: string } }) {
  try {
    const admin = await requireAdminSession();
    assertTeacherIdFormat(context.params.teacherId);
    const parsed = parseStorageLimitRequest(await request.json());
    if (!parsed.ok) return apiError(parsed.message, 400, "VALIDATION_ERROR");

    const { changed } = await setTeacherStorageLimit({
      teacherId: context.params.teacherId,
      admin: { adminId: admin.adminId, email: admin.email },
      request: parsed.value,
    });
    const summary = await getAdminTeacherStorageSummary(context.params.teacherId);
    return apiSuccess(
      { changed, ...summary },
      { message: !changed ? "The storage limit is unchanged." : parsed.value.kind === "remove" ? "The individual storage limit was removed." : "The storage limit was saved." }
    );
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
