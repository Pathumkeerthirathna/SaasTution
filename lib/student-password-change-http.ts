import { apiError, apiSuccess } from "@/lib/api-response";
import { AUTH_COOKIE_NAME, buildSessionCookieConfig, signAuthToken } from "@/lib/auth";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { checkSameOriginRequest } from "@/lib/same-origin";
import {
  createStudentPasswordChangeRateLimiter,
  type StudentPasswordChangeRateLimiter,
} from "@/lib/student-password-change-rate-limit";
import { STUDENT_PASSWORD_CHANGE_MAX_BODY_BYTES, studentPasswordChangeSchema } from "@/lib/student-password-validation";
import { assertStudentSessionAccess, type StudentTokenPayload } from "@/lib/student-session";
import { changeStudentPassword } from "@/services/student-password-change-service";

/*
 * The STUDENT branch of POST /api/auth/password/update (Student Profile
 * SP-5.6). The route hands over the verified student token; teacher and
 * guardian requests never come here.
 *
 *  1. Same-origin (403 CROSS_ORIGIN_REQUEST_REJECTED) — before any database access.
 *  2. Central student session check (401 UNAUTHORIZED / 403 STUDENT_ACCOUNT_INACTIVE).
 *  3. Attempt budget: check (429), then record — once per request.
 *  4. Wrong-password budget: check (429) — before any bcrypt work.
 *  5. Body <= 1 KiB (413 REQUEST_TOO_LARGE / 400 INVALID_JSON), strict schema
 *     (400 VALIDATION_ERROR with details.field).
 *  6. Service: verify, hash, transaction (lib docs in the service). A wrong
 *     current password records one failure.
 *  7. New token (sv + 1, fresh name / email, fresh 7 days) in the existing
 *     cookie. If signing fails after the commit, the cookie is cleared and
 *     the student signs in again (the password is changed either way).
 * Every response is no-store.
 */

const NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "X-Content-Type-Options": "nosniff",
};

function withNoStore<T extends Response>(response: T): T {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(name, value);
  return response;
}

function rateLimited(retryAfterSeconds: number): Response {
  const response = withNoStore(
    apiError("Too many password change attempts. Please wait and try again.", 429, "PASSWORD_CHANGE_RATE_LIMITED")
  );
  response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
}

async function readSmallJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,15}$/.test(declared.trim()) || Number(declared.trim()) > STUDENT_PASSWORD_CHANGE_MAX_BODY_BYTES)) {
    throw new AppError("The request is too large.", 413, "REQUEST_TOO_LARGE");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > STUDENT_PASSWORD_CHANGE_MAX_BODY_BYTES) {
    throw new AppError("The request is too large.", 413, "REQUEST_TOO_LARGE");
  }
  if (text.trim() === "") throw new SyntaxError("Empty JSON body.");
  return JSON.parse(text) as unknown;
}

// One per process (production is a single Node process).
const defaultLimiter = createStudentPasswordChangeRateLimiter();

export async function handleStudentPasswordChange(
  request: Request,
  session: StudentTokenPayload,
  limiter: StudentPasswordChangeRateLimiter = defaultLimiter
): Promise<Response> {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) {
    return withNoStore(apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED"));
  }

  try {
    await assertStudentSessionAccess(session);
    const studentId = session.sub;

    const attempt = limiter.checkAttempt(studentId);
    if (!attempt.allowed) return rateLimited(attempt.retryAfterSeconds);
    limiter.recordAttempt(studentId);

    const failures = limiter.checkFailure(studentId);
    if (!failures.allowed) return rateLimited(failures.retryAfterSeconds);

    const parsed = studentPasswordChangeSchema.safeParse(await readSmallJson(request));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const bodyLevel = issue?.code === "unrecognized_keys" || !issue?.path?.length;
      return withNoStore(
        apiError(bodyLevel ? "Only your current password, new password and its confirmation can be sent." : issue.message, 400, "VALIDATION_ERROR", {
          field: bodyLevel ? "body" : String(issue.path[0]),
        })
      );
    }

    let changed;
    try {
      changed = await changeStudentPassword({
        session,
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.newPassword,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "INVALID_CURRENT_PASSWORD") limiter.recordFailure(studentId);
      throw error;
    }

    let token: string;
    try {
      token = await signAuthToken({
        sub: changed.studentId,
        email: changed.email,
        role: "STUDENT",
        name: changed.name,
        sessionVersion: changed.sessionVersion,
      });
    } catch {
      // The password is changed and every session (this one too) is revoked: sign in again.
      const response = withNoStore(
        apiSuccess({ updated: true, reauthenticate: true }, { message: "Your password was changed. Please sign in again." })
      );
      response.cookies.set(AUTH_COOKIE_NAME, "", { ...buildSessionCookieConfig(), maxAge: 0 });
      return response;
    }

    const response = withNoStore(
      apiSuccess({ updated: true }, { message: "Your password was changed. You have been signed out on your other devices." })
    );
    response.cookies.set(AUTH_COOKIE_NAME, token, buildSessionCookieConfig());
    return response;
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
