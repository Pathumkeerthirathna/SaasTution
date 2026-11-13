import { createHash } from "node:crypto";

import { AppError } from "@/lib/error-handler";
import { REGISTRATION_NUMBER_MAX_LENGTH } from "@/lib/student-validation";

/**
 * Student Profile SP-6D / SP-6F: rate limits of the STUDENT login (loginStudent
 * in services/auth-service.ts; teacher, guardian and admin logins never come
 * here). In memory, process-local: production is a single Node process (one
 * PM2 fork); counts are not shared between processes or replicas and reset on
 * a restart. A shared store (e.g. Redis or a database table) would be needed
 * before running more than one process.
 *
 * Sliding windows (exact "in the last 15 minutes"):
 *  - ATTEMPTS per registration number: 10 (every attempt, successful or not).
 *  - FAILURES per registration number: 5.
 *  - FAILURES per trusted client address (lib/error-logging/request-trust.ts
 *    clientKey; skipped when no trusted address is known): 100.
 *  - FAILURES globally: 1,000.
 * A failure is an invalid credential only (unknown number, no password, wrong
 * password, the registration number as password, an over-long number) —
 * never a device, email, approval or deactivation answer.
 *
 * Exact counting, atomic within the process: `begin()` checks every budget
 * and, if all allow it, synchronously records the attempt AND a provisional
 * failure in each failure budget, before any await, so requests in flight
 * hold their slots and concurrent requests can never exceed a limit. The
 * ticket settles once: fail() keeps the provisional failures; succeed()
 * removes them from the address / global budgets and clears the number's
 * failures; release() (an unexpected error) removes them. Refused requests
 * record nothing.
 *
 * Memory (SP-6F):
 *  - Registration numbers are never stored: each is keyed by the SHA-256 of
 *    its normalized form (64 hex characters, whatever the input length).
 *    Callers refuse numbers longer than MAX_LOGIN_REGISTRATION_NUMBER_LENGTH
 *    before creating any per-number key (`failWithoutRegistration`).
 *  - Expired keys are removed by a bounded, cursor-based sweep: a few keys on
 *    every request, and a batch every minute from one unref'd timer while the
 *    process is idle. No request scans a whole map.
 *  - At most `maxKeys` keys per budget. Live entries are NEVER evicted: when a
 *    budget is full, a bounded sweep drops expired keys; if that frees no
 *    room the request is refused (429), it is not let through. Live failure
 *    keys are at most `globalFailures` (every one has a live global entry), so
 *    the sweep of `globalFailures + 1` keys always frees room for them.
 */

export const STUDENT_LOGIN_RATE_LIMIT = {
  attemptsPerRegistration: 10,
  failuresPerRegistration: 5,
  failuresPerIp: 100,
  globalFailures: 1_000,
  windowMs: 15 * 60_000,
  maxKeys: 50_000,
} as const;

/**
 * Longest registration number the student login accepts (normalized). Longer
 * input is an invalid credential. The same limit as student creation, editing
 * and import (SP-6G): one source of truth in lib/student-validation.ts.
 */
export const MAX_LOGIN_REGISTRATION_NUMBER_LENGTH = REGISTRATION_NUMBER_MAX_LENGTH;

/** Keys examined per request (amortized cleanup) and per idle timer tick. */
const SWEEP_PER_REQUEST = 8;
const SWEEP_PER_TICK = 2_000;
const SWEEP_INTERVAL_MS = 60_000;

export type StudentLoginRateLimitOptions = Partial<{
  attemptsPerRegistration: number;
  failuresPerRegistration: number;
  failuresPerIp: number;
  globalFailures: number;
  windowMs: number;
  maxKeys: number;
  now: () => number;
}>;

export const LOGIN_RATE_LIMITED_MESSAGE = "Too many login attempts. Please wait before trying again.";

/** 429 LOGIN_RATE_LIMITED; the login route adds Retry-After from `retryAfterSeconds`. */
export class LoginRateLimitedError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super(LOGIN_RATE_LIMITED_MESSAGE, 429, "LOGIN_RATE_LIMITED");
  }
}

/** The normalized registration number for every counter: trimmed, upper case. */
export function normalizeLoginRegistrationNumber(value: string): string {
  return value.trim().toUpperCase();
}

