/*
 * Fixed-window rate limiter for the client-error endpoint (in memory: the app
 * runs as one Node process). A per-key limit (client IP) plus a global limit,
 * so spoofed X-Forwarded-For values cannot flood the log either.
 */

export type RateLimiterOptions = {
  perKey: number;
  global: number;
  windowMs: number;
  /** Keys tracked at most; the oldest windows are dropped beyond it. */
  maxKeys?: number;
  now?: () => number;
};

export function createRateLimiter(options: RateLimiterOptions) {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, { start: number; count: number }>();
  let globalWindow = { start: 0, count: 0 };

  return {
    /**
     * True when this request is within the limits (and counts it). A null key
     * (no trustworthy client identity) is held to the global limit only, so
     * genuine users are never pooled under one small per-client limit.
     */
    allow(key: string | null): boolean {
      const time = now();

      if (time - globalWindow.start >= options.windowMs) {
        globalWindow = { start: time, count: 0 };
      }

      if (globalWindow.count >= options.global) {
        return false;
      }

      if (key === null) {
        globalWindow.count += 1;
        return true;
      }

      let window = windows.get(key);

      if (!window || time - window.start >= options.windowMs) {
        if (!window && windows.size >= maxKeys) {
          // Full: forget the oldest half (Map keeps insertion order). Those
          // keys simply start a new window if they come back.
          for (const entryKey of windows.keys()) {
            windows.delete(entryKey);

            if (windows.size < maxKeys / 2) break;
          }
        }

        window = { start: time, count: 0 };
        windows.set(key, window);
      }

      if (window.count >= options.perKey) {
        return false;
      }

      window.count += 1;
      globalWindow.count += 1;

      return true;
    },
  };
}
