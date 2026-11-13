import { apiError, apiSuccess } from "@/lib/api-response";
import { requireStudentSession } from "@/lib/auth-session";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { createRateLimiter } from "@/lib/error-logging/rate-limit";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { PROFILE_UPDATE_MAX_BODY_BYTES, PROFILE_UPDATE_RATE_LIMIT, studentProfileUpdateSchema } from "@/lib/student-profile-validation";
import { getStudentOwnProfile, updateStudentOwnPhone } from "@/services/student-profile-service";

export const dynamic = "force-dynamic";

/** Private to the signed-in student: never stored by browsers, proxies or CDNs. */
const NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};

function withNoStore(response: Response): Response {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(name, value);
  return response;
}

/**
 * GET /api/students/me/profile (Student Profile SP-2) — the signed-in
 * student's own profile, read only (services/student-profile-service.ts).
 * The student comes ONLY from the session: query parameters, headers or a
 * body are never read, so no student id can be supplied. 401 without a
 * student session; 404 STUDENT_NOT_FOUND for a missing or deleted account;
 * 403 STUDENT_ACCOUNT_INACTIVE for an inactive one. Always no-store.
 */
export async function GET(request: Request) {
  try {
    const session = await requireStudentSession();
    const profile = await getStudentOwnProfile(session.studentId);
    return withNoStore(apiSuccess(profile));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}

// ---- PATCH: the student's own phone number (Student Profile SP-3) ----------------------------

// In memory (production is one Node process); route files may only export handlers and config.
const updateLimiter = createRateLimiter({
  perKey: PROFILE_UPDATE_RATE_LIMIT.perStudent,
  global: PROFILE_UPDATE_RATE_LIMIT.global,
  windowMs: PROFILE_UPDATE_RATE_LIMIT.windowMs,
});
const RETRY_AFTER_SECONDS = String(Math.ceil(PROFILE_UPDATE_RATE_LIMIT.windowMs / 1000));

async function readSmallJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,15}$/.test(declared.trim()) || Number(declared.trim()) > PROFILE_UPDATE_MAX_BODY_BYTES)) {
    throw new AppError("The request is too large.", 413, "REQUEST_TOO_LARGE");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > PROFILE_UPDATE_MAX_BODY_BYTES) throw new AppError("The request is too large.", 413, "REQUEST_TOO_LARGE");
  if (text.trim() === "") throw new SyntaxError("Empty JSON body.");
  return JSON.parse(text) as unknown;
}

/**
 * PATCH /api/students/me/profile — the signed-in student replaces their own
 * phone number (`contact01`). Order: same-origin check (403, before the
 * session or the body is touched); student session (401); rate limit per
 * student (429 PROFILE_UPDATE_RATE_LIMITED + Retry-After); body at most 1 KiB
 * (413), valid JSON (400 INVALID_JSON), exactly `{ contact01 }` (400
 * VALIDATION_ERROR, `details.field`: "body" for any other field, a student
 * id included; "contact01" for an invalid number); then the update (404 /
 * 403 for unavailable accounts, as GET). Answers the profile exactly as GET
 * does. Always no-store. Name, email, registration number and every other
 * field stay read only.
 */
export async function PATCH(request: Request) {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) {
    return withNoStore(apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED"));
  }

  try {
    const session = await requireStudentSession();

    if (!updateLimiter.allow(session.studentId)) {
      const response = withNoStore(apiError("Too many profile changes. Please wait a few minutes and try again.", 429, "PROFILE_UPDATE_RATE_LIMITED"));
      response.headers.set("Retry-After", RETRY_AFTER_SECONDS);
      return response;
    }

    const parsed = studentProfileUpdateSchema.safeParse(await readSmallJson(request));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const unknownField = issue?.code === "unrecognized_keys" || !issue?.path?.length;
      return withNoStore(
        apiError(
          unknownField ? "Only your phone number can be changed here." : issue?.message ?? "Invalid request.",
          400,
          "VALIDATION_ERROR",
          { field: unknownField ? "body" : String(issue.path[0]) }
        )
      );
    }

    const profile = await updateStudentOwnPhone(session.studentId, parsed.data.contact01);
    return withNoStore(apiSuccess(profile, { message: "Your phone number was updated." }));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
