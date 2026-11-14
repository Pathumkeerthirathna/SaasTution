import { readStorageRootSetting, type StorageRootSettingProblem } from "@/lib/file-storage/config";
import { LocalFileStorage } from "@/lib/file-storage/local-file-storage";
import { isStorageError, type StorageErrorCode } from "@/lib/file-storage/types";

import { loadRecordedLectureConfig, type RecordedLectureConfig } from "./config";
import { TEACHERS_DIRECTORY, TEMPORARY_UPLOADS_DIRECTORY } from "./keys";

/*
 * Opens the recorded-lecture storage (RL-1): validates every setting and
 * FILE_STORAGE_ROOT, opens the root (it must already exist: the application
 * never creates or re-permissions the root itself, that is an operator
 * decision), then creates the feature's own directories below it
 * (Teachers/, System/TemporaryUploads/, mode 0750) if missing.
 *
 * Any problem yields { ok: false, reason } and the feature reports "not
 * configured"; nothing throws for a configuration problem and the rest of
 * the application is unaffected.
 */

export type RecordedLectureStorageProblem =
  | "INVALID_CONFIGURATION"
  | `ROOT_${StorageRootSettingProblem}`
  | StorageErrorCode;

export type RecordedLectureStorage =
  | { ok: true; storage: LocalFileStorage; config: RecordedLectureConfig }
  | { ok: false; reason: RecordedLectureStorageProblem };

export async function openRecordedLectureStorage(
  env: Record<string, string | undefined> = process.env,
  appDir: string = process.cwd()
): Promise<RecordedLectureStorage> {
  const loaded = loadRecordedLectureConfig(env);
  if (!loaded.ok) return { ok: false, reason: "INVALID_CONFIGURATION" };

  const root = readStorageRootSetting(env, appDir);
  if (!root.ok) return { ok: false, reason: `ROOT_${root.problem}` };

  try {
    const storage = await LocalFileStorage.open({ root: root.root, appDir });
    await storage.ensureDirectory(TEACHERS_DIRECTORY);
    await storage.ensureDirectory(TEMPORARY_UPLOADS_DIRECTORY);
    return { ok: true, storage, config: loaded.config };
  } catch (error) {
    return { ok: false, reason: isStorageError(error) ? error.code : "IO_ERROR" };
  }
}

// ---- Per-process cached handle (RL-4.3 playback) -------------------------------------------------

/*
 * Playback opens storage on every Range request; re-validating the root
 * (realpath, stat, access, two mkdirs) each time is wasted work. The opened
 * LocalFileStorage is only the validated root path, so it is cached per
 * process, keyed by the resolved FILE_STORAGE_ROOT, the application directory
 * and the full recorded-lecture configuration: any change to them opens a
 * new handle.
 *
 * Only successful opens are cached (a failed open is retried by the next
 * call). The cache is dropped only for genuine root / configuration errors:
 * the settings becoming invalid, or invalidateRecordedLectureStorageForRootError()
 * with a ROOT_* storage error. A per-file error (NOT_FOUND, SIZE_MISMATCH,
 * UNSAFE_PATH, IO_ERROR...) never invalidates it.
 *
 * The upload, completion and maintenance services keep calling
 * openRecordedLectureStorage() directly (unchanged). A root moved or
 * re-pointed (symlink) while the server runs is picked up after a restart.
 */

type CachedStorage = { fingerprint: string; opening: Promise<RecordedLectureStorage> };

const cacheState = globalThis as unknown as { slRecordedLectureStorage?: CachedStorage };

const ROOT_ERROR_CODES: ReadonlySet<string> = new Set<StorageErrorCode>([
  "ROOT_MISSING",
  "ROOT_NOT_DIRECTORY",
  "ROOT_INSIDE_APPLICATION",
  "ROOT_WORLD_WRITABLE",
  "ROOT_NOT_WRITABLE",
]);

/** True for a storage error code that means the root itself is unusable (never for a per-file error). */
export function isStorageRootErrorCode(code: unknown): boolean {
  return typeof code === "string" && ROOT_ERROR_CODES.has(code);
}

/** The cached storage for this process (opened on first use, or after the settings changed). */
export async function getRecordedLectureStorage(
  env: Record<string, string | undefined> = process.env,
  appDir: string = process.cwd()
): Promise<RecordedLectureStorage> {
  const loaded = loadRecordedLectureConfig(env);
  const root = readStorageRootSetting(env, appDir);
  // Settings that became invalid are a genuine configuration error: drop the cache.
  if (!loaded.ok) {
    delete cacheState.slRecordedLectureStorage;
    return { ok: false, reason: "INVALID_CONFIGURATION" };
  }
  if (!root.ok) {
    delete cacheState.slRecordedLectureStorage;
    return { ok: false, reason: `ROOT_${root.problem}` };
  }

  const fingerprint = JSON.stringify([root.root, appDir, loaded.config]);
  const cached = cacheState.slRecordedLectureStorage;
  if (cached && cached.fingerprint === fingerprint) return cached.opening;

  const entry: CachedStorage = { fingerprint, opening: openRecordedLectureStorage(env, appDir) };
  cacheState.slRecordedLectureStorage = entry;
  const result = await entry.opening;
  // Never keep a failure: the next call tries again.
  if (!result.ok && cacheState.slRecordedLectureStorage === entry) delete cacheState.slRecordedLectureStorage;
  return result;
}

/** Drops the cached handle, but only for a ROOT_* error; returns whether it did. */
export function invalidateRecordedLectureStorageForRootError(code: unknown): boolean {
  if (!isStorageRootErrorCode(code)) return false;
  delete cacheState.slRecordedLectureStorage;
  return true;
}

/** Tests: forget the cached handle. */
export function resetRecordedLectureStorageCacheForTests(): void {
  delete cacheState.slRecordedLectureStorage;
}
