/*
 * The application's public base URL, for absolute links: metadata
 * (metadataBase, canonical, Open Graph), and the teacher profile share links.
 *
 * Source: NEXT_PUBLIC_APP_URL, else APP_URL (the same settings the
 * same-origin check uses). In the browser only NEXT_PUBLIC_APP_URL exists (it
 * is inlined at build time).
 *
 * Rules:
 *   - only http(s) URLs; anything else is ignored;
 *   - the ORIGIN is kept (path, query, fragment and trailing slashes dropped),
 *     so joining a path never doubles a slash or the domain;
 *   - in production, plain http and localhost / loopback addresses are never
 *     used (they would put unreachable URLs into shared previews): the public
 *     domain DEFAULT_PUBLIC_SITE_URL is used instead;
 *   - in development / tests, a configured local URL is used as is, else
 *     http://localhost:3000.
 * Pure and dependency-free: safe in server and client code.
 */

export const DEFAULT_PUBLIC_SITE_URL = "https://slclassroom.live";
const DEVELOPMENT_SITE_URL = "http://localhost:3000";

type SiteEnv = { NEXT_PUBLIC_APP_URL?: string; APP_URL?: string; NODE_ENV?: string };

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/i;

function originOf(value: string | undefined): URL | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return new URL(url.origin);
  } catch {
    return null;
  }
}

/** The site's origin, e.g. "https://slclassroom.live" (no trailing slash). */
export function resolveSiteOrigin(env: SiteEnv): string {
  const production = env.NODE_ENV === "production";
  for (const candidate of [env.NEXT_PUBLIC_APP_URL, env.APP_URL]) {
    const url = originOf(candidate);
    if (!url) continue;
    if (production && (url.protocol !== "https:" || LOCAL_HOST.test(url.hostname))) continue;
    return url.origin;
  }
  return production ? DEFAULT_PUBLIC_SITE_URL : DEVELOPMENT_SITE_URL;
}

/** The site origin for this process (reads the environment each time; cheap). */
export function siteOrigin(): string {
  return resolveSiteOrigin({
    // Both references are written out so Next.js can inline NEXT_PUBLIC_APP_URL in client bundles.
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    APP_URL: typeof window === "undefined" ? process.env.APP_URL : undefined,
    NODE_ENV: process.env.NODE_ENV,
  });
}

/** metadataBase for app/layout.tsx. */
export function siteMetadataBase(): URL {
  return new URL(siteOrigin());
}

/**
 * An absolute URL on this site for a root-relative path ("/x/y"). A value
 * that is already absolute is returned only if it is on this site's origin;
 * anything else (another origin, "//host", relative without a leading slash)
 * gives null, so no foreign or malformed URL is ever emitted as ours.
 */
export function absoluteSiteUrl(pathOrUrl: string | null | undefined, origin: string = siteOrigin()): string | null {
  if (typeof pathOrUrl !== "string" || pathOrUrl === "") return null;
  if (pathOrUrl.startsWith("/") && !pathOrUrl.startsWith("//")) return new URL(pathOrUrl, `${origin}/`).toString();
  try {
    const url = new URL(pathOrUrl);
    return url.origin === origin ? url.toString() : null;
  } catch {
    return null;
  }
}

/** "/{slug}" (encoded; the slug as stored, with its capitals). */
export function teacherProfilePath(slug: string): string {
  return `/${encodeURIComponent(slug)}`;
}

/** The public profile URL, e.g. "https://slclassroom.live/pathum-kumara"; "" when there is no slug. */
export function teacherProfileUrl(slug: string | null | undefined, origin: string = siteOrigin()): string {
  if (typeof slug !== "string" || slug.trim() === "") return "";
  return `${origin}${teacherProfilePath(slug.trim())}`;
}
