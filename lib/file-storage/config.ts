import path from "node:path";

/*
 * FILE_STORAGE_ROOT (Recorded Lectures RL-1): the one directory new uploads
 * (recorded lectures) are stored below. It must be an absolute path OUTSIDE
 * the application directory, so a deployment that replaces the application
 * folder can never remove uploaded files, and nothing uploaded is ever
 * reachable as part of the application. Existing features keep their own
 * storage (<cwd>/storage, public/uploads) unchanged.
 *
 * This check is lexical. LocalFileStorage.open() repeats it on the real
 * (symlink-resolved) paths.
 */

export const FILE_STORAGE_ROOT_ENV = "FILE_STORAGE_ROOT";

export type StorageRootSettingProblem = "NOT_SET" | "NOT_ABSOLUTE" | "INSIDE_APPLICATION" | "CONTAINS_APPLICATION";

export type StorageRootSetting = { ok: true; root: string } | { ok: false; problem: StorageRootSettingProblem };

/** True when `child` is `parent` or below it (case-insensitive on Windows, as path.relative is). */
export function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function readStorageRootSetting(
  env: Record<string, string | undefined> = process.env,
  appDir: string = process.cwd()
): StorageRootSetting {
  const raw = env[FILE_STORAGE_ROOT_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, problem: "NOT_SET" };

  const value = raw.trim();
  if (!path.isAbsolute(value)) return { ok: false, problem: "NOT_ABSOLUTE" };

  const root = path.resolve(value);
  const app = path.resolve(appDir);
  if (isPathWithin(app, root)) return { ok: false, problem: "INSIDE_APPLICATION" };
  if (isPathWithin(root, app)) return { ok: false, problem: "CONTAINS_APPLICATION" };

  return { ok: true, root };
}
