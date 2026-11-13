import { reportRouteError } from "@/lib/error-handler";

import { requireTeacherSession } from "@/lib/auth-session";
import { clientKey } from "@/lib/error-logging/request-trust";
import { checkSameOriginRequest } from "@/lib/same-origin";
import {
  expectedErrorResponse,
  readSmallJson,
  resetResponse,
  teacherStudentPasswordResetBodySchema,
} from "@/lib/teacher-student-password-reset-http";
import { teacherStudentPasswordResetRateLimiter } from "@/lib/teacher-student-password-reset-rate-limit";
import { resetStudentPasswordByTeacher } from "@/services/teacher-student-password-reset-service";

/*
 * Teacher-initiated student password reset (Student Profile SP-7D).
 *
 *  1. Same-origin (403 CROSS_ORIGIN_REQUEST_REJECTED).
 *  2. Teacher session (401); the teacher id comes ONLY from it.
 *  3. Body <= 1 KiB (413), JSON (400), exactly { password } with the teacher
 *     rule: 8–64 characters, upper + lower + digit, <= 72 UTF-8 bytes (400).
 *  4. Rate limits per teacher / trusted address / global (429 + Retry-After).
 *  5. Service (services/teacher-student-password-reset-service.ts): ownership,
 *     registration-number rule, hash (cost 12), one transaction (password,
 *     sessionVersion + 1, reset tokens retired), then the notification.
 * Answers keep the `{ success, message }` shape the teacher UI reads; all no-store.
 */
export async function POST(
  request: Request,
  {
    params,
  }: {
    params: {
      id: string;
    };
  }
) {
  if (!checkSameOriginRequest(request).allowed) {
    return resetResponse({ status: 403 }, {
      success: false,
      message: "This request must come from the application itself.",
      code: "CROSS_ORIGIN_REQUEST_REJECTED",
    });
  }

  try {
    const session = await requireTeacherSession();

    const parsed = teacherStudentPasswordResetBodySchema.safeParse(await readSmallJson(request));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const bodyLevel = issue?.code === "unrecognized_keys" || !issue?.path?.length;
      return resetResponse({ status: 400 }, {
        success: false,
        message: bodyLevel ? "Only the new password can be sent." : issue.message,
        code: "VALIDATION_ERROR",
      });
    }

    const studentId = typeof params?.id === "string" ? params.id.trim() : "";
    if (!studentId || studentId.length > 128) {
      return resetResponse({ status: 404 }, { success: false, message: "Student not found.", code: "STUDENT_NOT_FOUND" });
    }

    const decision = teacherStudentPasswordResetRateLimiter().attempt(session.teacherId, clientKey(request));
    if (!decision.allowed) {
      return resetResponse(
        { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
        {
          success: false,
          message: "Too many password resets. Please wait and try again.",
          code: "PASSWORD_RESET_RATE_LIMITED",
        }
      );
    }

    await resetStudentPasswordByTeacher({
      teacherId: session.teacherId,
      studentId,
      password: parsed.data.password,
    });

    return resetResponse({ status: 200 }, {
      success: true,
      message: "Password reset successfully. The student has been signed out on all devices.",
    });
  } catch (error) {
    const expected = expectedErrorResponse(error);
    if (expected) return expected;

    reportRouteError(error, { request });

    return resetResponse({ status: 500 }, {
      success: false,
      message: "Failed to reset password.",
    });
  }
}
