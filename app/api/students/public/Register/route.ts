import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { clientKey } from "@/lib/error-logging/request-trust";
import { prisma } from "@/lib/prisma";
import { publicRegistrationRateLimiter } from "@/lib/public-registration-rate-limit";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { RegisterStudentViaPublicClasses } from "@/services/student-service";

/*
 * POST /api/students/public/Register: anonymous public class registration
 * (the only anonymous /api/students route, see middleware.ts).
 *
 *  1. Same-origin (403 CROSS_ORIGIN_REQUEST_REJECTED).
 *  2. Body validation (400 VALIDATION_ERROR), same limits as adding a student
 *     (lib/student-validation.ts), and the grade must exist. Invalid requests
 *     use no rate-limit budget.
 *  3. Rate limits (lib/public-registration-rate-limit.ts): per email, per
 *     trusted client address, global. Refused: 429 REGISTRATION_RATE_LIMITED
 *     with Retry-After. Every well-formed request counts, whatever the outcome
 *     (a duplicate email's 409 too).
 *  4. The registration service (class check, duplicates, credentials, queued
 *     welcome email), unchanged.
 */

// Optional; stored as "" when absent (as before).
const optionalContact = z
  .string()
  .trim()
  .max(60, "Parent mobile number must be at most 60 characters long.")
  .nullish()
  .transform((value) => value ?? "");

const publicRegistrationSchema = z.object({
  classId: z.string().trim().uuid("Invalid class."),
  studentName: z
    .string({ error: "Student name is required." })
    .trim()
    .min(2, "Student name must be at least 2 characters long.")
    .max(120, "Student name must be at most 120 characters long."),
  mobileNumber: z
    .string({ error: "Mobile number is required." })
    .trim()
    .min(1, "Mobile number is required.")
    .max(60, "Mobile number must be at most 60 characters long."),
  parentMobileNumber: optionalContact,
  gradeId: z.number({ error: "Grade is required." }).int("Grade is required.").positive("Grade is required."),
  email: z
    .string({ error: "Email address is required." })
    .trim()
    .min(1, "Email address is required.")
    .email("Please enter a valid email address.")
    .max(120, "Email must be at most 120 characters long."),
});

export async function POST(request: Request) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) {
    return apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("Invalid request body.", 400, "VALIDATION_ERROR", { field: "body" });
    }

    const parsed = publicRegistrationSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return apiError(issue?.message ?? "Invalid request body.", 400, "VALIDATION_ERROR", {
        field: issue?.path?.length ? String(issue.path[0]) : "body",
      });
    }

    const data = parsed.data;
    const email = data.email.toLowerCase();

    // Any grade the form lists (/api/Grade lists every grade). Checked before
    // the limiter, so a nonexistent grade uses no budget.
    const grade = await prisma.grade.findUnique({ where: { id: data.gradeId }, select: { id: true } });
    if (!grade) {
      return apiError("Please select a valid grade.", 400, "VALIDATION_ERROR", { field: "gradeId" });
    }

    const decision = publicRegistrationRateLimiter().attempt(email, clientKey(request));
    if (!decision.allowed) {
      const limited = apiError(
        "Too many registration attempts. Please wait and try again.",
        429,
        "REGISTRATION_RATE_LIMITED"
      );
      limited.headers.set("Retry-After", String(decision.retryAfterSeconds));
      return limited;
    }

    const { registrationNumber } = await RegisterStudentViaPublicClasses({
      classId: data.classId,
      studentName: data.studentName,
      mobileNumber: data.mobileNumber,
      parentMobileNumber: data.parentMobileNumber,
      gradeId: data.gradeId,
      email,
      school: "",
    });

    // Anonymous caller: only the registration number, never the stored record
    // (it holds the password hash and internal ids).
    return apiSuccess(
      { registrationNumber },
      {
        status: 201,
        message: "Student registered successfully."
      }
    );
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
