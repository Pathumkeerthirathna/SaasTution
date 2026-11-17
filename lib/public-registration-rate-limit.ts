import {
  createPasswordResetRequestRateLimiter,
  type PasswordResetRequestRateLimiter,
} from "@/lib/password-reset-request-rate-limit";

/**
 * Rate limits of the anonymous public class registration
 * (POST /api/students/public/Register). Each accepted registration creates a
 * pending student and queues one welcome email, so these bound fake
 * registrations and welcome-email abuse.
 *
 * Reuses the password-reset request limiter (same sliding windows, hashing,
 * bounded memory and fail-closed behaviour), with its own budgets:
 *  - per identifier: the submitted email (normalized and kept only as its
 *    SHA-256), i.e. welcome emails one address can be sent;
 *  - per trusted client address (clientKey; skipped when TRUSTED_PROXY_COUNT
 *    is not configured);
 *  - global: every registration together.
 *
 * In memory, so PROCESS-LOCAL: production is one Node process (PM2 fork
 * behind nginx); a restart empties the budgets, and more than one process
 * would multiply the limits. No external store.
 */
export const PUBLIC_REGISTRATION_RATE_LIMIT = {
  requestsPerIdentifier: 3,
  requestsPerIp: 10,
  globalRequests: 200,
  windowMs: 60 * 60_000,
  maxKeys: 20_000,
} as const;

export function createPublicRegistrationRateLimiter(
  options: Parameters<typeof createPasswordResetRequestRateLimiter>[0] = {}
): PasswordResetRequestRateLimiter {
  return createPasswordResetRequestRateLimiter({ ...PUBLIC_REGISTRATION_RATE_LIMIT, ...options });
}

// One per process (production is a single Node process).
let processLimiter: PasswordResetRequestRateLimiter = createPublicRegistrationRateLimiter();

export function publicRegistrationRateLimiter(): PasswordResetRequestRateLimiter {
  return processLimiter;
}

/** Tests only: replace the process limiter (a fresh one by default). */
export function setPublicRegistrationRateLimiterForTests(
  limiter: PasswordResetRequestRateLimiter = createPublicRegistrationRateLimiter()
): void {
  processLimiter = limiter;
}
