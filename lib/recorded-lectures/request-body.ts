import { uploadError } from "./upload-errors";

/*
 * Recorded Lectures (RL-3.2): bounded JSON request bodies for the upload
 * APIs (the start request is a few hundred bytes).
 *
 *   - Content-Type must be application/json (415 otherwise);
 *   - a declared Content-Length above the limit is refused BEFORE anything is
 *     read (413); an invalid Content-Length is refused (400);
 *   - the body is then read as a stream and refused as soon as it passes the
 *     limit (413), so a missing or wrong Content-Length cannot make the
 *     application read more than `maxBytes` (+ one network chunk);
 *   - the text must be valid UTF-8 JSON (400 INVALID_JSON).
 *
 * Note: a POST below /api/lectures also passes the middleware, which Next.js
 * 14.2 makes buffer the body before the route runs; this limit cannot change
 * that (nginx's client_max_body_size bounds it), it bounds what this
 * application itself reads and parses.
 */

/** The start-upload request body limit (16 KiB). */
export const START_UPLOAD_BODY_MAX_BYTES = 16 * 1024;

export async function readLimitedJson(request: Request, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(contentType.trim())) throw uploadError("JSON_CONTENT_TYPE_REQUIRED");

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const text = declared.trim();
    if (!/^\d{1,16}$/.test(text)) throw uploadError("LENGTH_INVALID");
    if (Number(text) > maxBytes) throw uploadError("REQUEST_TOO_LARGE");
  }

  const bytes = await readAtMost(request, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw uploadError("INVALID_JSON");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw uploadError("INVALID_JSON");
  }
}

async function readAtMost(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw uploadError("REQUEST_TOO_LARGE");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
