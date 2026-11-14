import { contentRangeHeader, parseRangeHeader, unsatisfiedContentRangeHeader } from "@/lib/file-storage/http-range";
import { StorageError, type FileStorage } from "@/lib/file-storage/types";

import { RECORDING_MIME_TYPE } from "./validation";

/*
 * GET / HEAD playback response for one stored recording (RL-1 foundation,
 * used by the student stream route since RL-4.3). The caller has already
 * authorised the request; this only turns a storage key into an HTTP
 * response:
 *
 *   no / ignored Range  -> 200, the whole file
 *   single byte range   -> 206 + Content-Range
 *   unsatisfiable       -> 416 + Content-Range: bytes * /size, no body
 *   HEAD                -> the same status and headers, no body, and the
 *                          file is never opened for reading (stat only)
 *
 * If-Range (RL-4.3): no validator (ETag / Last-Modified) is ever sent, so no
 * If-Range value can match the current representation; RFC 9110 section
 * 13.1.5 then requires the Range header to be ignored. Any If-Range => 200,
 * the whole file. Other conditional headers are ignored (nothing is cached).
 *
 * The body streams from the storage layer (64 KiB reads); nothing is loaded
 * into memory. Every response is private, no-store and nosniff, inline with
 * a fixed generic file name, same-origin only (CORP), and tells nginx not to
 * buffer it (X-Accel-Buffering: no) so backpressure reaches the file read
 * and nginx never spools a video to its temporary files.
 *
 * Resource lifecycle (RL-4.3): `acquireSlot` (a stream slot) is called only
 * when a body will really be streamed (GET, 200 / 206, length > 0), just
 * before the file is opened, so HEAD, 416, zero-length responses and every
 * error before that never take a slot. It returns the slot's release, or
 * throws (e.g. a 429 / 503 AppError) and then nothing is held or opened.
 * The release is called EXACTLY ONCE on every later path:
 *   - opening or checking the file throws -> before rethrowing;
 *   - a body -> when it ends, the client disconnects (request.signal; also
 *     when it is already aborted), the consumer cancels it, a read fails, or
 *     it is idle for idleTimeoutMs.
 * Idle = no pull from the consumer for idleTimeoutMs: armed when the body is
 * created (a body that is never consumed) and after every chunk handed over;
 * cleared while a read is in flight, so slow disk reads never count and
 * steady playback (which keeps pulling) never trips it. On idle the read is
 * cancelled, the file handle closed, the slot released and the body errored
 * with an AbortError (Next.js then destroys the response quietly; the player
 * re-requests the range it needs).
 *
 * Errors thrown (for the caller to map; never with a path):
 *   StorageError("NOT_FOUND")         the file is missing
 *   StorageError("SIZE_MISMATCH")     the size differs from expectedSize, or
 *                                     changed between stat and open
 *   StorageError("INVALID_ARGUMENT")  a method other than GET / HEAD
 *   other StorageErrors from the storage layer.
 */

export const PLAYBACK_DOWNLOAD_NAME = "recording.mp4";

/** No pull for this long ends the body (backstop for paused players and unconsumed bodies). */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

export type StreamResponseInput = {
  storage: Pick<FileStorage, "stat" | "openRead">;
  key: string;
  request: Request;
  contentType?: string;
  /** The size the database records; a different file size is SIZE_MISMATCH (nothing is sent). */
  expectedSize?: number;
  /** Takes a stream slot right before the file is opened (see above); returns its release, or throws. */
  acquireSlot?: () => () => void;
  /** Default STREAM_IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
};

function baseHeaders(contentType: string): Headers {
  return new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `inline; filename="${PLAYBACK_DOWNLOAD_NAME}"`,
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Accel-Buffering": "no",
  });
}

/** Idempotent, never-throwing wrapper around the caller's release. */
function once(release: (() => void) | undefined): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      release?.();
    } catch {
      // Releasing must never break the response path.
    }
  };
}

