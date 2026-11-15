import { createHash, type Hash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { parseSubmissionStorageKey, submissionLegacyCopyPath } from "@/lib/assignments/submission-keys";
import { AppError, reportRouteError } from "@/lib/error-handler";
import { getSharedFileStorage, invalidateSharedFileStorageForRootError } from "@/lib/file-storage/open-root";
import { isStorageError } from "@/lib/file-storage/types";
import { noteLegacyCopyPath, parseNoteStorageKey } from "@/lib/notes/storage-keys";
import { parseProfilePhotoKey } from "@/lib/profile-images/storage-keys";

/*
 * Unified storage (Stage 2): the ONE place where Lecture Notes and student
 * assignment submissions write and read their files.
 *
 * Writes (new uploads): FILE_STORAGE_ROOT through the shared LocalFileStorage
 * (lib/file-storage/open-root.ts). The file is streamed into a NEW file
 * (exclusive create, never overwrites, server-generated key), hashed with
 * SHA-256 while it is written, must have exactly the size the request
 * declared, and is flushed (file + directory on POSIX) before the caller
 * creates the database reference. Any failure removes the partial file.
 *
 * Reads, in this order:
 *   1. storageKey (set): the shared storage; the key must parse as a key of
 *      the expected resource (note / submission), otherwise it is refused.
 *   2. otherwise the legacy fileUrl, resolved EXACTLY as the routes did
 *      before Stage 2:
 *        "/uploads/..." (Notes only) -> <cwd>/public/uploads/...
 *        anything else               -> <cwd>/storage/{fileUrl}
 *      with the same bound check (outside the root -> 403 FILE_ACCESS_DENIED).
 *      New: no symbolic link below the legacy root is followed (each
 *      component is lstat-ed; the opened file must be the lstat-ed one).
 *      The legacy root folder itself may be a link (e.g. to a data volume),
 *      as before.
 * Reads stream; nothing loads a whole file into memory. Errors are
 * StoredFileError with a fixed code; routes keep their existing messages.
 */

const IS_WINDOWS = process.platform === "win32";
const O_NOFOLLOW = IS_WINDOWS ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
const READ_HIGH_WATER_MARK = 256 * 1024;

export type StoredFileKind = "NOTE" | "SUBMISSION";

export type StoredFileErrorCode = "STORAGE_UNAVAILABLE" | "FILE_UNAVAILABLE" | "FILE_ACCESS_DENIED";

export class StoredFileError extends Error {
  constructor(readonly code: StoredFileErrorCode) {
    super(
      code === "STORAGE_UNAVAILABLE"
        ? "File storage is not available."
        : code === "FILE_ACCESS_DENIED"
          ? "The requested file is not available."
          : "The file is no longer available."
    );
    this.name = "StoredFileError";
  }
}

/** The route-facing error for a read failure; `notFoundMessage` keeps each route's existing 404 text. */
export function storedFileAppError(error: unknown, notFoundMessage: string): unknown {
  if (!(error instanceof StoredFileError)) return error;
  if (error.code === "FILE_ACCESS_DENIED") return new AppError("The requested file is not available.", 403, "FILE_ACCESS_DENIED");
  if (error.code === "STORAGE_UNAVAILABLE") return new AppError("File storage is not available. Please try again later.", 503, "STORAGE_UNAVAILABLE");
  return new AppError(notFoundMessage, 404, "FILE_NOT_FOUND");
}

const STORAGE_UNAVAILABLE_APP_ERROR = () => new AppError("File storage is not available. Please try again later.", 503, "STORAGE_UNAVAILABLE");

function reportStorageProblem(error: unknown, label: string, what: "cleanup" | "legacy-copy") {
  try {
    reportRouteError(error, { request: new Request(`http://internal/stored-files/${what}`, { method: "POST" }), label });
  } catch {
    // Logging must never break the request.
  }
}

const reportCleanupFailure = (error: unknown, label: string) => reportStorageProblem(error, label, "cleanup");

// ---- Writes ----------------------------------------------------------------------------------------------

async function* hashedChunks(source: ReadableStream<Uint8Array>, hash: Hash): AsyncGenerator<Uint8Array> {
  const reader = source.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      hash.update(value);
      yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export type StoredUpload = { storageKey: string; sha256: string; sizeBytes: number };

/**
 * Streams `file` into a NEW file at `storageKey` (the caller validated type
 * and size limits and generated the key). Exact size, SHA-256 while writing,
 * flushed before returning. Throws AppError (503 / 507 / 400) for storage
 * problems; the partial file is never left behind by a failed write.
 */
export async function writeUploadedFile(storageKey: string, file: Blob, maxBytes: number): Promise<StoredUpload> {
  // The routes check their own limits first (with their own messages); this is the last line of defence.
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes) {
    throw new AppError("The file is larger than allowed.", 400, "FILE_TOO_LARGE");
  }
  const opened = await getSharedFileStorage();
  if (!opened.ok) throw STORAGE_UNAVAILABLE_APP_ERROR();
  const hash = createHash("sha256");
  try {
    const { bytesWritten } = await opened.storage.writeNewFile(storageKey, hashedChunks(file.stream() as ReadableStream<Uint8Array>, hash), {
      maxBytes,
      exactBytes: file.size,
      sync: true,
      syncDirectory: true,
    });
    return { storageKey, sha256: hash.digest("hex"), sizeBytes: bytesWritten };
  } catch (error) {
    if (!isStorageError(error)) throw error;
    if (invalidateSharedFileStorageForRootError(error.code)) throw STORAGE_UNAVAILABLE_APP_ERROR();
    if (error.code === "NO_SPACE") throw new AppError("There is not enough storage space to save this file.", 507, "STORAGE_FULL");
    if (error.code === "SIZE_MISMATCH" || error.code === "LIMIT_EXCEEDED" || error.code === "ABORTED") {
      throw new AppError("The uploaded file could not be stored completely. Please try again.", 400, "UPLOAD_INCOMPLETE");
    }
    throw error;
  }
}

/**
 * Removes a file this feature wrote (a failed / superseded upload). Never
 * throws: a failure is logged and leaves an unreferenced file (found by the
 * inventory), never a broken reference.
 */
export async function removeStoredFileQuietly(storageKey: string, label: string): Promise<boolean> {
  try {
    return (await removeStoredFileStrict(storageKey)) === "DELETED";
  } catch (error) {
    reportCleanupFailure(error, label);
    return false;
  }
}

/**
 * Permanent deletion (Stage 3.6): what a strict removal found. "MISSING" (the
 * file was already gone) counts as deleted, so a retry after a partial
 * deletion succeeds. Any other problem THROWS (storage unavailable, a link or
 * a non-file at the path, an I/O error): the caller keeps the database
 * reference and retries later.
 */
export type StrictRemoval = "DELETED" | "MISSING";

/** Removes ONE new-storage file by its key (never a directory, never through a link). */
export async function removeStoredFileStrict(storageKey: string): Promise<StrictRemoval> {
  const opened = await getSharedFileStorage();
  if (!opened.ok) throw new StoredFileError("STORAGE_UNAVAILABLE");
  return (await opened.storage.remove(storageKey)) ? "DELETED" : "MISSING";
}

// ---- Rollback window: legacy dual-write (Stage 2.1) ----------------------------------------------------------

/*
 * While the rollback window is open, every new upload is stored TWICE and
 * the database row references both:
 *   storageKey -> FILE_STORAGE_ROOT/Teachers/.../{random}.{ext}     (read by this version)
 *   fileUrl    -> <cwd>/storage/{lectures|assignments}/{id}/{random}.{ext}
 *                 (the pre-Stage-2 location and layout, read by the previous version)
 * Both copies are complete, flushed and verified (same size and SHA-256)
 * BEFORE the row is written; any failure removes what was already written.
 * The legacy copy's path is derived from the key, so a pair is always
 * recognisable. Consistency across versions is enforced by the database: an
 * update that changes fileUrl without changing storageKey (what the previous
 * version's resubmission does) clears storageKey and sha256 (trigger in
 * migration 20261115120000_add_unified_file_storage_keys), so this version
 * then reads the previous version's file, never a stale one.
 *
 * ON unless UNIFIED_STORAGE_LEGACY_DUAL_WRITE is explicitly "off" / "false" /
 * "0" (fail-safe: an unset or mistyped value keeps rollback possible). See
 * docs/unified-file-storage.md for when it may be turned off.
 */

export const LEGACY_DUAL_WRITE_ENV = "UNIFIED_STORAGE_LEGACY_DUAL_WRITE";

export function isLegacyDualWriteEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[LEGACY_DUAL_WRITE_ENV]?.trim().toLowerCase();
  return !(value === "off" || value === "false" || value === "0");
}

