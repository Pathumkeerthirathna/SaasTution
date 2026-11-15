import { readStorageRootSetting, type StorageRootSettingProblem } from "./config";
import { LocalFileStorage } from "./local-file-storage";
import { isStorageError, type StorageErrorCode } from "./types";

/*
 * Unified storage (Stage 2): the generic opener for FILE_STORAGE_ROOT, shared
 * by Lecture Notes and assignment submissions. One storage engine
 * (LocalFileStorage), one validated root, one cached handle per process.
 *
 * - The root is validated by readStorageRootSetting (absolute, outside the
 *   application directory) and again by LocalFileStorage.open (real path,
 *   directory, readable / writable, not world-writable on POSIX). The
 *   application never creates or re-permissions the root itself.
 * - Below the root it creates only the shared top-level folder (Teachers/,
 *   mode 0750, never through a link). Deeper folders are created by
 *   LocalFileStorage.writeNewFile / ensureDirectory, the same way.
 * - Independent of the Recorded Lectures settings: lib/recorded-lectures/
 *   storage.ts keeps its own opener and cache unchanged. Both point at the
 *   same root and the same Teachers/ tree.
 *
 * Any problem yields { ok: false, reason }; nothing throws for a
 * configuration problem.
 */

export const SHARED_TEACHERS_DIRECTORY = "Teachers";

export type SharedStorageProblem = `ROOT_${StorageRootSettingProblem}` | StorageErrorCode;

export type SharedFileStorage = { ok: true; storage: LocalFileStorage } | { ok: false; reason: SharedStorageProblem };

/** Opens and checks the root (no cache). */
export async function openSharedFileStorage(
  env: Record<string, string | undefined> = process.env,
  appDir: string = process.cwd()
): Promise<SharedFileStorage> {
  const root = readStorageRootSetting(env, appDir);
  if (!root.ok) return { ok: false, reason: `ROOT_${root.problem}` };
  try {
    const storage = await LocalFileStorage.open({ root: root.root, appDir });
    await storage.ensureDirectory(SHARED_TEACHERS_DIRECTORY);
    return { ok: true, storage };
  } catch (error) {
    return { ok: false, reason: isStorageError(error) ? error.code : "IO_ERROR" };
  }
}

// ---- Per-process cache ---------------------------------------------------------------------------------

/*
 * The opened handle is only the validated root path, so it is cached per
 * process, keyed by the resolved root and the application directory. Only
 * successful opens are cached; the cache is dropped when the setting becomes
 * invalid or when a caller reports a ROOT_* storage error (never for a
 * per-file error such as NOT_FOUND).
 */

type CachedSharedStorage = { fingerprint: string; opening: Promise<SharedFileStorage> };

const cacheState = globalThis as unknown as { slSharedFileStorage?: CachedSharedStorage };

const ROOT_ERROR_CODES: ReadonlySet<string> = new Set<StorageErrorCode>([
  "ROOT_MISSING",
  "ROOT_NOT_DIRECTORY",
  "ROOT_INSIDE_APPLICATION",
  "ROOT_WORLD_WRITABLE",
  "ROOT_NOT_WRITABLE",
]);

export async function getSharedFileStorage(
  env: Record<string, string | undefined> = process.env,
  appDir: string = process.cwd()
): Promise<SharedFileStorage> {
  const root = readStorageRootSetting(env, appDir);
  if (!root.ok) {
    delete cacheState.slSharedFileStorage;
    return { ok: false, reason: `ROOT_${root.problem}` };
  }
  const fingerprint = JSON.stringify([root.root, appDir]);
  const cached = cacheState.slSharedFileStorage;
  if (cached && cached.fingerprint === fingerprint) return cached.opening;

  const entry: CachedSharedStorage = { fingerprint, opening: openSharedFileStorage(env, appDir) };
  cacheState.slSharedFileStorage = entry;
  const result = await entry.opening;
  if (!result.ok && cacheState.slSharedFileStorage === entry) delete cacheState.slSharedFileStorage;
  return result;
}

/** Drops the cached handle, but only for a root-level error; returns whether it did. */
export function invalidateSharedFileStorageForRootError(code: unknown): boolean {
  if (typeof code !== "string" || !ROOT_ERROR_CODES.has(code)) return false;
  delete cacheState.slSharedFileStorage;
  return true;
}

/** Tests: forget the cached handle. */
export function resetSharedFileStorageCacheForTests(): void {
  delete cacheState.slSharedFileStorage;
}
