/**
 * Unified lecture attendance, Stages 5.7b-3b / 5.7b-3c-1: the rate limit of
 * POST /api/lectures/[id]/attendance/qr/scans. In memory (production is one
 * Node process), two instances of the shared fixed-window limiter
 * (lib/error-logging/rate-limit.ts), both keyed by the session's teacher id.
 *
 * Two separate budgets:
 *  - NEW: a (teacher, clientScanId) pair not seen recently: 120 per teacher
 *    and 2,000 for the whole server per 60 s. Allowed pairs are remembered.
 *  - REPLAY: a pair seen recently (a scanner's same-id retry after a timeout,
 *    a 409 ATTENDANCE_BUSY or a lost response): 600 per teacher per 60 s,
 *    never counted against the NEW budgets. A replay is only a throttling
 *    category: "seen" means this limiter let the id through before, NOT that
 *    a scan was recorded (the service may have refused it). The service
 *    stays the authority: it answers the stored outcome (`replayed`), 409
 *    ATTENDANCE_SCAN_ID_REUSED for a different scan under the id, or records
 *    the scan if nothing was stored.
 *
 * Memory is bounded: at most 20,000 remembered pairs (when full, the oldest
 * half is dropped; a forgotten id is simply NEW again), and each limiter
 * tracks at most its default 10,000 teacher windows. Only the client-chosen
 * scan id and the teacher id are kept, never the QR payload.
 *
 * Refused (either budget): 429 ATTENDANCE_SCAN_RATE_LIMITED with Retry-After
 * (seconds: the window length, an upper bound). Nothing is recorded for a
 * refused request, and a refused NEW id is not remembered.
 */

import { createRateLimiter } from "@/lib/error-logging/rate-limit";

export const QR_SCAN_RATE_LIMIT = {
  /** Distinct (new) scans per teacher per window (one every 0.5 s on average). */
  perTeacher: 120,
  /** Distinct (new) scans per window for the whole server. */
  global: 2_000,
  /** Repeated submissions of remembered scan ids per teacher per window (Stage 5.7b-3c-1). */
  perTeacherReplays: 600,
  windowMs: 60_000,
  /** Recent (teacher, clientScanId) pairs remembered. */
  maxRememberedScanIds: 20_000,
} as const;

export type QrScanRateLimiterOptions = {
  perTeacher?: number;
  global?: number;
  perTeacherReplays?: number;
  windowMs?: number;
  maxRememberedScanIds?: number;
  now?: () => number;
};

export type QrScanRateKind = "NEW" | "REPLAY";

export type QrScanRateDecision =
  | { allowed: true; kind: QrScanRateKind }
  | { allowed: false; kind: QrScanRateKind; retryAfterSeconds: number };

export function createQrScanRateLimiter(options: QrScanRateLimiterOptions = {}) {
  const windowMs = options.windowMs ?? QR_SCAN_RATE_LIMIT.windowMs;
  const maxRemembered = options.maxRememberedScanIds ?? QR_SCAN_RATE_LIMIT.maxRememberedScanIds;
  const newScans = createRateLimiter({
    perKey: options.perTeacher ?? QR_SCAN_RATE_LIMIT.perTeacher,
    global: options.global ?? QR_SCAN_RATE_LIMIT.global,
    windowMs,
    now: options.now,
  });
  // Replays have a per-teacher budget only (no server-wide replay limit was
  // set); the global value just makes the shared limiter's global check inert.
  const replays = createRateLimiter({
    perKey: options.perTeacherReplays ?? QR_SCAN_RATE_LIMIT.perTeacherReplays,
    global: Number.POSITIVE_INFINITY,
    windowMs,
    now: options.now,
  });
  const seen = new Set<string>();
  const retryAfterSeconds = Math.max(1, Math.ceil(windowMs / 1000));

  return {
    /**
     * A remembered pair is a REPLAY (replay budget only); any other is NEW
     * (new-scan budgets; remembered when allowed).
     */
    check(teacherId: string, clientScanId: string): QrScanRateDecision {
      const key = JSON.stringify([teacherId, clientScanId]);
      if (seen.has(key)) {
        return replays.allow(teacherId) ? { allowed: true, kind: "REPLAY" } : { allowed: false, kind: "REPLAY", retryAfterSeconds };
      }
      if (!newScans.allow(teacherId)) return { allowed: false, kind: "NEW", retryAfterSeconds };
      if (seen.size >= maxRemembered) {
        for (const old of seen) {
          seen.delete(old);
          if (seen.size < maxRemembered / 2) break;
        }
      }
      seen.add(key);
      return { allowed: true, kind: "NEW" };
    },
    /** How many pairs are remembered (tests: memory stays bounded). */
    rememberedCount(): number {
      return seen.size;
    },
  };
}

/** The route's limiter (one per process). */
export const qrScanRateLimiter = createQrScanRateLimiter();
