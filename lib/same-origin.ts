/*
 * Same-origin protection for state-changing, cookie-authenticated requests
 * (CSRF). Server only.
 *
 * The session cookie is SameSite=Lax, which already keeps it off most
 * cross-site POSTs; this check is the explicit second layer:
 *   1. Sec-Fetch-Site, when the browser sends it, must be "same-origin"
 *      ("same-site", "cross-site" and "none" are refused).
 *   2. Origin must be present and equal, as a whole origin (scheme, host,
 *      port), to a configured application URL: NEXT_PUBLIC_APP_URL or
 *      APP_URL (lib/error-logging/request-trust.ts). The Host /
 *      X-Forwarded-Host headers are never trusted for this.
 *   3. No configured application URL: refused (fail closed).
 */

import { configuredAppOrigins, type TrustEnv } from "@/lib/error-logging/request-trust";

export type SameOriginDecision =
  | { allowed: true }
  | { allowed: false; reason: "cross-site" | "missing-origin" | "untrusted-origin" | "origin-not-configured" };

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function checkSameOriginRequest(request: Request, env: TrustEnv = process.env): SameOriginDecision {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite.trim().toLowerCase() !== "same-origin") {
    return { allowed: false, reason: "cross-site" };
  }

  const allowed = configuredAppOrigins(env);
  if (allowed.length === 0) return { allowed: false, reason: "origin-not-configured" };

  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return { allowed: false, reason: "missing-origin" };

  const normalized = originOf(origin.trim());
  return normalized && allowed.includes(normalized)
    ? { allowed: true }
    : { allowed: false, reason: "untrusted-origin" };
}
