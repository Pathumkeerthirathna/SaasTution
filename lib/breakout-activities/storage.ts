// Disk I/O for breakout activity PDFs (teacher briefs, student submissions).
// The layout and the path validation live in pdf-file.ts; this module only
// writes, reads and removes, always through those checks first.
//
//   <storage root>/breakout-activities/<sessionId>/briefs/<activityId>/<storedName>
//   <storage root>/breakout-activities/<sessionId>/submissions/<activityId>/<storedName>
//
// The storage root is <cwd>/storage, like every other upload in the app.
//
// Symlink protection:
// - The storage root itself MAY be a symlink (e.g. to a data volume). It is
//   resolved once per operation with realpath and that resolved root is
//   trusted.
// - Below it, every component (breakout-activities, <sessionId>,
//   briefs|submissions, <activityId>) must be a real directory, and a stored
//   file must be a regular file: a symlink or anything else there is refused
//   (logged; upload fails, read is 404, removal reports failure).
// - Upload: directories are created one level at a time and checked; the
//   temporary file is created exclusively (O_CREAT | O_EXCL) with
//   O_NOFOLLOW where the platform has it; the chain and the folder's
//   realpath are checked again before the rename.
// - Read: the file is opened (O_NOFOLLOW where available) and read through
//   that handle; fstat must show a regular file with the same device and
//   inode as the lstat taken before opening. Without O_NOFOLLOW (Windows)
//   that comparison is what detects a file swapped for a link.
// - Delete / session cleanup: the chain is checked first; unlink and rm
//   never follow a symlink in the last component or inside the folder.
//
// Remaining limitation: Node has no openat()/O_PATH, so every check works on
// path names. A component swapped for a symlink in the instant between a
// check and the following operation is not excluded. Doing that needs write
// access to the storage folder (an account already on the server); no part
// of any path comes from user input (pdf-file.ts).
//
// Writes are atomic: the bytes go to a temporary file in the same folder,
// renamed to the final name, so a reader never sees half a file. A failed
// write leaves nothing behind.
//
// A file written successfully whose database transaction then fails is NOT
// deleted by the caller (approved decision F2): the error can be ambiguous
// (the transaction may have committed before the failure reached the app),
// and deleting the file would then break a committed row. Callers never
// call removeBreakoutFile() on a newly written file in a transaction-error
// catch; such orphans stay inside the session's folder and go with it in
// the planned Step 5 session cleanup (removeBreakoutSessionDir).
// removeBreakoutFile() is only for files a COMMITTED change no longer
// refers to (e.g. a replaced brief, after the commit).

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { AppError } from "@/lib/error-handler";

import { breakoutError } from "./errors";
import {
  buildBreakoutFilePath,
  generateStoredFileName,
  hasPdfMagic,
  MAX_BREAKOUT_PDF_BYTES,
  PDF_MIME_TYPE,
  randomFileToken,
  resolveBreakoutFilePath,
  resolveBreakoutSessionDir,
  sanitizeDisplayName,
  type BreakoutFileKind,
} from "./pdf-file";

/** 0 where the platform has no O_NOFOLLOW (Windows): the inode check covers it. */
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

/** A symlink or non-directory below the storage root. Never shown to clients. */
class UnsafeStoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeStoragePathError";
  }
}

const errnoCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

/** <cwd>/storage: the root every stored path is relative to. */
export function breakoutStorageRoot(): string {
  return path.join(process.cwd(), "storage");
}

