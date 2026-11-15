import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { parseSubmissionStorageKey } from "@/lib/assignments/submission-keys";
import { parseNoteStorageKey } from "@/lib/notes/storage-keys";

/*
 * Unified storage migration (inventory): READ-ONLY filesystem inspection of
 * the legacy Notes / submission storage AND (Stage 2.1) the new storage.
 *
 * Legacy resolution mirrors the current routes exactly (it does not change them):
 *   Note.fileUrl "/uploads/..."  -> {publicUploadsRoot}/...   (public/uploads; bound: that root)
 *   Note.fileUrl anything else   -> {storageRoot}/{fileUrl}   (path.join, bound: storage root)
 *   AssignmentSubmission.fileUrl -> {storageRoot}/{fileUrl}   (the submission routes have no /uploads/ branch)
 * New storage: {fileStorageRoot}/{storageKey} (a COPY of FILE_STORAGE_ROOT),
 * only for keys that parse as a note / submission key.
 * The routes use <cwd>/storage, <cwd>/public/uploads and FILE_STORAGE_ROOT;
 * here every root is given explicitly, so COPIES can be inspected.
 *
 * Never: write, create, rename, delete, follow a symbolic link (every path
 * component is lstat-ed from the root down; a root that is a link, or is
 * reached through one, is refused), or touch anything outside the roots.
 * Files are opened read-only (O_NOFOLLOW where the platform has it) and the
 * opened file must be the one lstat saw (same device and inode).
 */

const IS_WINDOWS = process.platform === "win32";
const HASH_CHUNK = 1024 * 1024;

export type LegacyRootName = "storage" | "publicUploads" | "fileStorage";
export type LegacyRoots = { storage: string; publicUploads: string | null; fileStorage: string | null };

/** Folders below the legacy storage root that hold Notes (lectures/) and submissions (assignments/). */
export const SCANNED_STORAGE_FOLDERS = ["lectures", "assignments"] as const;

export type ResolutionProblem = "INVALID_REFERENCE" | "UNSAFE_PATH" | "UPLOADS_ROOT_NOT_CONFIGURED";

export type ResolvedReference =
  | {
      ok: true;
      root: LegacyRootName;
      absolutePath: string;
      /** "/"-separated, relative to the root. */
      relativePath: string;
      legacyUploadsReference: boolean;
      /** Things the routes accept but a clean reference would not have (informational). */
      unusual: string[];
    }
  | { ok: false; problem: ResolutionProblem; legacyUploadsReference: boolean };

export function normaliseForCompare(absolutePath: string): string {
  return IS_WINDOWS ? absolutePath.toLowerCase() : absolutePath;
}

/**
 * True when `child` is `parent` or below it (case-insensitive on Windows, as
 * path.relative is). Kept local, so the inventory stays independent of the
 * Recorded Lectures storage modules.
 */
export function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function unusualFeatures(reference: string, expectedPrefix: string): string[] {
  const out: string[] = [];
  if (reference.includes("\\")) out.push("BACKSLASH");
  if (/(^|[\\/])\.\.?([\\/]|$)/.test(reference)) out.push("DOT_SEGMENT");
  if (/[\\/]{2,}/.test(reference)) out.push("EMPTY_SEGMENT");
  if (/^[A-Za-z]:/.test(reference) || (reference.startsWith("/") && !reference.startsWith("/uploads/"))) out.push("ABSOLUTE");
  if (!reference.startsWith(expectedPrefix) && !reference.startsWith("/uploads/")) out.push("UNEXPECTED_PREFIX");
  return out;
}

