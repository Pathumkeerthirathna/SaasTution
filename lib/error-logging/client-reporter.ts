/*
 * Browser side of error logging: sends an error report to the server
 * (POST /api/client-errors), which writes it to client-errors.jsonl. Browsers
 * cannot write log files themselves.
 *
 * Best effort and silent: never throws, never retries, never reports its own
 * failures. Sanitized here already (sanitize.ts), and again on the server.
 * Sends: error name, message, stack, Next.js digest, the page path (no query
 * string) and a random reference ID. Not sent: cookies, storage, form data,
 * the page's query string or user details (the server reads the browser and
 * OS from the User-Agent itself).
 */

import type { ClientErrorReport } from "./client-report";
import { CLIENT_ERROR_ENDPOINT } from "./constants";
import { ERROR_LOG_LIMITS, normalizeError, sanitizeRoute, scrubText } from "./sanitize";

/** At most this many reports per page load. */
const MAX_REPORTS_PER_PAGE = 20;
/** The same error again within this window is not sent twice. */
const DUPLICATE_WINDOW_MS = 30_000;

// Browser noise without a usable error: cross-origin script errors and the
// harmless ResizeObserver notification.
const IGNORED_MESSAGES = [/^Script error\.?$/i, /ResizeObserver loop/i];

let sentThisPage = 0;
const recentlySent = new Map<string, number>();

/** A short random reference, shown to the user and stored with the report. */
export function createClientEventId(): string {
  try {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);

    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 16);
  }
}

function send(body: string) {
  try {
    // text/plain: a "simple" body for sendBeacon; the server parses it as JSON.
    const blob = new Blob([body], { type: "text/plain;charset=UTF-8" });

    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function" && navigator.sendBeacon(CLIENT_ERROR_ENDPOINT, blob)) {
      return;
    }

    void fetch(CLIENT_ERROR_ENDPOINT, {
      method: "POST",
      body,
      keepalive: true,
      credentials: "same-origin",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
    }).catch(() => undefined);
  } catch {
    // Reporting is best effort.
  }
}

export type ClientErrorOptions = {
  source: "client" | "react";
  /** What caught it, e.g. "window-error", "unhandled-rejection", "error-boundary:app". */
  kind: string;
  digest?: string;
};

/**
 * Reports an error to the server log. Returns the reference ID (shown on
 * error screens), or null when nothing was sent.
 */
export function reportClientError(error: unknown, options: ClientErrorOptions): string | null {
  try {
    if (typeof window === "undefined") return null;

    const normalized = normalizeError(error);

    if (IGNORED_MESSAGES.some((pattern) => pattern.test(normalized.message))) {
      return null;
    }

    const fingerprint = `${options.source}|${normalized.name}|${normalized.message}|${(normalized.stack ?? "").split("\n")[1] ?? ""}`;
    const now = Date.now();
    const previous = recentlySent.get(fingerprint);

    if (previous !== undefined && now - previous < DUPLICATE_WINDOW_MS) {
      return null;
    }

    if (sentThisPage >= MAX_REPORTS_PER_PAGE) {
      return null;
    }

    sentThisPage += 1;
    recentlySent.set(fingerprint, now);

    const clientEventId = createClientEventId();
    const digest = options.digest ?? normalized.digest;
    const report: ClientErrorReport = {
      source: options.source,
      kind: scrubText(options.kind, ERROR_LOG_LIMITS.kind).replace(/[^A-Za-z0-9:._-]/g, "-") || "unknown",
      name: normalized.name,
      message: normalized.message,
      // Leaves room for the other fields within the endpoint's 8 KiB limit.
      stack: normalized.stack ? normalized.stack.slice(0, 5000) : undefined,
      digest: digest && /^[A-Za-z0-9_-]{1,120}$/.test(digest) ? digest : undefined,
      route: sanitizeRoute(window.location.pathname) || undefined,
      clientEventId,
    };

    send(JSON.stringify(report));

    return clientEventId;
  } catch {
    return null;
  }
}
