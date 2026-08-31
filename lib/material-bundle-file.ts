import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const ALLOWED_BUNDLE_FILE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

export const MAX_BUNDLE_FILE_SIZE_BYTES = 25 * 1024 * 1024;

export type StoredBundleFile = {
  fileName: string;
  fileUrl: string;
  mimeType: string;
  sizeBytes: number;
};

function sanitizeFileName(fileName: string) {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Validates and persists an uploaded tute/paper file to local storage.
 * Returns `null` when there is no usable file on the form. Throws a plain
 * Error with a user-facing message when the file is the wrong type or size.
 */
export async function storeBundleItemFile(
  bundleId: string,
  file: FormDataEntryValue | null
): Promise<StoredBundleFile | null> {
  if (!(file instanceof File) || file.size === 0) return null;

  if (!ALLOWED_BUNDLE_FILE_MIME_TYPES.has(file.type)) {
    throw new Error("Only PDF or image files are allowed.");
  }
  if (file.size > MAX_BUNDLE_FILE_SIZE_BYTES) {
    throw new Error("File exceeds the maximum allowed size (25MB).");
  }

  const sanitized = sanitizeFileName(file.name) || "material";
  const storedName = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}-${sanitized}`;
  const relativeDir = path.join("material-bundles", bundleId);
  const absoluteDir = path.join(process.cwd(), "storage", relativeDir);
  await mkdir(absoluteDir, { recursive: true });

  const filePath = path.join(absoluteDir, storedName);
  await writeFile(filePath, Buffer.from(await file.arrayBuffer()));

  return {
    fileName: file.name,
    fileUrl: path.join(relativeDir, storedName).replace(/\\/g, "/"),
    mimeType: file.type,
    sizeBytes: file.size,
  };
}

/** Best-effort removal of a previously stored file. Never throws. */
export async function removeBundleItemFile(fileUrl: string | null | undefined) {
  if (!fileUrl) return;
  const absolutePath = path.join(process.cwd(), "storage", fileUrl);
  await unlink(absolutePath).catch(() => {});
}

/** Best-effort removal of a whole bundle's stored files. Never throws. */
export async function removeBundleDirectory(bundleId: string) {
  if (!bundleId) return;
  const dir = path.join(process.cwd(), "storage", "material-bundles", bundleId);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