/** Where the current application would look for this legacy reference, or why it is not inspected. */
export function resolveLegacyReference(
  resourceType: "NOTE" | "ASSIGNMENT_SUBMISSION",
  reference: string,
  roots: LegacyRoots
): ResolvedReference {
  const legacyUploadsReference = reference.startsWith("/uploads/");
  if (typeof reference !== "string" || reference.trim() === "" || reference.includes("\0")) {
    return { ok: false, problem: "INVALID_REFERENCE", legacyUploadsReference };
  }

  let root: LegacyRootName;
  let rootPath: string;
  let absolutePath: string;
  if (resourceType === "NOTE" && legacyUploadsReference) {
    if (!roots.publicUploads) return { ok: false, problem: "UPLOADS_ROOT_NOT_CONFIGURED", legacyUploadsReference };
    root = "publicUploads";
    rootPath = roots.publicUploads;
    // The route: path.join(<cwd>/public, "/uploads/x") bounded by <cwd>/public/uploads.
    absolutePath = path.join(rootPath, reference.slice("/uploads/".length));
  } else {
    root = "storage";
    rootPath = roots.storage;
    absolutePath = path.join(rootPath, reference);
  }

  const relative = path.relative(rootPath, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, problem: "UNSAFE_PATH", legacyUploadsReference };
  }
  return {
    ok: true,
    root,
    absolutePath,
    relativePath: relative.split(path.sep).join("/"),
    legacyUploadsReference,
    unusual: unusualFeatures(reference, resourceType === "NOTE" ? "lectures/" : "assignments/"),
  };
}

/** True when `key` is a valid new-storage key of the record's kind (only such keys are ever opened). */
export function isStorageKeyOfKind(resourceType: "NOTE" | "ASSIGNMENT_SUBMISSION", key: string): boolean {
  return resourceType === "NOTE" ? parseNoteStorageKey(key) !== null : parseSubmissionStorageKey(key) !== null;
}

// ---- Roots -------------------------------------------------------------------------------------------------

export type RootProblem = "NOT_ABSOLUTE" | "MISSING" | "NOT_A_DIRECTORY" | "IS_A_LINK" | "REACHED_THROUGH_A_LINK" | "ROOTS_OVERLAP";

const ROOT_LABEL: Record<LegacyRootName, string> = { storage: "storage", publicUploads: "public uploads", fileStorage: "file storage" };

export class InventoryRootError extends Error {
  constructor(
    readonly root: LegacyRootName,
    readonly problem: RootProblem
  ) {
    super(`The ${ROOT_LABEL[root]} root is not usable (${problem}).`);
    this.name = "InventoryRootError";
  }
}

async function checkRoot(name: LegacyRootName, value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new InventoryRootError(name, "NOT_ABSOLUTE");
  const resolved = path.resolve(value);
  const info = await lstat(resolved).catch(() => null);
  if (!info) throw new InventoryRootError(name, "MISSING");
  if (info.isSymbolicLink()) throw new InventoryRootError(name, "IS_A_LINK");
  if (!info.isDirectory()) throw new InventoryRootError(name, "NOT_A_DIRECTORY");
  const real = await realpath(resolved);
  if (normaliseForCompare(real) !== normaliseForCompare(resolved)) throw new InventoryRootError(name, "REACHED_THROUGH_A_LINK");
  return resolved;
}

/** Validates the configured roots (read-only checks; nothing is created). No two may overlap. */
export async function openLegacyRoots(input: { storage: string; publicUploads?: string | null; fileStorage?: string | null }): Promise<LegacyRoots> {
  const storage = await checkRoot("storage", input.storage);
  const publicUploads = input.publicUploads ? await checkRoot("publicUploads", input.publicUploads) : null;
  const fileStorage = input.fileStorage ? await checkRoot("fileStorage", input.fileStorage) : null;
  const named: Array<[LegacyRootName, string | null]> = [
    ["storage", storage],
    ["publicUploads", publicUploads],
    ["fileStorage", fileStorage],
  ];
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const [, a] = named[i];
      const [nameB, b] = named[j];
      if (a && b && (isPathWithin(a, b) || isPathWithin(b, a))) throw new InventoryRootError(nameB, "ROOTS_OVERLAP");
    }
  }
  return { storage, publicUploads, fileStorage };
}

// ---- One referenced file ---------------------------------------------------------------------------------

export type FileProblem = "FILE_MISSING" | "SYMLINK_IN_PATH" | "PATH_COMPONENT_NOT_DIRECTORY" | "NOT_A_REGULAR_FILE" | "READ_ERROR" | "FILE_CHANGED_DURING_READ";

export type FileInspection =
  | { exists: true; physicalId: string; sizeBytes: number; sha256: string }
  | { exists: false; problem: FileProblem };

