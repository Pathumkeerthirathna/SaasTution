/** Where an error happened. */
export type ErrorSource = "client" | "react" | "api" | "server";

/** One log file per channel: browser errors, API route errors, other server errors. */
export type ErrorLogChannel = "client" | "api" | "server";

/** One line of an error log (JSON Lines). Every string is already sanitized. */
export type ErrorLogEntry = {
  /** Server-generated ID of this entry. */
  id: string;
  /** ISO 8601, server time. */
  timestamp: string;
  source: ErrorSource;
  /** What caught it, e.g. "window-error", "unhandled-rejection", "error-boundary:app", "unhandled-route-error". */
  kind: string;
  /** NODE_ENV of the server that wrote the entry. */
  environment: string;
  name: string;
  message: string;
  stack?: string;
  /** Next.js error digest (links a browser report to the server's own log of the same error). */
  digest?: string;
  /** Path only, no query string. */
  route?: string;
  method?: string;
  statusCode?: number;
  browser?: string;
  os?: string;
  deviceType?: string;
  /** Reference shown to the user on the error screen (browser reports only). */
  clientEventId?: string;
};

export function channelForSource(source: ErrorSource): ErrorLogChannel {
  if (source === "api") return "api";
  if (source === "server") return "server";

  return "client";
}
