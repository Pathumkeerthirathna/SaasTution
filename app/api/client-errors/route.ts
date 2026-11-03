/*
 * POST /api/client-errors: browser error reports (lib/error-logging) into
 * client-errors.jsonl on the server. Public (errors happen before login too),
 * so it is guarded:
 *   - this site only (lib/error-logging/request-trust.ts): an Origin header
 *     matching the configured app URL / the request's own host, and
 *     Sec-Fetch-Site "same-origin" when sent; 403 otherwise (also with no
 *     Origin), with a throttled console warning for untrusted origins so a
 *     proxy misconfiguration is noticed. Rejected requests are refused
 *     before the rate limits, so they use none of the reports' quota;
 *   - bodies over 8 KiB are refused (413), also when no Content-Length is sent;
 *   - exactly the report's fields, with length limits (400 otherwise);
 *   - at most 20 reports per minute per client (when a trusted proxy
 *     identifies the client) and 120 overall (429);
 *   - the client log's per-minute byte budget (file-sink.ts) caps disk use;
 *   - every field is sanitized again here: the browser is never trusted.
 * The response never echoes anything back (204 when accepted).
 */

import { logError } from "@/lib/error-logging/server-logger";
import { createRateLimiter } from "@/lib/error-logging/rate-limit";
import {
  checkReportOrigin,
  clientKey,
  createOriginRejectionNotifier,
} from "@/lib/error-logging/request-trust";
import {
  CLIENT_ERROR_MAX_BODY_BYTES,
  clientErrorReportSchema,
} from "@/lib/error-logging/client-report";

export const dynamic = "force-dynamic";

// A page sends at most 20 reports (client-reporter.ts), so 20 per client per
// minute never blocks a genuine page.
const limiter = createRateLimiter({ perKey: 20, global: 120, windowMs: 60_000 });
const notifyRejectedOrigin = createOriginRejectionNotifier();

function empty(status: number) {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

// Reads at most `limit` bytes; null when the body is larger.
async function readBodyWithLimit(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    total += value.byteLength;

    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: Request) {
  try {
    const origin = checkReportOrigin(request);

    if (!origin.allowed) {
      if (origin.reason === "untrusted-origin") {
        notifyRejectedOrigin(origin.originHost);
      }

      return empty(403);
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");

    if (Number.isFinite(declaredLength) && declaredLength > CLIENT_ERROR_MAX_BODY_BYTES) {
      return empty(413);
    }

    if (!limiter.allow(clientKey(request))) {
      return empty(429);
    }

    const raw = await readBodyWithLimit(request, CLIENT_ERROR_MAX_BODY_BYTES);

    if (raw === null) {
      return empty(413);
    }

    let body: unknown;

    try {
      body = JSON.parse(raw);
    } catch {
      return empty(400);
    }

    const parsed = clientErrorReportSchema.safeParse(body);

    if (!parsed.success) {
      return empty(400);
    }

    const report = parsed.data;

    // Rebuilt as an error so the server logger normalizes and sanitizes it
    // like any other (the browser's values are never written as they are).
    const error = Object.assign(new Error(report.message), {
      name: report.name ?? "Error",
      stack: report.stack ?? "",
      digest: report.digest,
    });

    logError(error, {
      source: report.source,
      kind: report.kind,
      route: report.route || null,
      userAgent: request.headers.get("user-agent"),
      clientEventId: report.clientEventId,
    });

    return empty(204);
  } catch {
    // The logging endpoint must never become an error source itself.
    return empty(500);
  }
}
