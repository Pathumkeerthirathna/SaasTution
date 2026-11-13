import { createHash } from "node:crypto";

/**
 * Student Profile SP-7C: rate limits of POST /api/auth/password-reset/request.
 *
 * In memory, so PROCESS-LOCAL: production is one Node process (PM2 fork
 * behind nginx); every restart or deployment starts with empty budgets, and
 * more than one process would multiply the limits. No external store.
 *
 * Sliding windows (exact "in the last 15 minutes"). Every well-formed,
 * same-origin request counts, whatever the account (existing or not, any
 * role), so a refusal says nothing about any account. Three budgets, all
 * checked first and then recorded together, synchronously (no await in
 * between, so concurrent requests can never exceed a limit):
 *  - per identifier: the submitted email / registration number, normalized
 *    (trimmed, upper case) and kept only as its SHA-256 (64 hex characters);
 *    this bounds the reset emails one account can receive;
 *  - per client address: the trusted address from clientKey()
 *    (lib/error-logging/request-trust.ts: TRUSTED_PROXY_COUNT, right-most
 *    hops only; X-Forwarded-For / X-Real-IP are never trusted on their own).
 *    No trusted address (null): this budget is skipped;
 *  - global: every request together.
 *
 * Memory: each key keeps at most its limit of timestamps; expired keys are
 * removed by a bounded cursor sweep (a few keys per request, a batch per
 * minute from one unref'd timer). At most `maxKeys` keys per budget; live
 * entries are NEVER evicted: when a budget is full a bounded sweep drops
 * expired keys and, if that frees no room, the request is refused (429,
 * fail closed). Every live key has a live global entry, so live keys are at
 * most `globalRequests` (<= maxKeys, validated): a sweep of
 * `globalRequests + 1` keys always finds an expired one when the map is full.
 */

export const PASSWORD_RESET_REQUEST_RATE_LIMIT = {
  requestsPerIdentifier: 3,
  requestsPerIp: 20,
  globalRequests: 500,
  windowMs: 15 * 60_000,
  maxKeys: 20_000,
} as const;

export type PasswordResetRequestRateLimitOptions = Partial<{
  requestsPerIdentifier: number;
  requestsPerIp: number;
  globalRequests: number;
  windowMs: number;
  maxKeys: number;
  now: () => number;
}>;

export type PasswordResetRequestDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Keys examined per request (amortized cleanup) and per idle timer tick. */
const SWEEP_PER_REQUEST = 8;
const SWEEP_PER_TICK = 2_000;
const SWEEP_INTERVAL_MS = 60_000;

/** The fixed-length limiter key of a submitted identifier (SHA-256 of the trimmed, upper-case form, hex). */
export function passwordResetIdentifierKey(identifier: string): string {
  return createHash("sha256").update(identifier.trim().toUpperCase(), "utf8").digest("hex");
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

const NUMERIC_SETTINGS = ["requestsPerIdentifier", "requestsPerIp", "globalRequests", "windowMs", "maxKeys"] as const;

/** Throws on anything but positive integers in a consistent order (identifier <= ip <= global <= maxKeys). */
function assertValidConfig(config: Record<(typeof NUMERIC_SETTINGS)[number], number>): void {
  for (const key of NUMERIC_SETTINGS) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) {
      throw new Error(`Invalid password-reset request rate limit: ${key} must be a positive integer.`);
    }
  }
  const order: [string, number, string, number][] = [
    ["requestsPerIdentifier", config.requestsPerIdentifier, "requestsPerIp", config.requestsPerIp],
    ["requestsPerIp", config.requestsPerIp, "globalRequests", config.globalRequests],
    ["globalRequests", config.globalRequests, "maxKeys", config.maxKeys],
  ];
  for (const [smallName, small, largeName, large] of order) {
    if (small > large) {
      throw new Error(`Invalid password-reset request rate limit: ${smallName} (${small}) must not exceed ${largeName} (${large}).`);
    }
  }
}

