// Reading breakout request bodies with a hard size cap.
//
// request.formData() / request.json() read the whole body into memory with
// no limit. Here the declared Content-Length is checked first (refused
// before a byte is read), and the body is then read chunk by chunk and
// abandoned as soon as it passes the cap, which also covers requests that
// send no Content-Length (chunked). Only then is it parsed.
//
// Multipart bodies (an assignment with a brief PDF) may be up to the PDF
// limit plus room for the text fields; anything larger is 413
// FILE_TOO_LARGE. JSON bodies have their own cap (a 100-question quiz at the
// maximum text lengths stays well below it); larger is 400 VALIDATION_ERROR.

import { breakoutError, pdfCheckError } from "./errors";
import { MAX_BREAKOUT_PDF_BYTES, sanitizeDisplayName, validatePdfUpload } from "./pdf-file";

/** The brief PDF plus every text field of the assignment form. */
export const MAX_MULTIPART_BODY_BYTES = MAX_BREAKOUT_PDF_BYTES + 1024 * 1024;

/** JSON bodies (quiz definitions, edits, actions, overrides). */
export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

type TooLarge = () => Error;

/** The body bytes, or the tooLarge() error once more than maxBytes arrive (or are declared). */
export async function readBodyWithLimit(request: Request, maxBytes: number, tooLarge: TooLarge): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative integer.");
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!/^\d+$/.test(declared.trim()) || !Number.isSafeInteger(length)) {
      throw breakoutError("VALIDATION_ERROR", "Invalid Content-Length.");
    }
    if (length > maxBytes) throw tooLarge();
  }
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const mediaType = (request: Request) => (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

/**
 * A JSON body (application/json). An empty or malformed body throws the
 * SyntaxError, which handleRouteError answers with the app's usual
 * 400 INVALID_JSON.
 */
export async function readJsonBody(request: Request, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<unknown> {
  if (mediaType(request) !== "application/json") {
    throw breakoutError("VALIDATION_ERROR", "Send the request as application/json.");
  }
  const bytes = await readBodyWithLimit(request, maxBytes, () => breakoutError("VALIDATION_ERROR", "The request is too large."));
  return JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
}

/** A multipart/form-data body, size-capped before it is parsed. */
export async function readMultipartBody(request: Request, maxBytes: number = MAX_MULTIPART_BODY_BYTES): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (mediaType(request) !== "multipart/form-data") {
    throw breakoutError("VALIDATION_ERROR", "Send the request as multipart/form-data.");
  }
  const bytes = await readBodyWithLimit(request, maxBytes, () => breakoutError("FILE_TOO_LARGE"));
  try {
    return await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw breakoutError("VALIDATION_ERROR", "Invalid form data.");
  }
}

/** Refuses any field outside `allowed` (strict, like the zod schemas). */
export function assertOnlyFormFields(form: FormData, allowed: readonly string[]): void {
  const known = new Set(allowed);
  for (const name of new Set(form.keys())) {
    if (!known.has(name)) throw breakoutError("VALIDATION_ERROR", "Unexpected form field.");
  }
}

function single(form: FormData, name: string): FormDataEntryValue | null {
  const values = form.getAll(name);
  if (values.length > 1) throw breakoutError("VALIDATION_ERROR", `The field "${name}" was sent more than once.`);
  return values.length === 1 ? values[0] : null;
}

/** A text field, or undefined when absent. A file in its place is refused. */
export function formText(form: FormData, name: string): string | undefined {
  const value = single(form, name);
  if (value === null) return undefined;
  if (typeof value !== "string") throw breakoutError("VALIDATION_ERROR", `The field "${name}" must be text.`);
  return value;
}

/** "true" / "false" only; undefined when absent. */
export function formBoolean(form: FormData, name: string): boolean | undefined {
  const value = formText(form, name);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw breakoutError("VALIDATION_ERROR", `The field "${name}" must be true or false.`);
}

/** A JSON-encoded text field (e.g. targets); undefined when absent. */
export function formJson(form: FormData, name: string): unknown {
  const value = formText(form, name);
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw breakoutError("VALIDATION_ERROR", `The field "${name}" is not valid JSON.`);
  }
}

export type UploadedPdf = { bytes: Uint8Array; displayName: string; sizeBytes: number };

/**
 * A PDF file field, checked from its bytes (validatePdfUpload): 400
 * INVALID_PDF or 413 FILE_TOO_LARGE. Null when absent, including the empty,
 * nameless part a browser sends for a file input left empty (Node's parser
 * turns a part with filename="" into the text "", others keep an empty File).
 */
export async function formPdf(form: FormData, name: string): Promise<UploadedPdf | null> {
  const value = single(form, name);
  if (value === null || value === "") return null;
  if (typeof value === "string") throw breakoutError("VALIDATION_ERROR", `The field "${name}" must be a file.`);
  if (value.size === 0 && value.name === "") return null;
  if (value.size > MAX_BREAKOUT_PDF_BYTES) throw breakoutError("FILE_TOO_LARGE");
  const bytes = new Uint8Array(await value.arrayBuffer());
  const check = validatePdfUpload(bytes, value.type);
  if (!check.ok) throw pdfCheckError(check.code);
  return { bytes, displayName: sanitizeDisplayName(value.name), sizeBytes: bytes.byteLength };
}