/** The legacy-copy path paired with a key; null when the key is not a valid key of that kind. */
export function legacyCopyPathFor(kind: StoredFileKind, storageKey: string): string | null {
  try {
    return kind === "NOTE" ? noteLegacyCopyPath(storageKey) : submissionLegacyCopyPath(storageKey);
  } catch {
    return null;
  }
}

const LEGACY_DIRECTORY_MODE = 0o750;
const LEGACY_FILE_MODE = 0o640;

class LegacyCopyError extends Error {
  constructor(
    readonly reason: "UNSAFE_PATH" | "MISMATCH" | "IO_ERROR",
    readonly errno?: string
  ) {
    super(
      reason === "UNSAFE_PATH"
        ? "A legacy storage path is a link or not a directory."
        : reason === "MISMATCH"
          ? "The legacy copy does not match the stored file."
          : `A legacy storage file operation failed (${errno ?? "unknown"}).`
    );
    this.name = "LegacyCopyError";
  }
}

/** <cwd>/storage, created if missing (as the previous version did); the folder itself may be a link, as before. */
async function legacyStorageRoot(appDir: string): Promise<string> {
  const linkOrDir = path.join(appDir, "storage");
  try {
    await mkdir(linkOrDir, { mode: LEGACY_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const root = await realpath(linkOrDir);
  if (!(await stat(root)).isDirectory()) throw new LegacyCopyError("UNSAFE_PATH");
  return root;
}

async function syncDirectoryIfPossible(dir: string) {
  if (IS_WINDOWS) return; // Node cannot flush a directory on Windows (as in LocalFileStorage).
  const handle = await open(dir, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Writes the verified legacy copy at <cwd>/storage/{relativePath}: folders
 * created one level at a time and checked (never a link), the file created
 * exclusively (never overwritten, O_NOFOLLOW), streamed, compared with the
 * stored file's size and SHA-256, flushed. Any failure removes the copy.
 */
async function writeLegacyCopy(relativePath: string, file: Blob, expected: { sha256: string; sizeBytes: number }, appDir: string) {
  const segments = relativePath.split("/");
  let target: string | null = null;
  let handle: FileHandle | undefined;
  try {
    let dir = await legacyStorageRoot(appDir);
    for (const segment of segments.slice(0, -1)) {
      dir = path.join(dir, segment);
      try {
        await mkdir(dir, { mode: LEGACY_DIRECTORY_MODE });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new LegacyCopyError("UNSAFE_PATH");
    }
    const candidate = path.join(dir, segments[segments.length - 1]);
    handle = await open(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, LEGACY_FILE_MODE);
    target = candidate;

    const hash = createHash("sha256");
    let written = 0;
    for await (const chunk of hashedChunks(file.stream() as ReadableStream<Uint8Array>, hash)) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, written + offset);
        if (bytesWritten <= 0) throw new Error("Short write.");
        offset += bytesWritten;
      }
      written += chunk.byteLength;
    }
    if (written !== expected.sizeBytes || hash.digest("hex") !== expected.sha256) throw new LegacyCopyError("MISMATCH");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectoryIfPossible(dir);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (target) await unlink(target).catch(() => undefined);
    reportStorageProblem(error, "Unified storage: the rollback (legacy) copy could not be written", "legacy-copy");
    if (error instanceof LegacyCopyError && error.reason === "MISMATCH") {
      throw new AppError("The uploaded file could not be stored completely. Please try again.", 400, "UPLOAD_INCOMPLETE");
    }
    throw new AppError("File storage is not available. Please try again later.", 503, "STORAGE_UNAVAILABLE");
  }
}

/** Removes a legacy copy this feature wrote; never through a link; never throws (failures are logged). */
export async function removeLegacyCopyQuietly(relativePath: string, label: string, appDir: string = process.cwd()): Promise<boolean> {
  try {
    return (await removeLegacyCopyStrict(relativePath, appDir)) === "DELETED";
  } catch (error) {
    reportCleanupFailure(error, label);
    return false;
  }
}

/**
 * Removes ONE rollback copy <cwd>/storage/{relativePath} (Stage 3.6 strict
 * form): every component below the legacy root is lstat-ed (no link is
 * followed; the last one must be a regular file). Missing -> "MISSING";
 * anything else unexpected throws. Only ever called with a path DERIVED from
 * a verified storage key (legacyCopyPathFor), never with an arbitrary fileUrl.
 */
export async function removeLegacyCopyStrict(relativePath: string, appDir: string = process.cwd()): Promise<StrictRemoval> {
  try {
    let current = await realpath(path.join(appDir, "storage"));
    const segments = relativePath.split("/");
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]);
      const info = await lstat(current);
      const last = i === segments.length - 1;
      if (info.isSymbolicLink() || (!last && !info.isDirectory()) || (last && !info.isFile())) throw new LegacyCopyError("UNSAFE_PATH");
    }
    await unlink(current);
    return "DELETED";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "MISSING";
    if (error instanceof LegacyCopyError) throw error;
    // Never the raw error: its message carries the absolute path (it is logged).
    const code = (error as NodeJS.ErrnoException).code;
    throw new LegacyCopyError("IO_ERROR", typeof code === "string" && /^E[A-Z]{1,15}$/.test(code) ? code : undefined);
  }
}

