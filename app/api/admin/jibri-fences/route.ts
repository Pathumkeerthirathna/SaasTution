import { apiSuccess } from "@/lib/api-response";
import { requireAdminSession } from "@/lib/auth-session";
import { handleRouteError } from "@/lib/error-handler";
import { getJibriShutdownHealth, listOpenJibriFences } from "@/services/jibri-fence-override-service";

/**
 * Administrators only: the shared mode, the worker's health and the open
 * Jibri shutdown fences (services/jibri-fence-override-service.ts). No
 * tokens, secrets or Jitsi credentials are included.
 */
export async function GET(request: Request) {
  try {
    await requireAdminSession();

    const [health, fences] = await Promise.all([getJibriShutdownHealth(), listOpenJibriFences()]);

    return apiSuccess({ health, fences });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
