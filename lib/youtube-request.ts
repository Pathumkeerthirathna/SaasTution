import { AsyncLocalStorage } from "node:async_hooks";

import { AppError } from "@/lib/error-handler";

/**
 * Time limits for YouTube Data API and Google token requests.
 *
 * - requestMs: one request, headers AND body. A request that does not finish
 *   in time is aborted and fails with YouTubeRequestTimeoutError (503
 *   YOUTUBE_TIMEOUT). A timeout never means "done": YouTube may or may not
 *   have applied the change, so callers treat it like any other failed call.
 * - Operation deadline: code running under runWithYouTubeDeadline (every
 *   lecture-lock holder, see youtube-operation-lock.ts) gives each request at
 *   most the time left before the deadline, and starts no request after it.
 *   The lock's deadline ends well before the lock expires, so a holder never
 *   keeps waiting on YouTube after another request could take its lock over.
 *
 * Mutable only so tests can shorten them.
 */
export const youtubeTimeouts = {
  /** One YouTube / Google token request. */
  requestMs: 10_000,
  /** Lecture lock lifetime (YouTubeOperationLock.expiresAt). */
  lockTtlMs: 60_000,
  /** YouTube requests under the lock stop this long before it expires (database writes follow). */
  lockSafetyMarginMs: 15_000,
  /** End Session / session restart: the whole YouTube cleanup of one lecture. */
  sessionCleanupMs: 15_000,
  /**
   * Session cleanup only: when the lecture lock is held, try again after
   * these waits (within sessionCleanupMs) before reporting it pending.
   */
  sessionCleanupLockRetriesMs: [1_000, 2_000] as number[],
  /** Failed-start cleanup (POST /api/youtube/lecture/start/abort); below the page's 10 s wait. */
  startAbortMs: 8_000,
};

export class YouTubeRequestTimeoutError extends AppError {
  constructor(reason: "timeout" | "deadline") {
    super(
      reason === "deadline"
        ? "YouTube did not answer in time for this action, so it was not finished. Please try again in a moment."
        : "YouTube did not answer in time. Please try again in a moment.",
      503,
      "YOUTUBE_TIMEOUT"
    );
    this.name = "YouTubeRequestTimeoutError";
  }
}

/**
 * YouTube (or Google) answered with an HTTP error: an explicit answer, unlike
 * a timeout (YouTubeRequestTimeoutError) or a network failure (fetch's own
 * error), where the request may or may not have been applied. `reason` is
 * YouTube's error reason (error.errors[0].reason, e.g. "invalidTransition"),
 * when the body has one.
 */
export class YouTubeApiError extends Error {
  readonly status: number;
  readonly reason?: string;

  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = "YouTubeApiError";
    this.status = status;
    this.reason = youtubeErrorReason(body);
  }
}

function youtubeErrorReason(body?: string): string | undefined {
  if (!body) return undefined;

  try {
    const reason = JSON.parse(body)?.error?.errors?.[0]?.reason;
    return typeof reason === "string" ? reason : undefined;
  } catch {
    return undefined;
  }
}

const deadlines = new AsyncLocalStorage<number>();

/**
 * Runs `operation` with a deadline (epoch ms) for every YouTube request it
 * makes. Nested deadlines keep the earlier one.
 */
export function runWithYouTubeDeadline<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
  const outer = deadlines.getStore();

  return deadlines.run(outer === undefined ? deadline : Math.min(outer, deadline), operation);
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * fetch() for YouTube / Google: limited to youtubeTimeouts.requestMs and to
 * the current operation deadline. The body is read inside the limit, so the
 * returned Response's text() / json() never wait on the network.
 */
export async function youtubeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const deadline = deadlines.getStore();
  const remaining = deadline === undefined ? Infinity : deadline - Date.now();

  if (remaining <= 0) {
    throw new YouTubeRequestTimeoutError("deadline");
  }

  const limitedByDeadline = remaining < youtubeTimeouts.requestMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(youtubeTimeouts.requestMs, remaining));

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.arrayBuffer();

    return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new YouTubeRequestTimeoutError(limitedByDeadline ? "deadline" : "timeout");
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}