export type StoredUploadResult = StoredUpload & {
  /** The value for the row's fileUrl: the legacy copy's path while dual-writing, else the storage key. */
  fileUrl: string;
  legacyCopy: string | null;
};

/**
 * Stores an upload (new storage, plus the verified legacy copy while the
 * rollback window is open). On success both files are complete; on failure
 * nothing is left behind (a failed cleanup is logged and leaves only an
 * unreferenced file). The caller commits the row afterwards and calls
 * discardStoredUpload if that fails.
 */
export async function storeUpload(
  kind: StoredFileKind,
  storageKey: string,
  file: Blob,
  maxBytes: number,
  options: { env?: Record<string, string | undefined>; appDir?: string } = {}
): Promise<StoredUploadResult> {
  const stored = await writeUploadedFile(storageKey, file, maxBytes);
  if (!isLegacyDualWriteEnabled(options.env)) return { ...stored, fileUrl: storageKey, legacyCopy: null };

  const legacyCopy = legacyCopyPathFor(kind, storageKey);
  try {
    if (!legacyCopy) throw new LegacyCopyError("UNSAFE_PATH");
    await writeLegacyCopy(legacyCopy, file, stored, options.appDir ?? process.cwd());
  } catch (error) {
    await removeStoredFileQuietly(storageKey, "Unified storage: discard the stored file after the legacy copy failed");
    throw error instanceof AppError ? error : new AppError("File storage is not available. Please try again later.", 503, "STORAGE_UNAVAILABLE");
  }
  return { ...stored, fileUrl: legacyCopy, legacyCopy };
}