export async function createRecordingStreamResponse(input: StreamResponseInput): Promise<Response> {
  let release = once(undefined);
  const idleTimeoutMs = input.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  let handedOff = false;
  try {
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1) throw new StorageError("INVALID_ARGUMENT");
    const method = input.request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new StorageError("INVALID_ARGUMENT");

    const info = await input.storage.stat(input.key);
    if (!info) throw new StorageError("NOT_FOUND");
    const size = info.size;
    if (input.expectedSize !== undefined && size !== input.expectedSize) throw new StorageError("SIZE_MISMATCH");
    const headers = baseHeaders(input.contentType ?? RECORDING_MIME_TYPE);

    const rangeHeader = input.request.headers.has("if-range") ? null : input.request.headers.get("range");
    const range = parseRangeHeader(rangeHeader, size);
    if (range.kind === "unsatisfiable") {
      headers.set("Content-Range", unsatisfiedContentRangeHeader(size));
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }

    const status = range.kind === "partial" ? 206 : 200;
    const start = range.kind === "partial" ? range.start : 0;
    const end = range.kind === "partial" ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    headers.set("Content-Length", String(length));
    if (range.kind === "partial") headers.set("Content-Range", contentRangeHeader(start, end, size));

    if (method === "HEAD" || length === 0) return new Response(null, { status, headers });

    // Only now: a body will be streamed. A refusal throws here, holding nothing.
    if (input.acquireSlot) release = once(input.acquireSlot());
    const { stream, size: openedSize } = await input.storage.openRead(input.key, range.kind === "partial" ? { start, end } : undefined);
    if (openedSize !== size) {
      await stream.cancel().catch(() => undefined);
      throw new StorageError("SIZE_MISMATCH"); // replaced between stat and open
    }

    const body = guardedBody(stream, { signal: input.request.signal, release, idleTimeoutMs });
    handedOff = true;
    return new Response(body, { status, headers });
  } finally {
    if (!handedOff) release();
  }
}

function idleError(): Error {
  // Named AbortError: Next.js treats it as an aborted response (destroys it without logging an error).
  const error = new Error("The recording stream was idle for too long.");
  error.name = "AbortError";
  return error;
}

/**
 * Pass-through that keeps its own reader on the file stream, so a client
 * disconnect (request.signal), the consumer cancelling the response, a read
 * error or the idle timeout cancels the file read (closing the handle) and
 * calls `release` exactly once. (A stream handed to Response is locked;
 * cancelling it directly would do nothing.)
 */
function guardedBody(
  source: ReadableStream<Uint8Array>,
  options: { signal: AbortSignal | null | undefined; release: () => void; idleTimeoutMs: number }
): ReadableStream<Uint8Array> {
  const { signal, release, idleTimeoutMs } = options;
  const reader = source.getReader();
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const clearIdle = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  /** Ends everything once; true only for the call that did it. */
  const finish = (): boolean => {
    if (finished) return false;
    finished = true;
    clearIdle();
    signal?.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => undefined);
    release();
    return true;
  };

  function onAbort() {
    finish(); // the next (or pending) pull closes the body
  }

  const onIdle = () => {
    timer = undefined;
    if (finish()) {
      try {
        controllerRef?.error(idleError());
      } catch {
        // Already closed or errored.
      }
    }
  };

  const armIdle = () => {
    clearIdle();
    if (finished) return;
    timer = setTimeout(onIdle, idleTimeoutMs);
    (timer as { unref?: () => void }).unref?.();
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controllerRef = controller;
        if (signal?.aborted) finish();
        else {
          signal?.addEventListener("abort", onAbort, { once: true });
          armIdle(); // a body that is never consumed is ended too
        }
      },
      async pull(controller) {
        clearIdle();
        if (finished) {
          controller.close();
          return;
        }
        try {
          const { done, value } = await reader.read();
          if (finished) {
            controller.close();
          } else if (done) {
            finish();
            controller.close();
          } else {
            controller.enqueue(value);
            armIdle();
          }
        } catch (error) {
          if (finish()) controller.error(error);
          else controller.close();
        }
      },
      cancel() {
        finish();
      },
    },
    { highWaterMark: 0 }
  );
}
