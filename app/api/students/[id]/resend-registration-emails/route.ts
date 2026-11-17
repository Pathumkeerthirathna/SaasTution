import { apiError, apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { clientKey } from "@/lib/error-logging/request-trust";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { teacherStudentPasswordResetRateLimiter } from "@/lib/teacher-student-password-reset-rate-limit";
import { resendStudentRegistrationEmails } from "@/services/student-registration-email-resend-service";

/**
 * "Resend login details" for one of the signed-in teacher's students: a fresh
 * temporary password in the standard welcome email, replacing the previous
 * password (services/student-registration-email-resend-service.ts).
 *
 *  1. Same-origin (403 CROSS_ORIGIN_REQUEST_REJECTED).
 *  2. Teacher session (401); the teacher id comes ONLY from it.
 *  3. The teacher password-reset rate limits (per teacher / trusted address /
 *     global), since this replaces a password too (429 + Retry-After).
 *  4. The service: ownership, eligibility, per-student cooldown; queues the
 *     email (outbox). The background worker sends it and only then activates
 *     the new password. The password is never part of the response.
 */
export async function POST(
  request: Request,
  context: { params: { id: string } }
) {
  if (!checkSameOriginRequest(request).allowed) {
    return apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  }

  try {
    const session = await requireTeacherSession();
    const studentId = typeof context.params?.id === "string" ? context.params.id.trim() : "";

    if (!studentId || studentId.length > 128) {
      throw new AppError("Student not found.", 404, "STUDENT_NOT_FOUND");
    }

    const decision = teacherStudentPasswordResetRateLimiter().attempt(session.teacherId, clientKey(request));
    if (!decision.allowed) {
      const response = apiError("Too many requests. Please wait and try again.", 429, "RESEND_RATE_LIMITED");
      response.headers.set("Retry-After", String(decision.retryAfterSeconds));
      return response;
    }

    const result = await resendStudentRegistrationEmails(session.teacherId, studentId);

    return apiSuccess(result, {
      message: `New login details are queued for ${result.email}. The student's current password keeps working until the email has been accepted by the email service; then only the new one works. Follow it in Email Delivery.`,
    });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