/** Removes both copies of an upload whose row was NOT committed. Never throws. */
export async function discardStoredUpload(upload: StoredUploadResult, label: string): Promise<void> {
  await removeStoredFileQuietly(upload.storageKey, label);
  if (upload.legacyCopy) await removeLegacyCopyQuietly(upload.legacyCopy, label);
}

/**
 * After a replacement was COMMITTED: removes the previous upload's files if
 * this feature wrote them (its new-storage file, and its legacy copy when the
 * row's fileUrl is exactly the copy paired with its key). A previous file of
 * the old application (storageKey null) is never deleted. Never throws.
 */
export async function removeReplacedUpload(kind: StoredFileKind, previous: StoredFileReference, label: string): Promise<void> {
  if (!previous.storageKey) return;
  await removeStoredFileQuietly(previous.storageKey, label);
  const pairedCopy = legacyCopyPathFor(kind, previous.storageKey);
  if (pairedCopy && previous.fileUrl === pairedCopy) await removeLegacyCopyQuietly(pairedCopy, label);
}

// ---- Reads -------------------------------------------------------------------------------------------------

export type StoredFileReference = { storageKey: string | null; fileUrl: string };

export type OpenedStoredFile = {
  stream: ReadableStream<Uint8Array>;
  size: number;
  /** The file's extension (".pdf"), from the storage key or the legacy reference; "" when none. */
  extension: string;
  source: "storage" | "legacy";
};

