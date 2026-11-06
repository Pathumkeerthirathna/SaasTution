// Breakout activity PDFs (teacher briefs and student submissions): validation,
// display names and storage paths. Pure: nothing here touches the disk; the
// write and cleanup services (Phase 2a) use these to decide what and where.
//
// Layout, relative to the storage root (storage/, not committed):
//   breakout-activities/<sessionId>/briefs/<activityId>/<storedName>
//   breakout-activities/<sessionId>/submissions/<activityId>/<storedName>
// Ending a session removes breakout-activities/<sessionId>/ as a whole.

import path from "node:path";

export const MAX_BREAKOUT_PDF_BYTES = 25 * 1024 * 1024;
export const PDF_MIME_TYPE = "application/pdf";
export const BREAKOUT_STORAGE_DIR = "breakout-activities";
export const MAX_DISPLAY_NAME_LENGTH = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORED_NAME = /^\d{13}-[0-9a-f]{16,64}\.pdf$/;
const RANDOM_HEX = /^[0-9a-f]{16,64}$/;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export type BreakoutFileKind = "brief" | "submission";

export type PdfCheck =
  | { ok: true }
  | { ok: false; code: "FILE_EMPTY" | "FILE_TOO_LARGE" | "FILE_NOT_PDF" };

/** True when the bytes start with "%PDF-" at offset 0 (no leading bytes allowed). */
export function hasPdfMagic(bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < PDF_MAGIC.length) return false;
  return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * Checks an upload already read into memory. The size is taken from the
 * bytes themselves, never from the client's claim.
 */
export function validatePdfUpload(bytes: Uint8Array, mimeType: string): PdfCheck {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return { ok: false, code: "FILE_EMPTY" };
  if (bytes.byteLength > MAX_BREAKOUT_PDF_BYTES) return { ok: false, code: "FILE_TOO_LARGE" };
  if (mimeType !== PDF_MIME_TYPE || !hasPdfMagic(bytes)) return { ok: false, code: "FILE_NOT_PDF" };
  return { ok: true };
}

// Control characters and bidirectional overrides/isolates (which can make
// "cod.exe" display as "exe.doc"). ZWJ/ZWNJ (U+200C/U+200D) are kept: Sinhala
// and Tamil names need them.
const UNSAFE_NAME_CHARS = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu;

/**
 * The original file name, made safe for display and the Content-Disposition
 * filename: no directories, control or bidi-override characters, at most 200
 * characters (code points, as VARCHAR(200) counts), always ending in ".pdf".
 * It is never used as a path.
 */
export function sanitizeDisplayName(name: unknown, fallback = "document"): string {
  let base = typeof name === "string" ? name.normalize("NFC") : "";
  base = base.split(/[\\/]/).pop() ?? "";
  base = base.replace(UNSAFE_NAME_CHARS, "").replace(/\s+/gu, " ").trim();
  if (/\.pdf$/i.test(base)) base = base.slice(0, -4).trim();
  base = base.replace(/^\.+/, "").replace(/\.+$/, "").trim();
  if (base === "") base = fallback;
  const chars = Array.from(base);
  const room = MAX_DISPLAY_NAME_LENGTH - ".pdf".length;
  if (chars.length > room) base = chars.slice(0, room).join("").trim();
  return `${base}.pdf`;
}

/** The name on disk: server-generated only, never from user input. */
export function generateStoredFileName(nowMs: number, randomHex: string): string {
  if (!Number.isInteger(nowMs) || nowMs < 1e12 || nowMs >= 1e13) throw new RangeError("Invalid timestamp.");
  if (!RANDOM_HEX.test(randomHex)) throw new RangeError("randomHex must be 16-64 lowercase hex characters.");
  return `${nowMs}-${randomHex}.pdf`;
}

/** 32 random hex characters from the platform CSPRNG (for generateStoredFileName). */
export function randomFileToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new RangeError(`${label} must be a UUID.`);
  return value.toLowerCase();
}

/** The path stored in the database (relative to the storage root, "/" separated). */
export function buildBreakoutFilePath(input: {
  sessionId: string;
  kind: BreakoutFileKind;
  activityId: string;
  storedName: string;
}): string {
  const sessionId = requireUuid(input.sessionId, "sessionId");
  const activityId = requireUuid(input.activityId, "activityId");
  if (input.kind !== "brief" && input.kind !== "submission") throw new RangeError("Unknown file kind.");
  if (typeof input.storedName !== "string" || !STORED_NAME.test(input.storedName)) {
    throw new RangeError("storedName is not a server-generated name.");
  }
  const folder = input.kind === "brief" ? "briefs" : "submissions";
  return [BREAKOUT_STORAGE_DIR, sessionId, folder, activityId, input.storedName].join("/");
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * The absolute path of a stored breakout file. Throws unless the relative
 * path has exactly the layout above and resolves inside
 * <storageRoot>/breakout-activities/<sessionId>/ (so a tampered database value
 * can never reach another file).
 */
export function resolveBreakoutFilePath(storageRoot: string, relativePath: string, expectedSessionId: string): string {
  const sessionId = requireUuid(expectedSessionId, "sessionId");
  if (typeof relativePath !== "string") throw new RangeError("Invalid stored path.");
  const parts = relativePath.split("/");
  if (
    parts.length !== 5 ||
    parts[0] !== BREAKOUT_STORAGE_DIR ||
    parts[1].toLowerCase() !== sessionId ||
    (parts[2] !== "briefs" && parts[2] !== "submissions") ||
    !UUID.test(parts[3]) ||
    !STORED_NAME.test(parts[4])
  ) {
    throw new RangeError("Invalid stored path.");
  }
  const sessionDir = resolveBreakoutSessionDir(storageRoot, sessionId);
  const absolute = path.resolve(sessionDir, parts[2], parts[3], parts[4]);
  if (!isInside(sessionDir, absolute)) throw new RangeError("Invalid stored path.");
  return absolute;
}

/**
 * <storageRoot>/breakout-activities/<sessionId>/<briefs|submissions>/<activityId>:
 * the folder of ONE activity id (Group Activities session-end purge). Both
 * ids must be UUIDs; the result is always inside that session's folder.
 */
export function resolveBreakoutActivityDir(storageRoot: string, sessionId: string, kind: BreakoutFileKind, activityId: string): string {
  const sessionDir = resolveBreakoutSessionDir(storageRoot, sessionId);
  const id = requireUuid(activityId, "activityId");
  if (kind !== "brief" && kind !== "submission") throw new RangeError("Unknown file kind.");
  const dir = path.resolve(sessionDir, kind === "brief" ? "briefs" : "submissions", id);
  if (!isInside(sessionDir, dir)) throw new RangeError("Invalid activity folder.");
  return dir;
}

/** <storageRoot>/breakout-activities/<sessionId>: the folder removed when the session ends. */
export function resolveBreakoutSessionDir(storageRoot: string, sessionId: string): string {
  const id = requireUuid(sessionId, "sessionId");
  if (typeof storageRoot !== "string" || storageRoot === "") throw new RangeError("storageRoot is required.");
  const base = path.resolve(storageRoot, BREAKOUT_STORAGE_DIR);
  const dir = path.resolve(base, id);
  if (!isInside(base, dir)) throw new RangeError("Invalid session folder.");
  return dir;
}
