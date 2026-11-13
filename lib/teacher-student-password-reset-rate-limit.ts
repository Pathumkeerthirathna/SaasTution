import { createHash } from "node:crypto";

/**
 * Student Profile SP-7D: rate limits of the teacher-initiated student
 * password reset (POST /api/students/[id]/resetpassword).
 *
 * In memory, so PROCESS-LOCAL: production is one Node process (PM2 fork
 * behind nginx); every restart or deployment starts with empty budgets, and
 * more than one process would multiply the limits. No external store.
 *
 * Sliding windows (exact "in the last 15 minutes"). Every authenticated,
 * same-origin, well-formed request counts (before the student is looked up,
 * whatever the outcome). Three budgets, all checked first and then recorded
 * together, synchronously:
 *  - per teacher: keyed by the SHA-256 of the teacher id from the verified
 *    session (never from the request; the raw id is not stored);
 *  - per client address: the trusted address from clientKey()
 *    (lib/error-logging/request-trust.ts: TRUSTED_PROXY_COUNT, right-most
 *    hops only). No trusted address (null): this budget is skipped;
 *  - global: every request together.
 * They bound the bcrypt work and the "password changed" emails one teacher
 * (or address) can cause.
 *
 * Memory: each key keeps at most its limit of timestamps; expired keys are
 * removed by a bounded cursor sweep (a few keys per request, a batch per
 * minute from one unref'd timer). At most `maxKeys` keys per budget; live
 * entries are NEVER evicted: when a budget is full a bounded sweep drops
 * expired keys and, if that frees no room, the request is refused (429, fail
 * closed). Every live key has a live global entry, so live keys are at most
 * `globalRequests` (<= maxKeys, validated): a sweep of `globalRequests + 1`
 * keys always finds an expired one when the map is full.
 */

export const TEACHER_STUDENT_PASSWORD_RESET_RATE_LIMIT = {
  requestsPerTeacher: 20,
  requestsPerIp: 40,
  globalRequests: 300,
  windowMs: 15 * 60_000,
  maxKeys: 10_000,
} as const;

export type TeacherStudentPasswordResetRateLimitOptions = Partial<{
  requestsPerTeacher: number;
  requestsPerIp: number;
  globalRequests: number;
  windowMs: number;
  maxKeys: number;
  now: () => number;
}>;

export type TeacherStudentPasswordResetDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Keys examined per request (amortized cleanup) and per idle timer tick. */
const SWEEP_PER_REQUEST = 8;
const SWEEP_PER_TICK = 2_000;
const SWEEP_INTERVAL_MS = 60_000;

/** The fixed-length limiter key of a teacher (SHA-256 of the session's teacher id, hex): ids are never stored. */
export function teacherResetLimitKey(teacherId: string): string {
  return createHash("sha256").update(teacherId, "utf8").digest("hex");
}

class SlidingLog {
  private readonly logs = new Map<string, number[]>();
  private cursor: Iterator<string> | null = null;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys: number,
    private readonly capacitySweep: number
  ) {}

  private live(key: string, time: number): number[] {
    const log = this.logs.get(key);
    if (!log) return [];
    const kept = log.filter((at) => time - at < this.windowMs);
    if (kept.length === 0) this.logs.delete(key);
    else if (kept.length !== log.length) this.logs.set(key, kept);
    return kept;
  }

  /** null when allowed, otherwise the seconds until a slot frees. */
  retryAfter(key: string, time: number): number | null {
    const log = this.live(key, time);
    if (log.length < this.limit) return null;
    const oldest = log[log.length - this.limit];
    return Math.max(1, Math.ceil((oldest + this.windowMs - time) / 1000));
  }

  /** True when `key` can be recorded: it exists, or there is (or a bounded sweep makes) room. Never evicts live keys. */
  hasRoom(key: string, time: number): boolean {
    if (this.logs.has(key) || this.logs.size < this.maxKeys) return true;
    this.sweep(time, this.capacitySweep);
    return this.logs.size < this.maxKeys;
  }

  /** Record after `hasRoom` said yes. */
  record(key: string, time: number): void {
    const log = this.live(key, time);
    log.push(time);
    this.logs.set(key, log.length > this.limit ? log.slice(-this.limit) : log);
  }

  /**
   * Examines at most `budget` keys, continuing from where the last sweep
   * stopped (wrapping around once), and drops the expired ones. Returns how
   * many keys were examined.
   */
  sweep(time: number, budget: number): number {
    let examined = 0;
    let restarted = false;
    while (examined < budget && this.logs.size > 0) {
      if (!this.cursor) this.cursor = this.logs.keys();
      const next = this.cursor.next();
      if (next.done) {
        this.cursor = null;
        if (restarted) break;
        restarted = true;
        continue;
      }
      examined += 1;
      this.live(next.value, time);
    }
    return examined;
  }

  size(): number {
    return this.logs.size;
  }

  keys(): string[] {
    return [...this.logs.keys()];
  }
}

const NUMERIC_SETTINGS = ["requestsPerTeacher", "requestsPerIp", "globalRequests", "windowMs", "maxKeys"] as const;

