import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { sanitizeUploadFileName } from "@/lib/payment-validation";

export const ALLOWED_PAPER_FILE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export const MAX_PAPER_FILE_SIZE_BYTES = 25 * 1024 * 1024;

export type StoredFile = {
  fileName: string;
  fileUrl: string;
  mimeType: string;
  sizeBytes: number;
};

export function assertPaperFile(file: File) {
  if (!ALLOWED_PAPER_FILE_MIME_TYPES.has(file.type)) {
    return "Only PDF, PNG, JPG and WEBP files are allowed.";
  }
  if (file.size > MAX_PAPER_FILE_SIZE_BYTES) {
    return "The file exceeds the 25 MB size limit.";
  }
  return null;
}

/**
 * Persists an uploaded paper/submission file under `storage/class-papers/...`
 * and returns the DB-facing metadata (the URL is the path relative to
 * `storage/`, matching how other file routes resolve stored files).
 */
export async function storePaperFile(
  file: File,
  segments: string[]
): Promise<StoredFile> {
  const safeName = sanitizeUploadFileName(file.name || "file") || "file";
  const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  const relDir = path.join("class-papers", ...segments);
  const absDir = path.join(process.cwd(), "storage", relDir);
  await mkdir(absDir, { recursive: true });
  await writeFile(path.join(absDir, storedName), new Uint8Array(await file.arrayBuffer()));

  return {
    fileName: file.name || safeName,
    fileUrl: path.join(relDir, storedName).split(path.sep).join("/"),
    mimeType: file.type,
    sizeBytes: file.size,
  };
}

export function resolveStoredFilePath(fileUrl: string) {
  const root = path.join(process.cwd(), "storage");
  const filePath = path.join(root, fileUrl);
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return filePath;
}
