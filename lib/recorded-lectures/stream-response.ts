import { contentRangeHeader, parseRangeHeader, unsatisfiedContentRangeHeader } from "@/lib/file-storage/http-range";
import { StorageError, type FileStorage } from "@/lib/file-storage/types";

import { RECORDING_MIME_TYPE } from "./validation";

/*
 * GET / HEAD playback response for one stored recording (RL-1 foundation;
 * no route uses it yet). The caller has already authorised the request;
 * this only turns a storage key into an HTTP response:
 *
 *   no / ignored Range  -> 200, the whole file
 *   single byte range   -> 206 + Content-Range
 *   unsatisfiable       -> 416 + Content-Range: bytes * /size, no body
 *   HEAD                -> the same status and headers, no body, and the
 *                          file is never opened for reading (stat only)
 *
 * The body streams from the storage layer (64 KiB reads); nothing is loaded
 * into memory. When the client disconnects (request.signal), the read is
 * cancelled and the file handle closed. Every response is private,
 * no-store and nosniff, inline, with a fixed generic file name.
 *
 * A missing file throws StorageError("NOT_FOUND") for the caller to map.
 */

export const PLAYBACK_DOWNLOAD_NAME = "recording.mp4";

export type StreamResponseInput = {
  storage: Pick<FileStorage, "stat" | "openRead">;
  key: string;
  request: Request;
  contentType?: string;
};

function baseHeaders(contentType: string): Headers {
  return new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `inline; filename="${PLAYBACK_DOWNLOAD_NAME}"`,
  });
}

export async function createRecordingStreamResponse(input: StreamResponseInput): Promise<Response> {
  const method = input.request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") throw new StorageError("INVALID_ARGUMENT");

  const info = await input.storage.stat(input.key);
  if (!info) throw new StorageError("NOT_FOUND");
  const size = info.size;
  const headers = baseHeaders(input.contentType ?? RECORDING_MIME_TYPE);

  const range = parseRangeHeader(input.request.headers.get("range"), size);
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

  const { stream, size: openedSize } = await input.storage.openRead(input.key, range.kind === "partial" ? { start, end } : undefined);
  if (openedSize !== size) {
    await stream.cancel().catch(() => undefined);
    throw new StorageError("SIZE_MISMATCH"); // replaced between stat and open
  }

  return new Response(cancelOnAbort(stream, input.request.signal), { status, headers });
}

/**
 * Pass-through that keeps its own reader on the file stream, so a client
 * disconnect (request.signal) or the consumer cancelling the response
 * cancels the file read and closes the handle. (A stream handed to Response
 * is locked; cancelling it directly would do nothing.)
 */
function cancelOnAbort(source: ReadableStream<Uint8Array>, signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let finished = false;
  const stop = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => undefined);
  };
  const onAbort = () => stop();
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", onAbort, { once: true });

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (finished) {
          controller.close();
          return;
        }
        try {
          const { done, value } = await reader.read();
          if (done || finished) {
            finished = true;
            signal?.removeEventListener("abort", onAbort);
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          stop();
          controller.error(error);
        }
      },
      cancel() {
        stop();
      },
    },
    { highWaterMark: 0 }
  );
}
