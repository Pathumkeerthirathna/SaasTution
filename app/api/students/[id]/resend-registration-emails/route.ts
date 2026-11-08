import { apiSuccess } from "@/lib/api-response";
import { requireTeacherSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { resendStudentRegistrationEmails } from "@/services/student-registration-email-resend-service";

/**
 * Resends the two original registration emails (welcome + confirmation code)
 * to one of the signed-in teacher's students whose email is not verified yet.
 */
export async function POST(
  request: Request,
  context: { params: { id: string } }
) {
  try {
    const session = await requireTeacherSession();
    const studentId = context.params.id?.trim();

    if (!studentId) {
      throw new AppError("Student id is required.", 400, "VALIDATION_ERROR");
    }

    const result = await resendStudentRegistrationEmails(session.teacherId, studentId);

    return apiSuccess(result, {
      message:
        result.outcome === "SENT"
          ? `Both registration emails were resent to ${result.email}.`
          : result.registrationEmailSent
          ? `The welcome email was resent to ${result.email}, but the confirmation code email could not be sent.`
          : `The confirmation code email was resent to ${result.email}, but the welcome email could not be sent.`,
    });
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
