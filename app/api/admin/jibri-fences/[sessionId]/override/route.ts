import { apiSuccess } from "@/lib/api-response";
import { requireAdminSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { overrideJibriShutdownFence } from "@/services/jibri-fence-override-service";

/**
 * Administrators only: explicitly release one class session's Jibri
 * shutdown fence, with a required reason; audited
 * (services/jibri-fence-override-service.ts). Body: { reason }.
 */
export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  try {
    const admin = await requireAdminSession();
    const body = await request.json().catch(() => ({}));

    const result = await overrideJibriShutdownFence({
      sessionId: params.sessionId,
      reason: (body as { reason?: unknown })?.reason,
      admin: { adminId: admin.adminId, email: admin.email },
    });

    return apiSuccess(result, { message: "Jibri shutdown fence released by administrator override." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
