import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { clientKey } from "@/lib/error-logging/request-trust";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { teacherStudentPasswordResetRateLimiter } from "@/lib/teacher-student-password-reset-rate-limit";
import { wakeEmailDeliveryWorker } from "@/services/email-delivery-worker";
import { retryEmailDeliveryByTeacher } from "@/services/student-email-delivery-service";

/**
 * Teacher manual retry of one FAILED student email with the SAME credentials.
 *  1. Same-origin (403). 2. Teacher session (401); ownership checked in the
 *  service (404 for another teacher's record). 3. The teacher credential rate
 *  limits (429 + Retry-After). 4. Eligibility (409): only FAILED records whose
 *  encrypted credentials are still usable; otherwise use Resend Login Details.
 */
export async function POST(request: Request, context: { params: { deliveryId: string } }) {
  if (!checkSameOriginRequest(request).allowed) {
    return apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  }

  try {
    const session = await requireTeacherSession();
    const deliveryId = typeof context.params?.deliveryId === "string" ? context.params.deliveryId.trim() : "";
    if (!deliveryId || deliveryId.length > 128) {
      throw new AppError("Email record not found.", 404, "EMAIL_DELIVERY_NOT_FOUND");
    }

    const decision = teacherStudentPasswordResetRateLimiter().attempt(session.teacherId, clientKey(request));
    if (!decision.allowed) {
      const response = apiError("Too many requests. Please wait and try again.", 429, "EMAIL_RETRY_RATE_LIMITED");
      response.headers.set("Retry-After", String(decision.retryAfterSeconds));
      return response;
    }

    const result = await retryEmailDeliveryByTeacher({ teacherId: session.teacherId, deliveryId });
    wakeEmailDeliveryWorker();

    return apiSuccess(result, { message: "The email was queued again. It is sent in the background; its status updates in the history." });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