/** The trusted, resolved root. Null when it does not exist (and create is false). */
async function resolveRoot(storageRoot: string, create: boolean): Promise<string | null> {
  if (create) await mkdir(storageRoot, { recursive: true });
  try {
    return await realpath(storageRoot);
  } catch (error) {
    if (!create && errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** Absolute paths of each directory from just below `root` down to `targetDir`. */
function directoriesBelow(root: string, targetDir: string): string[] {
  const rel = path.relative(root, targetDir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new UnsafeStoragePathError("Breakout storage path is outside the storage root.");
  }
  const parts = rel.split(path.sep);
  return parts.map((_, i) => path.join(root, ...parts.slice(0, i + 1)));
}

async function assertRealDirectory(dir: string) {
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new UnsafeStoragePathError("A breakout storage folder is a symlink or not a directory.");
  }
}

/** True when every directory exists and is real; false at the first missing one. */
async function checkDirectoryChain(root: string, targetDir: string): Promise<boolean> {
  for (const dir of directoriesBelow(root, targetDir)) {
    try {
      await assertRealDirectory(dir);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

/** Creates missing directories one level at a time; each must end up a real directory. */
async function ensureDirectoryChain(root: string, targetDir: string): Promise<void> {
  for (const dir of directoriesBelow(root, targetDir)) {
    try {
      await mkdir(dir);
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
    await assertRealDirectory(dir);
  }
}

function logRefused(operation: string, sessionId: string) {
  console.error(`Breakout ${operation} refused: a symlink or non-directory in the storage path.`, { sessionId });
}

export type StoredBreakoutFile = {
  /** Stored in the database (filePath / briefFilePath): relative, "/" separated. */
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
};

/**
 * Writes an upload that already passed validatePdfUpload (checked again
 * here: a PDF, not empty, within the size limit). The stored name is
 * server-generated; the original name is never part of the path.
 */
export async function writeBreakoutPdf(input: {
  sessionId: string;
  kind: BreakoutFileKind;
  activityId: string;
  bytes: Uint8Array;
  storageRoot?: string;
  nowMs?: number;
}): Promise<StoredBreakoutFile> {
  const { bytes } = input;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw breakoutError("INVALID_PDF");
  if (bytes.byteLength > MAX_BREAKOUT_PDF_BYTES) throw breakoutError("FILE_TOO_LARGE");
  if (!hasPdfMagic(bytes)) throw breakoutError("INVALID_PDF");

  const storedName = generateStoredFileName(input.nowMs ?? Date.now(), randomFileToken());
  const relativePath = buildBreakoutFilePath({
    sessionId: input.sessionId,
    kind: input.kind,
    activityId: input.activityId,
    storedName,
  });
  const root = (await resolveRoot(input.storageRoot ?? breakoutStorageRoot(), true)) as string;
  const absolutePath = resolveBreakoutFilePath(root, relativePath, input.sessionId);
  const dir = path.dirname(absolutePath);
  const tempPath = `${absolutePath}.${randomBytes(8).toString("hex")}.tmp`;

  let handle: FileHandle | undefined;
  let tempCreated = false;
  try {
    await ensureDirectoryChain(root, dir);
    handle = await open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW);
    tempCreated = true;
    await handle.writeFile(bytes);
    await handle.close();
    handle = undefined;
    // Nothing was swapped while writing: same real folder, before the final name appears.
    if (!(await checkDirectoryChain(root, dir)) || (await realpath(dir)) !== dir) {
      throw new UnsafeStoragePathError("The breakout storage folder changed during the upload.");
    }
    await rename(tempPath, absolutePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (tempCreated) {
      // Only through a still-safe folder: never unlink via a swapped-in symlink.
      await checkDirectoryChain(root, dir)
        .then((safe) => (safe ? unlink(tempPath) : undefined))
        .catch(() => {});
    }
    if (error instanceof UnsafeStoragePathError) logRefused("upload", input.sessionId);
    throw error;
  }
  return { relativePath, absolutePath, sizeBytes: bytes.byteLength };
}

/**
 * Removes one stored file (e.g. after its database transaction failed).
 * True when it was removed or was already gone; false when the path is
 * invalid, unsafe or the removal failed (logged). Never throws.
 */
export async function removeBreakoutFile(
  relativePath: string | null | undefined,
  sessionId: string,
  storageRoot: string = breakoutStorageRoot()
): Promise<boolean> {
  if (!relativePath) return true;
  try {
    const root = await resolveRoot(storageRoot, false);
    if (!root) return true;
    let absolutePath: string;
    try {
      absolutePath = resolveBreakoutFilePath(root, relativePath, sessionId);
    } catch {
      console.error("Breakout file removal refused an invalid stored path.", { sessionId });
      return false;
    }
    if (!(await checkDirectoryChain(root, path.dirname(absolutePath)))) return true;
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new UnsafeStoragePathError("A stored breakout file is not a regular file.");
    await unlink(absolutePath);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return true;
    if (error instanceof UnsafeStoragePathError) {
      logRefused("file removal", sessionId);
      return false;
    }
    console.error("Failed to remove a breakout file:", { sessionId, error });
    return false;
  }
}

/**
 * Removes a session's whole breakout folder (run after the session's
 * breakout rows were deleted and that transaction committed). Never throws:
 * a failure is returned and logged, and the session end still succeeds.
 */
export async function removeBreakoutSessionDir(
  sessionId: string,
  storageRoot: string = breakoutStorageRoot()
): Promise<{ removed: boolean }> {
  try {
    const root = await resolveRoot(storageRoot, false);
    if (!root) return { removed: true };
    let dir: string;
    try {
      dir = resolveBreakoutSessionDir(root, sessionId);
    } catch {
      console.error("Breakout folder removal refused an invalid session id.");
      return { removed: false };
    }
    // breakout-activities/ and <sessionId>/ themselves must be real folders;
    // rm does not follow symlinks found inside the folder (it removes the links).
    if (!(await checkDirectoryChain(root, dir))) return { removed: true };
    await rm(dir, { recursive: true, force: true });
    return { removed: true };
  } catch (error) {
    if (error instanceof UnsafeStoragePathError) {
      logRefused("folder removal", sessionId);
      return { removed: false };
    }
    console.error("Failed to remove a breakout session folder:", { sessionId, error });
    return { removed: false };
  }
}

/**
 * Reads a stored file for download. 404 FILE_NOT_FOUND when it is missing,
 * is not a regular file, or its path is invalid or unsafe (logged).
 */
export async function readBreakoutFile(
  relativePath: string,
  sessionId: string,
  storageRoot: string = breakoutStorageRoot()
): Promise<Uint8Array> {
  const root = await resolveRoot(storageRoot, false);
  if (!root) throw breakoutError("FILE_NOT_FOUND");
  let absolutePath: string;
  try {
    absolutePath = resolveBreakoutFilePath(root, relativePath, sessionId);
  } catch {
    console.error("Breakout file read refused an invalid stored path.", { sessionId });
    throw breakoutError("FILE_NOT_FOUND");
  }
  try {
    if (!(await checkDirectoryChain(root, path.dirname(absolutePath)))) throw breakoutError("FILE_NOT_FOUND");
    const before = await lstat(absolutePath, { bigint: true });
    if (before.isSymbolicLink()) throw new UnsafeStoragePathError("A stored breakout file is a symlink.");
    if (!before.isFile()) throw breakoutError("FILE_NOT_FOUND");
    const handle = await open(absolutePath, fsConstants.O_RDONLY | O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new UnsafeStoragePathError("A stored breakout file changed while it was opened.");
      }
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close().catch(() => {});
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof UnsafeStoragePathError) {
      logRefused("file read", sessionId);
      throw breakoutError("FILE_NOT_FOUND");
    }
    // ENOENT: gone; ELOOP / EMLINK: O_NOFOLLOW met a symlink; ENOTDIR: a component is a file.
    if (["ENOENT", "ELOOP", "EMLINK", "ENOTDIR"].includes(errnoCode(error) ?? "")) throw breakoutError("FILE_NOT_FOUND");
    throw error;
  }
}

// RFC 3986 unreserved characters stay as they are; everything else is
// percent-encoded as UTF-8 (RFC 5987 / RFC 6266 filename*).
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Content-Disposition for a download: always an attachment (never rendered
 * inline). `filename` is an ASCII fallback for old clients; `filename*`
 * carries the real (Sinhala / Tamil / any) name.
 */
export function attachmentContentDisposition(displayName: string): string {
  const name = sanitizeDisplayName(displayName);
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

/** Response headers for a breakout PDF download. */
export function breakoutPdfDownloadHeaders(displayName: string, sizeBytes: number): Record<string, string> {
  return {
    "Content-Type": PDF_MIME_TYPE,
    "Content-Length": String(sizeBytes),
    "Content-Disposition": attachmentContentDisposition(displayName),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };
}
