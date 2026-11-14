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
