/*
 * The server side of error logging (Node only): turns an error into a
 * sanitized ErrorLogEntry and writes it to the channel's JSON Lines file
 * (file-sink.ts). Used by handleRouteError (API routes), the client-error
 * endpoint (browser reports) and the process monitor (other server errors).
 *
 * Never throws and never blocks the caller: logging problems end up on
 * stderr, not in the response.
 *
 * Recorded: what failed (name, message, stack, digest), where (route path,
 * method), when, the environment, and the browser / OS / device type parsed
 * from the User-Agent. Never recorded: request bodies, query strings,
 * headers, cookies, IP addresses or user identities.
 *
 * Route, method and User-Agent come only from the context: the Request the
 * caller passes, or explicit values. No Next.js request-scope APIs (internal
 * stores, next/headers), so nothing here depends on a Next.js version.
 */

import { randomUUID } from "node:crypto";

import { UAParser } from "ua-parser-js";

import { checkErrorLogStorage, getDefaultFileSink, type FileSink } from "./file-sink";
import { ERROR_LOG_LIMITS, normalizeError, sanitizeRoute, scrubText } from "./sanitize";
import { channelForSource, type ErrorLogEntry, type ErrorSource } from "./types";

export type ServerErrorContext = {
  source: ErrorSource;
  kind: string;
  /** The incoming request, when the caller has it (route, method, User-Agent). */
  request?: Request;
  /**
   * Overrides the route taken from `request`. null: no route (a browser
   * report without one: the endpoint's own path is not it).
   */
  route?: string | null;
  method?: string;
  statusCode?: number;
  /** Overrides the User-Agent taken from `request`. */
  userAgent?: string | null;
  clientEventId?: string;
  /** For the process monitor: write synchronously (the process may be exiting). */
  sync?: boolean;
};

let sinkOverride: FileSink | null = null;

/** Tests only: write to another sink. */
export function setErrorLogSinkForTests(sink: FileSink | null) {
  sinkOverride = sink;
}

function currentSink() {
  return sinkOverride ?? getDefaultFileSink();
}

// Read defensively: an unusual Request (or a proxy around one) must not
// cost the entry.
function requestPath(request: Request | undefined): string | undefined {
  if (!request) return undefined;

  try {
    return new URL(request.url).pathname;
  } catch {
    return undefined;
  }
}

function requestUserAgent(request: Request | undefined): string | null {
  if (!request) return null;

  try {
    return request.headers.get("user-agent");
  } catch {
    return null;
  }
}

function requestMethod(request: Request | undefined): string | undefined {
  try {
    return request?.method;
  } catch {
    return undefined;
  }
}

function describeUserAgent(userAgent: string | null | undefined) {
  if (!userAgent) return {};

  try {
    const result = UAParser(userAgent.slice(0, 512));
    const join = (name?: string, version?: string) =>
      name ? scrubText(version ? `${name} ${version}` : name, 80) : undefined;

    return {
      browser: join(result.browser.name, result.browser.version),
      os: join(result.os.name, result.os.version),
      deviceType: result.device.type ? scrubText(result.device.type, 20) : "desktop",
    };
  } catch {
    return {};
  }
}

function safeMethod(method: string | undefined) {
  return method && /^[A-Z]{3,7}$/.test(method) ? method : undefined;
}

export function buildErrorLogEntry(error: unknown, context: ServerErrorContext): ErrorLogEntry {
  const normalized = normalizeError(error);
  const request = context.request;

  const routeSource = context.route === null ? undefined : context.route || requestPath(request);
  const userAgent = context.userAgent !== undefined ? context.userAgent : requestUserAgent(request);

  const entry: ErrorLogEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: context.source,
    kind: scrubText(context.kind, ERROR_LOG_LIMITS.kind) || "unknown",
    environment: process.env.NODE_ENV ?? "unknown",
    name: normalized.name,
    message: normalized.message,
    stack: normalized.stack,
    digest: normalized.digest,
    route: routeSource ? sanitizeRoute(routeSource) : undefined,
    method: safeMethod(context.method ?? requestMethod(request)),
    statusCode: context.statusCode,
    ...describeUserAgent(userAgent),
    clientEventId: context.clientEventId,
  };

  return entry;
}