export function createPasswordResetRequestRateLimiter(options: PasswordResetRequestRateLimitOptions = {}) {
  const config = { ...PASSWORD_RESET_REQUEST_RATE_LIMIT, ...options };
  assertValidConfig(config);
  const now = options.now ?? (() => Date.now());
  const capacitySweep = config.globalRequests + 1;
  const identifiers = new SlidingLog(config.requestsPerIdentifier, config.windowMs, config.maxKeys, capacitySweep);
  const addresses = new SlidingLog(config.requestsPerIp, config.windowMs, config.maxKeys, capacitySweep);
  const global = new SlidingLog(config.globalRequests, config.windowMs, 1, 1);
  const GLOBAL = "*";
  const fullWait = Math.ceil(config.windowMs / 1000);

  const sweepAll = (time: number, budget: number) => identifiers.sweep(time, budget) + addresses.sweep(time, budget);

  return {
    /**
     * Checks every budget and, when all allow it, records one request in
     * each (synchronously). `identifier` is the submitted value (normalized
     * and hashed here); `clientKey` is null when no trusted address is known.
     * Refused requests record nothing; Retry-After is the longest wait among
     * the refusing budgets.
     */
    attempt(identifier: string, clientKey: string | null): PasswordResetRequestDecision {
      const time = now();
      sweepAll(time, SWEEP_PER_REQUEST);
      const key = passwordResetIdentifierKey(identifier);

      const waits = [
        global.retryAfter(GLOBAL, time),
        clientKey === null ? null : addresses.retryAfter(clientKey, time),
        identifiers.retryAfter(key, time),
      ].filter((wait): wait is number => wait !== null);
      if (waits.length > 0) return { allowed: false, retryAfterSeconds: Math.max(...waits) };

      // A budget full of live keys refuses (it never evicts a live entry).
      const room = identifiers.hasRoom(key, time) && (clientKey === null || addresses.hasRoom(clientKey, time));
      if (!room) return { allowed: false, retryAfterSeconds: fullWait };

      global.record(GLOBAL, time);
      if (clientKey !== null) addresses.record(clientKey, time);
      identifiers.record(key, time);
      return { allowed: true };
    },

    /** Drops expired keys, examining at most `budget` keys per budget. Returns the keys examined. */
    sweep(budget: number = SWEEP_PER_TICK): number {
      return sweepAll(now(), budget);
    },

    /** For tests: tracked keys per budget. */
    trackedKeys(): { identifiers: number; addresses: number } {
      return { identifiers: identifiers.size(), addresses: addresses.size() };
    },

    /** For tests: the identifier keys held (hashes only) and the address keys. */
    keysForTests(): { identifiers: string[]; addresses: string[] } {
      return { identifiers: identifiers.keys(), addresses: addresses.keys() };
    },
  };
}

export type PasswordResetRequestRateLimiter = ReturnType<typeof createPasswordResetRequestRateLimiter>;

// One per process (production is a single Node process).
let processLimiter: PasswordResetRequestRateLimiter = createPasswordResetRequestRateLimiter();

export function passwordResetRequestRateLimiter(): PasswordResetRequestRateLimiter {
  return processLimiter;
}

/** Tests only: replace the process limiter (a fresh one by default). */
export function setPasswordResetRequestRateLimiterForTests(
  limiter: PasswordResetRequestRateLimiter = createPasswordResetRequestRateLimiter()
): void {
  processLimiter = limiter;
}

/*
 * Idle cleanup: ONE timer per process, kept on globalThis so a module reload
 * (development hot reload) replaces it instead of adding another. It sweeps
 * whichever limiter is current, a bounded batch per tick, and is unref'd so
 * it never keeps the process alive.
 */
const sweeperHolder = globalThis as typeof globalThis & { __passwordResetRequestLimiterSweeper?: ReturnType<typeof setInterval> };
if (sweeperHolder.__passwordResetRequestLimiterSweeper) clearInterval(sweeperHolder.__passwordResetRequestLimiterSweeper);
sweeperHolder.__passwordResetRequestLimiterSweeper = setInterval(() => {
  processLimiter.sweep(SWEEP_PER_TICK);
}, SWEEP_INTERVAL_MS);
sweeperHolder.__passwordResetRequestLimiterSweeper.unref?.();