/** Throws on anything but positive integers in a consistent order (teacher <= ip <= global <= maxKeys). */
function assertValidConfig(config: Record<(typeof NUMERIC_SETTINGS)[number], number>): void {
  for (const key of NUMERIC_SETTINGS) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) {
      throw new Error(`Invalid teacher password-reset rate limit: ${key} must be a positive integer.`);
    }
  }
  const order: [string, number, string, number][] = [
    ["requestsPerTeacher", config.requestsPerTeacher, "requestsPerIp", config.requestsPerIp],
    ["requestsPerIp", config.requestsPerIp, "globalRequests", config.globalRequests],
    ["globalRequests", config.globalRequests, "maxKeys", config.maxKeys],
  ];
  for (const [smallName, small, largeName, large] of order) {
    if (small > large) {
      throw new Error(`Invalid teacher password-reset rate limit: ${smallName} (${small}) must not exceed ${largeName} (${large}).`);
    }
  }
}

export function createTeacherStudentPasswordResetRateLimiter(options: TeacherStudentPasswordResetRateLimitOptions = {}) {
  const config = { ...TEACHER_STUDENT_PASSWORD_RESET_RATE_LIMIT, ...options };
  assertValidConfig(config);
  const now = options.now ?? (() => Date.now());
  const capacitySweep = config.globalRequests + 1;
  const teachers = new SlidingLog(config.requestsPerTeacher, config.windowMs, config.maxKeys, capacitySweep);
  const addresses = new SlidingLog(config.requestsPerIp, config.windowMs, config.maxKeys, capacitySweep);
  const global = new SlidingLog(config.globalRequests, config.windowMs, 1, 1);
  const GLOBAL = "*";
  const fullWait = Math.ceil(config.windowMs / 1000);

  const sweepAll = (time: number, budget: number) => teachers.sweep(time, budget) + addresses.sweep(time, budget);

  return {
    /**
     * Checks every budget and, when all allow it, records one request in
     * each (synchronously). `teacherId` comes from the verified session (it
     * is hashed here); `clientKey` is null when no trusted address is known.
     * Refused requests record nothing; Retry-After is the longest wait among
     * the refusing budgets.
     */
    attempt(teacherId: string, clientKey: string | null): TeacherStudentPasswordResetDecision {
      const time = now();
      sweepAll(time, SWEEP_PER_REQUEST);
      const key = teacherResetLimitKey(teacherId);

      const waits = [
        global.retryAfter(GLOBAL, time),
        clientKey === null ? null : addresses.retryAfter(clientKey, time),
        teachers.retryAfter(key, time),
      ].filter((wait): wait is number => wait !== null);
      if (waits.length > 0) return { allowed: false, retryAfterSeconds: Math.max(...waits) };

      // A budget full of live keys refuses (it never evicts a live entry).
      const room = teachers.hasRoom(key, time) && (clientKey === null || addresses.hasRoom(clientKey, time));
      if (!room) return { allowed: false, retryAfterSeconds: fullWait };

      global.record(GLOBAL, time);
      if (clientKey !== null) addresses.record(clientKey, time);
      teachers.record(key, time);
      return { allowed: true };
    },

    /** Drops expired keys, examining at most `budget` keys per budget. Returns the keys examined. */
    sweep(budget: number = SWEEP_PER_TICK): number {
      return sweepAll(now(), budget);
    },

    /** For tests: tracked keys per budget. */
    trackedKeys(): { teachers: number; addresses: number } {
      return { teachers: teachers.size(), addresses: addresses.size() };
    },

    /** For tests: the teacher keys held (hashes only) and the address keys. */
    keysForTests(): { teachers: string[]; addresses: string[] } {
      return { teachers: teachers.keys(), addresses: addresses.keys() };
    },
  };
}

export type TeacherStudentPasswordResetRateLimiter = ReturnType<typeof createTeacherStudentPasswordResetRateLimiter>;

// One per process (production is a single Node process).
let processLimiter: TeacherStudentPasswordResetRateLimiter = createTeacherStudentPasswordResetRateLimiter();

export function teacherStudentPasswordResetRateLimiter(): TeacherStudentPasswordResetRateLimiter {
  return processLimiter;
}

/** Tests only: replace the process limiter (a fresh one by default). */
export function setTeacherStudentPasswordResetRateLimiterForTests(
  limiter: TeacherStudentPasswordResetRateLimiter = createTeacherStudentPasswordResetRateLimiter()
): void {
  processLimiter = limiter;
}

/*
 * Idle cleanup: ONE timer per process, kept on globalThis so a module reload
 * (development hot reload) replaces it instead of adding another. It sweeps
 * whichever limiter is current, a bounded batch per tick, and is unref'd so
 * it never keeps the process alive.
 */
const sweeperHolder = globalThis as typeof globalThis & { __teacherStudentPasswordResetLimiterSweeper?: ReturnType<typeof setInterval> };
if (sweeperHolder.__teacherStudentPasswordResetLimiterSweeper) clearInterval(sweeperHolder.__teacherStudentPasswordResetLimiterSweeper);
sweeperHolder.__teacherStudentPasswordResetLimiterSweeper = setInterval(() => {
  processLimiter.sweep(SWEEP_PER_TICK);
}, SWEEP_INTERVAL_MS);
sweeperHolder.__teacherStudentPasswordResetLimiterSweeper.unref?.();