/**
 * Logs an error to its channel's file. Fire and forget; never throws.
 * Returns the entry's ID (for a console line pointing to it), or null.
 */
export function logError(error: unknown, context: ServerErrorContext): string | null {
  return logErrorEntry(error, context)?.id ?? null;
}

/**
 * logError, returning the sanitized entry itself (or null): callers that also
 * print a summary use it instead of normalizing the error a second time.
 */
export function logErrorEntry(error: unknown, context: ServerErrorContext): ErrorLogEntry | null {
  try {
    const entry = buildErrorLogEntry(error, context);
    const sink = currentSink();
    const channel = channelForSource(context.source);

    if (context.sync) {
      sink.writeSync(channel, entry);
    } else {
      void sink.write(channel, entry);
    }

    return entry;
  } catch (failure) {
    try {
      console.error("[error-log] could not build the error log entry:", (failure as Error)?.name ?? "Error");
    } catch {
      // Nothing left to do.
    }

    return null;
  }
}

/** Resolves when queued writes have finished (tests). */
export function flushErrorLogs(): Promise<void> {
  return currentSink().flush();
}

// ---- Storage check ------------------------------------------------------------

const STORAGE_CHECKED = Symbol.for("slclassroom.errorLogging.storageChecked");

/**
 * Once per process: where the error logs go and whether they can be written
 * there (checkErrorLogStorage creates and changes nothing). Problems are
 * printed as warnings, so a production start without persistent, writable
 * log storage is visible in the PM2 log.
 */
export function reportErrorLogStorageOnce(
  check: typeof checkErrorLogStorage = checkErrorLogStorage,
  output: Pick<Console, "info" | "warn"> = console
): Promise<void> {
  const registry = globalThis as typeof globalThis & { [STORAGE_CHECKED]?: boolean };

  if (registry[STORAGE_CHECKED]) return Promise.resolve();
  registry[STORAGE_CHECKED] = true;

  return check()
    .then((result) => {
      if (result.status === "disabled") return;

      result.warnings.forEach((warning) => output.warn(`[error-log] WARNING: ${warning}`));

      if (result.status === "writable" || result.status === "missing") {
        output.info(`[error-log] error logs: ${result.dir}${result.status === "missing" ? " (created on the first entry)" : ""}`);
      }
    })
    .catch(() => undefined);
}

// ---- Server errors outside API routes ---------------------------------------

const MONITOR_INSTALLED = Symbol.for("slclassroom.errorLogging.processMonitor");

/**
 * Unhandled promise rejections and uncaught exceptions of the Node.js server
 * process, written to server-errors.jsonl. Observe only: Next.js registers
 * its own `uncaughtException` / `unhandledRejection` handlers (they log and
 * keep the server running), so these listeners change nothing about what the
 * process does; `uncaughtExceptionMonitor` never does.
 */
export function installServerErrorMonitor() {
  const registry = globalThis as typeof globalThis & { [MONITOR_INSTALLED]?: boolean };

  // Once per process (dev reloads re-evaluate modules).
  if (registry[MONITOR_INSTALLED]) return;
  registry[MONITOR_INSTALLED] = true;

  process.on("uncaughtExceptionMonitor", (error, origin) => {
    logError(error, {
      source: "server",
      kind: origin === "unhandledRejection" ? "unhandled-rejection" : "uncaught-exception",
      // The process may be about to exit: written before returning.
      sync: true,
    });
  });

  process.on("unhandledRejection", (reason) => {
    logError(reason, { source: "server", kind: "unhandled-rejection" });
  });
}

// Installed when the Next.js Node.js server first loads this module (any API
// route does, through lib/error-handler.ts). Next.js replaces NEXT_RUNTIME
// with "nodejs" in its server bundles; elsewhere (tests, tsx scripts, `next
// build`) nothing is installed, so their own error handling is untouched.
// instrumentation.ts is deliberately not used: it must import nothing in dev
// (tests/youtube/teacher-departure.test.cjs).
if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
  installServerErrorMonitor();
  reportErrorLogStorageOnce();
}
