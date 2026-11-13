/**
 * Student Profile SP-5.6: rate limits of the student password change
 * (POST /api/auth/password/update, STUDENT branch). In memory (production is
 * one Node process); sliding windows (exact "in the last 15 minutes"), keyed
 * by the student id from the verified session. The shared fixed-window
 * limiter (lib/error-logging/rate-limit.ts) is not used: it cannot check
 * without counting.
 *
 * Three budgets, each with a separate check and record:
 *  - ATTEMPTS: 10 authenticated, same-origin requests per student (valid or
 *    not), plus a global safety cap of 600 for all students together.
 *  - FAILURES: 5 wrong current passwords per student. Never cleared by a
 *    successful change.
 *
 * Exact counting (lib/student-password-change-http.ts):
 *  1. checkAttempt(id)  — refused: 429, NOT recorded (a refused request is no attempt).
 *  2. recordAttempt(id) — exactly once per request that passed step 1.
 *  3. checkFailure(id)  — refused: 429 (the request already counted as an attempt).
 *  4. recordFailure(id) — exactly once, only when bcrypt says the current password is wrong.
 *
 * Memory is bounded: at most `maxStudents` tracked ids per budget (when full,
 * expired entries are dropped first, then the oldest-inserted ids), each id
 * keeps at most its limit of timestamps, and the global log at most its cap.
 *
 * Live entries are never evicted: an attempt is recorded only after the
 * global check allowed it, and per-student entries share the global entry's
 * timestamp, so at most `globalAttempts` students have live attempts (and
 * failures, which follow attempts). The configuration must therefore keep
 * `globalAttempts <= maxStudents` (SP-5.6D); anything else is refused at
 * creation, because evicting a live entry would reset that student's limits.
 */

export const STUDENT_PASSWORD_CHANGE_RATE_LIMIT = {
  attemptsPerStudent: 10,
  failuresPerStudent: 5,
  globalAttempts: 600,
  windowMs: 15 * 60_000,
  maxStudents: 10_000,
} as const;

export type StudentPasswordChangeRateLimitOptions = Partial<{
  attemptsPerStudent: number;
  failuresPerStudent: number;
  globalAttempts: number;
  windowMs: number;
  maxStudents: number;
  now: () => number;
}>;

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

class SlidingLog {
  private readonly logs = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys: number
  ) {}

  private live(key: string, time: number): number[] {
    const log = this.logs.get(key);
    if (!log) return [];
    const kept = log.filter((at) => time - at < this.windowMs);
    if (kept.length === 0) this.logs.delete(key);
    else if (kept.length !== log.length) this.logs.set(key, kept);
    return kept;
  }

  check(key: string, time: number): RateDecision {
    const log = this.live(key, time);
    if (log.length < this.limit) return { allowed: true };
    const oldest = log[log.length - this.limit];
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - time) / 1000)) };
  }

  record(key: string, time: number): void {
    const log = this.live(key, time);
    if (log.length === 0 && !this.logs.has(key)) this.makeRoom(time);
    log.push(time);
    this.logs.set(key, log.length > this.limit ? log.slice(-this.limit) : log);
  }

  private makeRoom(time: number): void {
    if (this.logs.size < this.maxKeys) return;
    for (const key of [...this.logs.keys()]) this.live(key, time); // drop expired first
    for (const key of this.logs.keys()) {
      if (this.logs.size < this.maxKeys) break;
      this.logs.delete(key); // then the oldest-inserted ids
    }
  }

  size(): number {
    return this.logs.size;
  }
}

const NUMERIC_SETTINGS = ["attemptsPerStudent", "failuresPerStudent", "globalAttempts", "windowMs", "maxStudents"] as const;

/** Throws on a configuration that could evict live entries (or is not a set of positive integers). */
function assertValidConfig(config: Record<(typeof NUMERIC_SETTINGS)[number], number>): void {
  for (const key of NUMERIC_SETTINGS) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) {
      throw new Error(`Invalid student password-change rate limit: ${key} must be a positive integer.`);
    }
  }
  if (config.globalAttempts > config.maxStudents) {
    throw new Error(
      `Invalid student password-change rate limit: globalAttempts (${config.globalAttempts}) must not exceed maxStudents (${config.maxStudents}), or live entries could be evicted.`
    );
  }
}

export function createStudentPasswordChangeRateLimiter(options: StudentPasswordChangeRateLimitOptions = {}) {
  const config = { ...STUDENT_PASSWORD_CHANGE_RATE_LIMIT, ...options };
  assertValidConfig(config);
  const now = options.now ?? (() => Date.now());
  const attempts = new SlidingLog(config.attemptsPerStudent, config.windowMs, config.maxStudents);
  const failures = new SlidingLog(config.failuresPerStudent, config.windowMs, config.maxStudents);
  const global = new SlidingLog(config.globalAttempts, config.windowMs, 1);
  const GLOBAL = "*";

  return {
    /** Total-attempt budget (per student and global). Does not count. */
    checkAttempt(studentId: string): RateDecision {
      const time = now();
      const all = global.check(GLOBAL, time);
      if (!all.allowed) return all;
      return attempts.check(studentId, time);
    },
    /** Counts one attempt (per student and global). Call once, after checkAttempt allowed it. */
    recordAttempt(studentId: string): void {
      const time = now();
      global.record(GLOBAL, time);
      attempts.record(studentId, time);
    },
    /** Wrong-password budget. Does not count. */
    checkFailure(studentId: string): RateDecision {
      return failures.check(studentId, now());
    },
    /** Counts one wrong current password. */
    recordFailure(studentId: string): void {
      failures.record(studentId, now());
    },
    /** For tests: tracked ids per budget. */
    trackedStudents(): { attempts: number; failures: number } {
      return { attempts: attempts.size(), failures: failures.size() };
    },
  };
}

export type StudentPasswordChangeRateLimiter = ReturnType<typeof createStudentPasswordChangeRateLimiter>;
