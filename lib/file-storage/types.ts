/*
 * File storage abstraction (Recorded Lectures RL-1).
 *
 * Callers address files by a RELATIVE storage key ("/"-separated, every
 * segment server-generated and validated by lib/file-storage/keys.ts), never
 * by a filesystem path. The local implementation (local-file-storage.ts)
 * maps keys below one configured root outside the application directory; a
 * future remote Storage API can implement the same interface without the
 * feature code changing.
 *
 * Errors are StorageError with a fixed code. Messages are generic and never
 * contain paths, keys or user input.
 */

export type StorageErrorCode =
  | "ROOT_MISSING"
  | "ROOT_NOT_DIRECTORY"
  | "ROOT_INSIDE_APPLICATION"
  | "ROOT_WORLD_WRITABLE"
  | "ROOT_NOT_WRITABLE"
  | "INVALID_KEY"
  | "INVALID_ARGUMENT"
  | "UNSAFE_PATH"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "LIMIT_EXCEEDED"
  | "SIZE_MISMATCH"
  | "DEADLINE_EXCEEDED"
  | "ABORTED"
  | "NO_SPACE"
  | "IO_ERROR";

const MESSAGES: Record<StorageErrorCode, string> = {
  ROOT_MISSING: "The storage root does not exist.",
  ROOT_NOT_DIRECTORY: "The storage root is not a directory.",
  ROOT_INSIDE_APPLICATION: "The storage root must be outside the application directory.",
  ROOT_WORLD_WRITABLE: "The storage root must not be writable by every user.",
  ROOT_NOT_WRITABLE: "The storage root is not readable and writable by the application.",
  INVALID_KEY: "Invalid storage key.",
  INVALID_ARGUMENT: "Invalid storage request.",
  UNSAFE_PATH: "A storage path is a symbolic link or not of the expected type.",
  NOT_FOUND: "The stored file does not exist.",
  ALREADY_EXISTS: "The stored file already exists.",
  LIMIT_EXCEEDED: "The data is larger than allowed.",
  SIZE_MISMATCH: "The data size does not match the expected size.",
  DEADLINE_EXCEEDED: "The transfer did not finish in time.",
  ABORTED: "The transfer was aborted.",
  NO_SPACE: "There is not enough storage space.",
  IO_ERROR: "A storage operation failed.",
};

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode) {
    super(MESSAGES[code]);
    this.name = "StorageError";
    this.code = code;
  }
}

export function isStorageError(error: unknown, code?: StorageErrorCode): error is StorageError {
  return error instanceof StorageError && (code === undefined || error.code === code);
}

export type StoredFileInfo = {
  size: number;
  modifiedAtMs: number;
};

/** Inclusive byte range: bytes start..end. */
export type ByteRange = {
  start: number;
  end: number;
};

export type ByteChunkSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

export type WriteNewFileOptions = {
  /** Hard limit: more bytes than this fail with LIMIT_EXCEEDED (nothing kept). */
  maxBytes: number;
  /** When set, any other total fails with SIZE_MISMATCH (nothing kept). */
  exactBytes?: number;
  /** Epoch ms; waiting past it (even for a stalled source) fails with DEADLINE_EXCEEDED. */
  deadlineAtMs?: number;
  signal?: AbortSignal;
  /** Flush the file to disk before returning. */
  sync?: boolean;
  /** Clock (tests). */
  now?: () => number;
};

/** Random access to one stored file, for parsers that read only small parts. */
export type StoredByteSource = {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
};

export interface FileStorage {
  /** Creates the directory (and missing parents) below the root; each must be a real directory. */
  ensureDirectory(key: string): Promise<void>;
  /** Creates an empty file exclusively (ALREADY_EXISTS if anything is there). */
  createEmptyFile(key: string): Promise<void>;
  /** Streams a source into a NEW file (exclusive); on any failure the partial file is removed. */
  writeNewFile(key: string, source: ByteChunkSource, options: WriteNewFileOptions): Promise<{ bytesWritten: number }>;
  /** Cuts an existing file to `size` bytes (never extends it). */
  truncate(key: string, size: number): Promise<void>;
  /** Copies `sourceKey` onto the end of `targetKey`, then flushes the target. */
  append(targetKey: string, sourceKey: string): Promise<{ bytesAppended: number; size: number }>;
  /** Size and modification time; null when missing. */
  stat(key: string): Promise<StoredFileInfo | null>;
  /** Small random-access reads (the file stays open until close). */
  openByteSource(key: string): Promise<StoredByteSource>;
  /** Streams the file (or an inclusive range of it); never loads it into memory. */
  openRead(key: string, range?: ByteRange): Promise<{ stream: ReadableStream<Uint8Array>; size: number }>;
  /** Moves a file to a new key without ever replacing an existing file (ALREADY_EXISTS). */
  promote(fromKey: string, toKey: string): Promise<void>;
  /** Deletes a file; false when it did not exist. Never follows a link. */
  remove(key: string): Promise<boolean>;
  /** Removes an EMPTY directory; false when missing or not empty. */
  removeEmptyDirectory(key: string): Promise<boolean>;
  /** Bytes available to the application on the storage filesystem. */
  freeBytes(): Promise<number>;
}