function extensionOf(reference: string): string {
  return path.posix.extname(reference.replace(/\\/g, "/"));
}

async function openFromStorage(kind: StoredFileKind, storageKey: string): Promise<OpenedStoredFile> {
  const valid = kind === "NOTE" ? parseNoteStorageKey(storageKey) : parseSubmissionStorageKey(storageKey);
  if (!valid) throw new StoredFileError("FILE_UNAVAILABLE");
  const opened = await getSharedFileStorage();
  if (!opened.ok) throw new StoredFileError("STORAGE_UNAVAILABLE");
  try {
    const { stream, size } = await opened.storage.openRead(storageKey);
    return { stream, size, extension: extensionOf(storageKey), source: "storage" };
  } catch (error) {
    if (isStorageError(error) && invalidateSharedFileStorageForRootError(error.code)) throw new StoredFileError("STORAGE_UNAVAILABLE");
    // NOT_FOUND, UNSAFE_PATH (a link / hard link / other entry), INVALID_KEY, IO errors: never echoed.
    throw new StoredFileError("FILE_UNAVAILABLE");
  }
}

// ---- Teacher profile photos (unified storage) ------------------------------------------------------------

/**
 * Opens a stored profile photo for streaming. The key must parse as a
 * profile-photo key (Teachers/{t}/Profile/Photo/{32 hex}.{ext}); the caller
 * has already checked that the database references it. No legacy fallback
 * (legacy photos have their own route).
 */
export async function openProfilePhotoForRead(storageKey: string): Promise<OpenedStoredFile> {
  if (!parseProfilePhotoKey(storageKey)) throw new StoredFileError("FILE_UNAVAILABLE");
  const opened = await getSharedFileStorage();
  if (!opened.ok) throw new StoredFileError("STORAGE_UNAVAILABLE");
  try {
    const { stream, size } = await opened.storage.openRead(storageKey);
    return { stream, size, extension: extensionOf(storageKey), source: "storage" };
  } catch (error) {
    if (isStorageError(error) && invalidateSharedFileStorageForRootError(error.code)) throw new StoredFileError("STORAGE_UNAVAILABLE");
    throw new StoredFileError("FILE_UNAVAILABLE");
  }
}

/**
 * Maintenance (the profile-photo orphan sweep): the entries of one folder of
 * the shared storage, never following links ("other" = a link or anything
 * that is not a plain file / directory). Throws StoredFileError
 * STORAGE_UNAVAILABLE when the storage is not configured.
 */
export async function* listStoredDirectory(key: string, options: { limit?: number } = {}): AsyncGenerator<{ name: string; kind: "file" | "directory" | "other" }> {
  const opened = await getSharedFileStorage();
  if (!opened.ok) throw new StoredFileError("STORAGE_UNAVAILABLE");
  yield* opened.storage.listDirectory(key, options);
}

/** Size and modification time of one stored file; null when missing. Throws for links and storage problems. */
export async function statStoredFile(key: string): Promise<{ size: number; modifiedAtMs: number } | null> {
  const opened = await getSharedFileStorage();
  if (!opened.ok) throw new StoredFileError("STORAGE_UNAVAILABLE");
  return opened.storage.stat(key);
}

/** Removes a folder only if it is empty (never recursively); false when missing or not empty. Never throws. */
export async function removeEmptyStoredDirectoryQuietly(key: string): Promise<boolean> {
  try {
    const opened = await getSharedFileStorage();
    if (!opened.ok) return false;
    return await opened.storage.removeEmptyDirectory(key);
  } catch {
    return false;
  }
}

