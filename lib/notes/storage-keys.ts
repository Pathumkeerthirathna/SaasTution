import { randomBytes } from "node:crypto";

import { joinStorageKey, parseStorageKey } from "@/lib/file-storage/keys";

/*
 * Lecture Notes storage keys (unified storage, Stage 2), relative to
 * FILE_STORAGE_ROOT:
 *
 *   Teachers/{teacherId}/Lectures/{lectureId}/Notes/{noteId}/{32 hex}{.ext}
 *
 * Every segment is server-side: the ids come from the database / the server
 * (noteId is generated before the upload), the file name is 128 random bits,
 * and the extension is chosen from the server-validated MIME type (never
 * from the browser's file name or any browser-supplied path). The extension
 * is kept because the download / preview routes and fileTypeFromMime derive
 * the file type and the download name from it.
 *
 * The database stores the key (Note.storageKey), never an absolute path; a
 * stored key is never recomputed. The same pattern is enforced by the CHECK
 * constraint in migration 20261115120000_add_unified_file_storage_keys.
 */

/** Ids as they appear in keys: conservative, no dots, no separators. */
export const STORAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The Notes upload MIME allow-list (NOTE + SUPPORTING_MATERIAL) mapped to the stored extension. */
export const NOTE_FILE_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-excel": ".xls",
  "text/plain": ".txt",
  "application/zip": ".zip",
});

const NOTE_STORED_NAME = /^[0-9a-f]{32}\.(pdf|png|jpg|webp|docx|doc|pptx|ppt|xlsx|xls|txt|zip)$/;

function requireId(value: unknown, what: string): string {
  if (typeof value !== "string" || !STORAGE_ID.test(value)) throw new Error(`Invalid ${what} for a storage key.`);
  return value;
}

/** The stored extension for an allowed Notes MIME type; null for anything else. */
export function noteFileExtension(mimeType: string): string | null {
  return Object.hasOwn(NOTE_FILE_EXTENSIONS, mimeType) ? NOTE_FILE_EXTENSIONS[mimeType] : null;
}

/** A new stored name: 128 random bits (hex) plus the extension of the validated MIME type. */
export function generateNoteStoredName(mimeType: string): string {
  const extension = noteFileExtension(mimeType);
  if (!extension) throw new Error("Unsupported note MIME type for storage.");
  return `${randomBytes(16).toString("hex")}${extension}`;
}

export type NoteKeyIds = { teacherId: string; lectureId: string; noteId: string };

export function noteDirectoryKey(ids: NoteKeyIds): string {
  return joinStorageKey(
    "Teachers",
    requireId(ids.teacherId, "teacher id"),
    "Lectures",
    requireId(ids.lectureId, "lecture id"),
    "Notes",
    requireId(ids.noteId, "note id")
  );
}

export function noteFileKey(ids: NoteKeyIds & { storedName: string }): string {
  if (!NOTE_STORED_NAME.test(ids.storedName)) throw new Error("Invalid stored note file name.");
  return `${noteDirectoryKey(ids)}/${ids.storedName}`;
}

/** Parses a key written by this module; null for anything else (never opened as a note file). */
export function parseNoteStorageKey(key: unknown): (NoteKeyIds & { storedName: string }) | null {
  let segments: string[];
  try {
    segments = parseStorageKey(key);
  } catch {
    return null;
  }
  if (
    segments.length !== 7 ||
    segments[0] !== "Teachers" ||
    !STORAGE_ID.test(segments[1]) ||
    segments[2] !== "Lectures" ||
    !STORAGE_ID.test(segments[3]) ||
    segments[4] !== "Notes" ||
    !STORAGE_ID.test(segments[5]) ||
    !NOTE_STORED_NAME.test(segments[6])
  ) {
    return null;
  }
  return { teacherId: segments[1], lectureId: segments[3], noteId: segments[5], storedName: segments[6] };
}

export function isNoteStorageKey(key: unknown): key is string {
  return parseNoteStorageKey(key) !== null;
}

/**
 * Rollback window (Stage 2.1 dual-write): the legacy-location copy of a note
 * stored at `storageKey`, as the pre-Stage-2 application reads it
 * (<cwd>/storage/{this path}): lectures/{lectureId}/{same random name}. It
 * never matches the old upload naming ({13-digit time}-{6 chars}-{name}), so a
 * copy is always recognisable from its key.
 */
export function noteLegacyCopyPath(storageKey: string): string {
  const parsed = parseNoteStorageKey(storageKey);
  if (!parsed) throw new Error("Invalid note storage key.");
  return `lectures/${parsed.lectureId}/${parsed.storedName}`;
}