/** The fixed-length limiter key of a registration number (SHA-256 of the normalized form, hex). */
export function registrationLimitKey(registrationNumber: string): string {
  return createHash("sha256").update(normalizeLoginRegistrationNumber(registrationNumber), "utf8").digest("hex");
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

  /** Removes one entry recorded at `time` (if it is still there). */
  remove(key: string, time: number): void {
    const log = this.logs.get(key);
    if (!log) return;
    const index = log.indexOf(time);
    if (index === -1) return;
    log.splice(index, 1);
    if (log.length === 0) this.logs.delete(key);
  }

  clear(key: string): void {
    this.logs.delete(key);
  }

  /**
   * Examines at most `budget` keys, continuing from where the last sweep
   * stopped (wrapping around), and drops the expired ones. Returns how many
   * keys were examined.
   */
  sweep(time: number, budget: number): number {
    let examined = 0;
    let restarted = false;
    while (examined < budget && this.logs.size > 0) {
      if (!this.cursor) this.cursor = this.logs.keys();
      const next = this.cursor.next();
      if (next.done) {
        this.cursor = null;
        if (restarted) break; // a full pass already happened in this call
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

const NUMERIC_SETTINGS = ["attemptsPerRegistration", "failuresPerRegistration", "failuresPerIp", "globalFailures", "windowMs", "maxKeys"] as const;

function assertValidConfig(config: Record<(typeof NUMERIC_SETTINGS)[number], number>): void {
  for (const key of NUMERIC_SETTINGS) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) {
      throw new Error(`Invalid student login rate limit: ${key} must be a positive integer.`);
    }
  }
  const order: [string, number, string, number][] = [
    ["failuresPerRegistration", config.failuresPerRegistration, "attemptsPerRegistration", config.attemptsPerRegistration],
    ["failuresPerRegistration", config.failuresPerRegistration, "failuresPerIp", config.failuresPerIp],
    ["failuresPerIp", config.failuresPerIp, "globalFailures", config.globalFailures],
    ["globalFailures", config.globalFailures, "maxKeys", config.maxKeys],
  ];
  for (const [smallName, small, largeName, large] of order) {
    if (small > large) {
      throw new Error(`Invalid student login rate limit: ${smallName} (${small}) must not exceed ${largeName} (${large}).`);
    }
  }
}

export type StudentLoginTicket = { fail(): void; succeed(): void; release(): void };

export type StudentLoginGate = { allowed: true; ticket: StudentLoginTicket } | { allowed: false; retryAfterSeconds: number };

export function createStudentLoginRateLimiter(options: StudentLoginRateLimitOptions = {}) {
  const config = { ...STUDENT_LOGIN_RATE_LIMIT, ...options };
  assertValidConfig(config);
  const now = options.now ?? (() => Date.now());
  const capacitySweep = config.globalFailures + 1;
  const attempts = new SlidingLog(config.attemptsPerRegistration, config.windowMs, config.maxKeys, capacitySweep);
  const registrationFailures = new SlidingLog(config.failuresPerRegistration, config.windowMs, config.maxKeys, capacitySweep);
  const ipFailures = new SlidingLog(config.failuresPerIp, config.windowMs, config.maxKeys, capacitySweep);
  const globalFailures = new SlidingLog(config.globalFailures, config.windowMs, 1, 1);
  const GLOBAL = "*";
  const fullWait = Math.ceil(config.windowMs / 1000);

  const sweepAll = (time: number, budget: number) =>
    attempts.sweep(time, budget) + registrationFailures.sweep(time, budget) + ipFailures.sweep(time, budget);

  /** The longest wait among the address / global budgets, or null when both allow. */
  const sharedWait = (clientKey: string | null, time: number): number | null => {
    const waits = [globalFailures.retryAfter(GLOBAL, time), clientKey === null ? null : ipFailures.retryAfter(clientKey, time)].filter(
      (wait): wait is number => wait !== null
    );
    return waits.length > 0 ? Math.max(...waits) : null;
  };

  return {
    /**
     * Checks every budget and, when all allow it, records the attempt and the
     * provisional failures (synchronously). `registration` is the number as
     * typed (it is normalized and hashed here); `clientKey` is null when no
     * trusted address is known.
     */
    begin(registration: string, clientKey: string | null): StudentLoginGate {
      const time = now();
      sweepAll(time, SWEEP_PER_REQUEST);
      const key = registrationLimitKey(registration);

      const waits = [
        sharedWait(clientKey, time),
        registrationFailures.retryAfter(key, time),
        attempts.retryAfter(key, time),
      ].filter((wait): wait is number => wait !== null);
      if (waits.length > 0) return { allowed: false, retryAfterSeconds: Math.max(...waits) };

      // A budget full of live keys refuses (it never evicts a live entry).
      const room =
        attempts.hasRoom(key, time) && registrationFailures.hasRoom(key, time) && (clientKey === null || ipFailures.hasRoom(clientKey, time));
      if (!room) return { allowed: false, retryAfterSeconds: fullWait };

      attempts.record(key, time);
      globalFailures.record(GLOBAL, time);
      if (clientKey !== null) ipFailures.record(clientKey, time);
      registrationFailures.record(key, time);

      let settled = false;
      const removeProvisional = () => {
        globalFailures.remove(GLOBAL, time);
        if (clientKey !== null) ipFailures.remove(clientKey, time);
      };
      return {
        allowed: true,
        ticket: {
          fail() {
            settled = true;
          },
          succeed() {
            if (settled) return;
            settled = true;
            removeProvisional();
            registrationFailures.clear(key);
          },
          release() {
            if (settled) return;
            settled = true;
            removeProvisional();
            registrationFailures.remove(key, time);
          },
        },
      };
    },

    /**
     * An invalid credential that has no per-number key (an over-long number):
     * checks the address and global budgets and, when they allow it, records
     * one failure in each. Never creates a registration-number key.
     */
    failWithoutRegistration(clientKey: string | null): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
      const time = now();
      sweepAll(time, SWEEP_PER_REQUEST);
      const wait = sharedWait(clientKey, time);
      if (wait !== null) return { allowed: false, retryAfterSeconds: wait };
      if (clientKey !== null && !ipFailures.hasRoom(clientKey, time)) return { allowed: false, retryAfterSeconds: fullWait };
      globalFailures.record(GLOBAL, time);
      if (clientKey !== null) ipFailures.record(clientKey, time);
      return { allowed: true };
    },

    /**
     * Clears a registration number's failure counter, exactly as a successful
     * login's `succeed()` does (SP-7B: after a committed password reset). The
     * attempt budget and the address / global budgets are not touched, and no
     * key is created.
     */
    clearRegistrationFailures(registration: string): void {
      registrationFailures.clear(registrationLimitKey(registration));
    },

    /** Drops expired keys, examining at most `budget` keys per budget. Returns the keys examined. */
    sweep(budget: number = SWEEP_PER_TICK): number {
      return sweepAll(now(), budget);
    },

    /** For tests: tracked keys per budget. */
    trackedKeys(): { attempts: number; registrationFailures: number; ipFailures: number } {
      return { attempts: attempts.size(), registrationFailures: registrationFailures.size(), ipFailures: ipFailures.size() };
    },

    /** For tests: the per-number keys held (hashes only). */
    registrationKeysForTests(): { attempts: string[]; registrationFailures: string[] } {
      return { attempts: attempts.keys(), registrationFailures: registrationFailures.keys() };
    },
  };
}

export type StudentLoginRateLimiter = ReturnType<typeof createStudentLoginRateLimiter>;

// One per process (production is a single Node process).
let processLimiter: StudentLoginRateLimiter = createStudentLoginRateLimiter();

export function studentLoginRateLimiter(): StudentLoginRateLimiter {
  return processLimiter;
}

/** Tests only: replace the process limiter (a fresh one by default). */
export function setStudentLoginRateLimiterForTests(limiter: StudentLoginRateLimiter = createStudentLoginRateLimiter()): void {
  processLimiter = limiter;
}

/*
 * Idle cleanup: ONE timer per process, kept on globalThis so a module reload
 * (development hot reload) replaces it instead of adding another. It sweeps
 * whichever limiter is current, a bounded batch per tick, and is unref'd so
 * it never keeps the process alive.
 */
const sweeperHolder = globalThis as typeof globalThis & { __studentLoginLimiterSweeper?: ReturnType<typeof setInterval> };
if (sweeperHolder.__studentLoginLimiterSweeper) clearInterval(sweeperHolder.__studentLoginLimiterSweeper);
sweeperHolder.__studentLoginLimiterSweeper = setInterval(() => {
  processLimiter.sweep(SWEEP_PER_TICK);
}, SWEEP_INTERVAL_MS);
sweeperHolder.__studentLoginLimiterSweeper.unref?.();