/**
 * Legacy teacher profile photos (uploaded before unified storage) as the old
 * route served them: <cwd>/storage/teachers/{name}. The name must match the
 * old naming ({teacher id}-{time}.{raster extension}); SVG and every other
 * type is refused. The same confined reader as legacy Notes: inside the root,
 * no link below it, the opened file is the one checked. Read only: legacy
 * photos are never moved or deleted.
 */
export const LEGACY_TEACHER_PHOTO_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,190}\.(jpg|jpeg|png|webp|gif)$/i;

export async function openLegacyTeacherPhoto(name: unknown, appDir?: string): Promise<OpenedStoredFile> {
  if (typeof name !== "string" || !LEGACY_TEACHER_PHOTO_NAME.test(name)) throw new StoredFileError("FILE_UNAVAILABLE");
  return openLegacy(`teachers/${name}`, { allowLegacyUploads: false, appDir });
}

/** The legacy location of a fileUrl, exactly as the pre-Stage-2 routes computed it. */
export function resolveLegacyFileLocation(
  fileUrl: string,
  options: { allowLegacyUploads: boolean; appDir?: string }
): { root: string; filePath: string } {
  const appDir = options.appDir ?? process.cwd();
  if (options.allowLegacyUploads && fileUrl.startsWith("/uploads/")) {
    return { root: path.join(appDir, "public", "uploads"), filePath: path.join(appDir, "public", fileUrl) };
  }
  return { root: path.join(appDir, "storage"), filePath: path.join(appDir, "storage", fileUrl) };
}

async function openLegacy(fileUrl: string, options: { allowLegacyUploads: boolean; appDir?: string }): Promise<OpenedStoredFile> {
  if (typeof fileUrl !== "string" || fileUrl.length === 0 || fileUrl.includes("\0")) throw new StoredFileError("FILE_UNAVAILABLE");
  const { root, filePath } = resolveLegacyFileLocation(fileUrl, options);
  const relative = path.relative(root, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw new StoredFileError("FILE_ACCESS_DENIED");

  // The legacy root itself may be a link (as before); nothing below it may be.
  let current: string;
  try {
    current = await realpath(root);
  } catch {
    throw new StoredFileError("FILE_UNAVAILABLE");
  }
  const segments = relative.split(path.sep);
  let seen;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    try {
      seen = await lstat(current);
    } catch {
      throw new StoredFileError("FILE_UNAVAILABLE");
    }
    const last = i === segments.length - 1;
    if (seen.isSymbolicLink() || (!last && !seen.isDirectory()) || (last && !seen.isFile())) throw new StoredFileError("FILE_UNAVAILABLE");
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(current, fsConstants.O_RDONLY | O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || !seen || info.dev !== seen.dev || info.ino !== seen.ino) throw new StoredFileError("FILE_UNAVAILABLE");
    if (info.size === 0) {
      await handle.close();
      return { stream: new ReadableStream<Uint8Array>({ start: (c) => c.close() }), size: 0, extension: extensionOf(fileUrl), source: "legacy" };
    }
    const nodeStream = handle.createReadStream({ start: 0, end: info.size - 1, highWaterMark: READ_HIGH_WATER_MARK, autoClose: true });
    return { stream: Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>, size: info.size, extension: extensionOf(fileUrl), source: "legacy" };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error instanceof StoredFileError ? error : new StoredFileError("FILE_UNAVAILABLE");
  }
}

/**
 * Opens a Note / submission file for streaming: storageKey first, then the
 * legacy fileUrl. The caller has already authorised the request.
 */
export async function openStoredFileForRead(
  kind: StoredFileKind,
  reference: StoredFileReference,
  options: { allowLegacyUploads: boolean; appDir?: string }
): Promise<OpenedStoredFile> {
  if (reference.storageKey) return openFromStorage(kind, reference.storageKey);
  return openLegacy(reference.fileUrl, options);
}

/** A streamed file response (no whole-file buffer). */
export function storedFileResponse(file: OpenedStoredFile, headers: Record<string, string>): Response {
  return new Response(file.stream as unknown as BodyInit, {
    status: 200,
    headers: { ...headers, "Content-Length": String(file.size) },
  });
}
