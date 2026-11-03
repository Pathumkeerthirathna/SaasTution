/*
 * Who may send browser error reports, and who they are for rate limiting
 * (app/api/client-errors/route.ts). Server only.
 *
 * Origin. Browsers send Origin on every POST, same-origin ones included
 * (sendBeacon and fetch, which is how client-reporter.ts sends), and a page
 * cannot forge it. So a report must carry an Origin that is:
 *   - a configured application URL (NEXT_PUBLIC_APP_URL, APP_URL), compared
 *     as a whole origin (scheme, host, port): the public site, also when a
 *     reverse proxy rewrites Host; or
 *   - the Host the request arrived with (the browser sets it: same origin
 *     when the app is reached directly, or the proxy forwards the host); or
 *   - X-Forwarded-Host, only when TRUSTED_PROXY_COUNT says a proxy we
 *     control sits in front (otherwise anyone could send that header).
 * No Origin (scripts, curl) or an opaque / malformed one: 403. The reporter
 * posts to its own origin, so Sec-Fetch-Site, when sent, must be
 * "same-origin" (older browsers do not send it; Origin still applies).
 *
 * These headers stop other websites and header-less scripts. A non-browser
 * client can still copy them, so they are not authentication: floods from
 * such a client are held by the rate limits below (per client only behind a
 * trusted proxy).
 *
 * Client identity. X-Forwarded-For is a list the client can start itself;
 * each proxy appends the address it received the request from. With
 * TRUSTED_PROXY_COUNT = n, the client is the n-th entry from the end (the
 * address our outermost proxy saw). With no trusted proxy there is no
 * reliable identity: null, and only the global limit applies. X-Real-IP and
 * the other client-settable address headers are never used.
 */

export type TrustEnv = Record<string, string | undefined>;

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);

    return url.protocol === "http:" || url.protocol === "https:" ? url.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

function headerHost(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim().toLowerCase();

  return first && /^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(first) ? first : null;
}

export function trustedProxyCount(env: TrustEnv = process.env): number {
  const parsed = Number.parseInt(env.TRUSTED_PROXY_COUNT ?? "", 10);

  return Number.isFinite(parsed) ? Math.min(5, Math.max(0, parsed)) : 0;
}

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);

    return url.protocol === "http:" || url.protocol === "https:" ? url.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Hosts of the configured application URLs. */
export function configuredAppHosts(env: TrustEnv = process.env): string[] {
  return [env.NEXT_PUBLIC_APP_URL, env.APP_URL]
    .map((value) => hostOf(value?.trim()))
    .filter((host): host is string => Boolean(host));
}

/** Origins (scheme, host, port) of the configured application URLs. */
export function configuredAppOrigins(env: TrustEnv = process.env): string[] {
  return [env.NEXT_PUBLIC_APP_URL, env.APP_URL]
    .map((value) => originOf(value?.trim()))
    .filter((origin): origin is string => Boolean(origin));
}

export type OriginDecision =
  | { allowed: true }
  | { allowed: false; reason: "missing-origin" }
  | { allowed: false; reason: "untrusted-origin"; originHost: string | null }
  | { allowed: false; reason: "cross-site" };

export function checkReportOrigin(request: Request, env: TrustEnv = process.env): OriginDecision {
  const fetchSite = request.headers.get("sec-fetch-site");

  if (fetchSite !== null && fetchSite !== "same-origin") {
    return { allowed: false, reason: "cross-site" };
  }

  const origin = request.headers.get("origin");

  if (!origin) {
    return { allowed: false, reason: "missing-origin" };
  }

  const originHost = hostOf(origin);

  if (!originHost) {
    return { allowed: false, reason: "untrusted-origin", originHost: null };
  }

  if (configuredAppOrigins(env).includes(originOf(origin) ?? "")) {
    return { allowed: true };
  }

  const allowedHosts = new Set<string>();
  const host = headerHost(request.headers.get("host"));

  if (host) allowedHosts.add(host);

  if (trustedProxyCount(env) > 0) {
    const forwardedHost = headerHost(request.headers.get("x-forwarded-host"));

    if (forwardedHost) allowedHosts.add(forwardedHost);
  }

  return allowedHosts.has(originHost)
    ? { allowed: true }
    : { allowed: false, reason: "untrusted-origin", originHost };
}

/** The client address for rate limiting, or null when it cannot be trusted. */
export function clientKey(request: Request, env: TrustEnv = process.env): string | null {
  const proxies = trustedProxyCount(env);

  if (proxies === 0) return null;

  const hops = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);

  // Fewer hops than trusted proxies: the chain is not what was configured.
  const address = hops.length >= proxies ? hops[hops.length - proxies] : null;

  return address && /^[0-9a-fA-F:.]{2,45}$/.test(address) ? address : null;
}

/**
 * Rejected-origin diagnostics: at most one console warning per interval,
 * with the count and up to five distinct origin hosts (no addresses, paths
 * or report contents), so a misconfigured proxy is noticed without the
 * endpoint becoming a log-flooding tool itself.
 */
export function createOriginRejectionNotifier(options: {
  intervalMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
  env?: TrustEnv;
} = {}) {
  const intervalMs = options.intervalMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let lastWarning = -Infinity;
  let count = 0;
  const hosts = new Set<string>();

  return (originHost: string | null) => {
    count += 1;

    if (hosts.size < 5) hosts.add(originHost ?? "(invalid origin)");

    const time = now();

    if (time - lastWarning < intervalMs) return;

    const expected = configuredAppHosts(options.env ?? process.env);

    warn(
      `[error-log] rejected ${count} browser error report(s) from untrusted origin(s): ${[...hosts].join(", ")}. ` +
        (expected.length > 0
          ? `Configured application host(s): ${expected.join(", ")}.`
          : "NEXT_PUBLIC_APP_URL / APP_URL is not set: if this is the application's own address (behind a reverse proxy), set it.")
    );

    lastWarning = time;
    count = 0;
    hosts.clear();
  };
}
