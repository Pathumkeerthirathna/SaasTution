import { apiSuccess } from "@/lib/api-response";
import { requireAdminSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { setJibriFenceMode } from "@/lib/jibri-fence-control";

/**
 * Administrators only: set the shared Jibri shutdown mode (off / on /
 * drain) with a required reason; audited (lib/jibri-fence-control.ts).
 * Body: { mode, reason }.
 */
export async function POST(request: Request) {
  try {
    const admin = await requireAdminSession();
    const body = (await request.json().catch(() => ({}))) as { mode?: unknown; reason?: unknown };

    const result = await setJibriFenceMode({
      mode: body.mode,
      reason: body.reason,
      admin: { adminId: admin.adminId, email: admin.email },
    });

    return apiSuccess(result, { message: "Jibri shutdown mode changed." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
