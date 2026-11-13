import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { AppError, handleRouteError } from "@/lib/error-handler";
import { clientKey } from "@/lib/error-logging/request-trust";
import {
  passwordResetRequestRateLimiter,
  type PasswordResetRequestRateLimiter,
} from "@/lib/password-reset-request-rate-limit";
import { checkSameOriginRequest } from "@/lib/same-origin";
import { requestPasswordReset } from "@/services/auth-service";

/*
 * POST /api/auth/password-reset/request (Student Profile SP-7C).
 *
 *  1. Same-origin (403 CROSS_ORIGIN_REQUEST_REJECTED) — before anything else.
 *  2. Body <= 1 KiB (413 REQUEST_TOO_LARGE), JSON (400 INVALID_JSON), exactly
 *     { loginId: string, 1–254 characters after trimming } (400 VALIDATION_ERROR).
 *     These answers depend only on the request's form, never on an account.
 *  3. Rate limits (lib/password-reset-request-rate-limit.ts): per identifier
 *     (hashed), per trusted client address (clientKey), global. Refused:
 *     429 PASSWORD_RESET_RATE_LIMITED with Retry-After from the limiter state.
 *     Every well-formed request counts, whatever the account.
 *  4. The service (services/auth-service.ts requestPasswordReset). Every
 *     outcome — teacher, guardian or student found, nothing found, deleted,
 *     no email, ambiguous, token or mail failure — is the SAME 200 answer.
 * Every response is no-store. Nothing from the body (identifier, email,
 * token) is logged here.
 */

export const PASSWORD_RESET_REQUEST_MAX_BODY_BYTES = 1024;
/** Longest accepted identifier: an email address (254) — registration numbers are at most 64. */
export const PASSWORD_RESET_LOGIN_ID_MAX_LENGTH = 254;

export const PASSWORD_RESET_REQUESTED_MESSAGE = "If an account exists, a reset link has been sent to the registered email address.";

const passwordResetRequestBodySchema = z
  .object({
    loginId: z
      .string({ error: "Email or registration number is required." })
      .trim()
      .min(1, "Email or registration number is required.")
      .max(PASSWORD_RESET_LOGIN_ID_MAX_LENGTH, "Email or registration number is too long."),
  })
  .strict();

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

async function readSmallJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,15}$/.test(declared.trim()) || Number(declared.trim()) > PASSWORD_RESET_REQUEST_MAX_BODY_BYTES)) {
    throw new AppError("The request is too large.", 413, "REQUEST_TOO_LARGE");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > PASSWORD_RESET_REQUEST_MAX_BODY_BYTES) {
    throw new AppError("The request is too large.", 413, "REQUEST_TOO_LARGE");
  }
  if (text.trim() === "") throw new SyntaxError("Empty JSON body.");
  return JSON.parse(text) as unknown;
}

export async function handlePasswordResetRequest(
  request: Request,
  options: { appBaseUrl?: string; limiter?: PasswordResetRequestRateLimiter } = {}
): Promise<Response> {
  const origin = checkSameOriginRequest(request);
  if (!origin.allowed) {
    return withNoStore(apiError("This request must come from the application itself.", 403, "CROSS_ORIGIN_REQUEST_REJECTED"));
  }

  try {
    const parsed = passwordResetRequestBodySchema.safeParse(await readSmallJson(request));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const bodyLevel = issue?.code === "unrecognized_keys" || !issue?.path?.length;
      return withNoStore(
        apiError(bodyLevel ? "Only your email or registration number can be sent." : issue.message, 400, "VALIDATION_ERROR", {
          field: bodyLevel ? "body" : String(issue.path[0]),
        })
      );
    }

    const limiter = options.limiter ?? passwordResetRequestRateLimiter();
    const decision = limiter.attempt(parsed.data.loginId, clientKey(request));
    if (!decision.allowed) {
      const limited = withNoStore(
        apiError("Too many password reset requests. Please wait and try again.", 429, "PASSWORD_RESET_RATE_LIMITED")
      );
      limited.headers.set("Retry-After", String(decision.retryAfterSeconds));
      return limited;
    }

    await requestPasswordReset(parsed.data.loginId, options.appBaseUrl);

    return withNoStore(apiSuccess({ requested: true }, { message: PASSWORD_RESET_REQUESTED_MESSAGE }));
  } catch (error) {
    return withNoStore(handleRouteError(error, { request }));
  }
}