function physicalIdOf(info: { dev: bigint; ino: bigint }, absolutePath: string): string {
  // Same device + inode = the same physical file (also catches hard links). Some filesystems report 0.
  return info.ino !== BigInt(0) ? `inode:${info.dev}:${info.ino}` : `path:${normaliseForCompare(absolutePath)}`;
}

/**
 * lstat every component from the root down (no link is ever followed), then
 * hash the file through a read-only descriptor that must be the lstat-ed file.
 */
export async function inspectFile(rootPath: string, relativePath: string): Promise<FileInspection> {
  const segments = relativePath.split("/");
  let current = rootPath;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let info;
    try {
      info = await lstat(current, { bigint: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { exists: false, problem: code === "ENOENT" ? "FILE_MISSING" : code === "ENOTDIR" ? "PATH_COMPONENT_NOT_DIRECTORY" : "READ_ERROR" };
    }
    if (info.isSymbolicLink()) return { exists: false, problem: "SYMLINK_IN_PATH" };
    const last = i === segments.length - 1;
    if (!last && !info.isDirectory()) return { exists: false, problem: "PATH_COMPONENT_NOT_DIRECTORY" };
    if (last && !info.isFile()) return { exists: false, problem: "NOT_A_REGULAR_FILE" };
    if (last) return hashFile(current, info);
  }
  return { exists: false, problem: "FILE_MISSING" };
}

async function hashFile(absolutePath: string, seen: { dev: bigint; ino: bigint; size: bigint }): Promise<FileInspection> {
  const flags = fsConstants.O_RDONLY | (IS_WINDOWS ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
  let handle;
  try {
    handle = await open(absolutePath, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { exists: false, problem: code === "ENOENT" ? "FILE_MISSING" : code === "ELOOP" ? "SYMLINK_IN_PATH" : "READ_ERROR" };
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.dev !== seen.dev || info.ino !== seen.ino) return { exists: false, problem: "FILE_CHANGED_DURING_READ" };
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, HASH_CHUNK, total);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (BigInt(total) !== info.size) return { exists: false, problem: "FILE_CHANGED_DURING_READ" };
    return { exists: true, physicalId: physicalIdOf(info, absolutePath), sizeBytes: total, sha256: hash.digest("hex") };
  } catch {
    return { exists: false, problem: "READ_ERROR" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// ---- Scans for unreferenced files ------------------------------------------------------------------------------

export type ScannedFile = { root: LegacyRootName; relativePath: string; absolutePath: string; physicalId: string; expectedDepth: boolean };
export type UnexpectedEntry = { root: LegacyRootName; relativePath: string; kind: "symlink" | "other" | "directory"; reason: string };
export type ScanResult = {
  files: ScannedFile[];
  unexpected: UnexpectedEntry[];
  folders: Array<{ relativePath: string; scanned: boolean; reason?: string }>;
  truncated: boolean;
};

export const SCAN_MAX_ENTRIES = 1_000_000;

type WalkOptions = {
  root: LegacyRootName;
  rootPath: string;
  maxDepth: number;
  result: ScanResult;
  counter: { entries: number; max: number };
  /** Whether a file at this relative path is where files are expected. */
  expected: (relativePath: string, depth: number) => boolean;
  /** Directories that belong to other features: listed as not scanned, never entered. */
  skip?: (relativePath: string) => boolean;
};

async function walkTree(options: WalkOptions, relativeDir: string, depth: number): Promise<void> {
  const { result } = options;
  const absoluteDir = path.join(options.rootPath, ...relativeDir.split("/"));
  let dirents;
  try {
    dirents = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    result.unexpected.push({ root: options.root, relativePath: relativeDir, kind: "directory", reason: "UNREADABLE" });
    return;
  }
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const dirent of dirents) {
    if (++options.counter.entries > options.counter.max) {
      result.truncated = true;
      return;
    }
    const relativePath = `${relativeDir}/${dirent.name}`;
    const absolutePath = path.join(absoluteDir, dirent.name);
    // Dirent types come from the directory listing (lstat semantics): a link is never followed.
    if (dirent.isSymbolicLink()) {
      result.unexpected.push({ root: options.root, relativePath, kind: "symlink", reason: "SYMLINK" });
    } else if (dirent.isDirectory()) {
      if (options.skip?.(relativePath)) continue; // another feature's folder: never entered (listed once by the caller)
      else if (depth >= options.maxDepth) result.unexpected.push({ root: options.root, relativePath, kind: "directory", reason: "TOO_DEEP" });
      else await walkTree(options, relativePath, depth + 1);
    } else if (dirent.isFile()) {
      const info = await lstat(absolutePath, { bigint: true }).catch(() => null);
      if (!info || !info.isFile()) {
        result.unexpected.push({ root: options.root, relativePath, kind: "other", reason: "CHANGED_DURING_SCAN" });
        continue;
      }
      result.files.push({ root: options.root, relativePath, absolutePath, physicalId: physicalIdOf(info, absolutePath), expectedDepth: options.expected(relativePath, depth) });
    } else {
      result.unexpected.push({ root: options.root, relativePath, kind: "other", reason: "NOT_A_FILE_OR_DIRECTORY" });
    }
    if (result.truncated) return;
  }
}

async function scanTopFolder(options: WalkOptions, folder: string): Promise<void> {
  const info = await lstat(path.join(options.rootPath, folder)).catch(() => null);
  const label = `${options.root === "storage" ? "storage" : "fileStorage"}/${folder}`;
  if (!info) {
    options.result.folders.push({ relativePath: label, scanned: false, reason: "MISSING" });
  } else if (info.isSymbolicLink()) {
    options.result.folders.push({ relativePath: label, scanned: false, reason: "SYMLINK" });
    options.result.unexpected.push({ root: options.root, relativePath: folder, kind: "symlink", reason: "SYMLINK" });
  } else if (!info.isDirectory()) {
    options.result.folders.push({ relativePath: label, scanned: false, reason: "NOT_A_DIRECTORY" });
  } else {
    options.result.folders.push({ relativePath: label, scanned: true });
    await walkTree(options, folder, 1);
  }
}

/**
 * Walks storage/lectures and storage/assignments (expected layout:
 * {folder}/{id}/{file}). Links and special files are reported, never entered.
 * Public uploads are not scanned: other features (teacher images) live there.
 */
export async function scanLegacyFolders(roots: LegacyRoots, options: { maxEntries?: number } = {}): Promise<ScanResult> {
  const result: ScanResult = { files: [], unexpected: [], folders: [], truncated: false };
  const counter = { entries: 0, max: options.maxEntries ?? SCAN_MAX_ENTRIES };
  for (const folder of SCANNED_STORAGE_FOLDERS) {
    await scanTopFolder({ root: "storage", rootPath: roots.storage, maxDepth: 6, result, counter, expected: (_rel, depth) => depth === 2 }, folder);
    if (result.truncated) break;
  }
  return result;
}

/**
 * Walks the new storage's Teachers/ tree for Notes and submission files
 * (Teachers/{t}/Lectures/{l}/Notes/... and .../Assignments/...). Recorded
 * Lectures folders (Teachers/{t}/Lectures/{l}/RecordedLectures) and System/
 * belong to another feature: they are listed as not scanned and never
 * entered. A file is "expected" when its path parses as a note or submission
 * key. Links and special files are reported, never entered.
 */
export async function scanNewStorage(roots: LegacyRoots, options: { maxEntries?: number } = {}): Promise<ScanResult> {
  const result: ScanResult = { files: [], unexpected: [], folders: [], truncated: false };
  if (!roots.fileStorage) return result;
  const counter = { entries: 0, max: options.maxEntries ?? SCAN_MAX_ENTRIES };
  await scanTopFolder(
    {
      root: "fileStorage",
      rootPath: roots.fileStorage,
      maxDepth: 10,
      result,
      counter,
      expected: (rel) => parseNoteStorageKey(rel) !== null || parseSubmissionStorageKey(rel) !== null,
      skip: (rel) => /^Teachers\/[^/]+\/Lectures\/[^/]+\/RecordedLectures$/.test(rel),
    },
    "Teachers"
  );
  result.folders.push({ relativePath: "fileStorage/Teachers/*/Lectures/*/RecordedLectures", scanned: false, reason: "OTHER_FEATURE" });
  result.folders.push({ relativePath: "fileStorage/System", scanned: false, reason: "OTHER_FEATURE" });
  return result;
}
