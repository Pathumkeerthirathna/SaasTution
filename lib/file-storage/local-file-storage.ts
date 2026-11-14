import { constants as fsConstants } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  stat as statPath,
  statfs,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { isPathWithin } from "./config";
import { parseStorageKey } from "./keys";
import {
  StorageError,
  type ByteChunkSource,
  type ByteRange,
  type FileStorage,
  type StoredByteSource,
  type StoredFileInfo,
  type WriteNewFileOptions,
} from "./types";

/*
 * Local filesystem storage below FILE_STORAGE_ROOT (Recorded Lectures RL-1).
 * New code; it follows the protections of lib/breakout-activities/storage.ts
 * without changing that module.
 *
 * Root (checked once in open()):
 * - must exist and be a directory; it is resolved with realpath and that
 *   resolved root is trusted (it may itself be a symlink to a data volume);
 * - the resolved root must be outside the resolved application directory,
 *   and must not contain it;
 * - must be readable and writable by this process and (POSIX) not
 *   world-writable.
 *
 * Below the root:
 * - every key is validated (lib/file-storage/keys.ts) and resolved inside
 *   the root; every directory component must be a real directory (never a
 *   symlink); directories are created one level at a time (mode 0750) and
 *   re-checked;
 * - new files are created exclusively (O_CREAT | O_EXCL, mode 0640) with
 *   O_NOFOLLOW where the platform has it;
 * - an existing file is opened only after lstat shows a regular file with
 *   exactly one name (nlink 1: a hard link planted in the storage folder,
 *   possibly to a file outside it, is refused), then fstat must show the
 *   same device and inode and still one name (on Windows, without
 *   O_NOFOLLOW, this is what detects a file swapped for a link);
 * - removal never follows a link: a link where a file is expected is
 *   refused, not deleted.
 *
 * Remaining limitation (as in the breakout storage): Node has no
 * openat()/O_PATH, so checks work on path names; a component swapped for a
 * link in the instant between a check and the next operation is not
 * excluded. Doing that needs write access to the storage root.
 *
 * Nothing here reads a whole file into memory: writes consume a stream
 * chunk by chunk, appends copy in fixed blocks, reads stream.
 */

const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
const DIRECTORY_MODE = 0o750;
const FILE_MODE = 0o640;
const COPY_BLOCK_BYTES = 1024 * 1024;
const READ_STREAM_HIGH_WATER_MARK = 64 * 1024;
const IS_WINDOWS = process.platform === "win32";

const errnoCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

function toStorageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  switch (errnoCode(error)) {
    case "ENOENT":
      return new StorageError("NOT_FOUND");
    case "EEXIST":
      return new StorageError("ALREADY_EXISTS");
    case "ENOSPC":
    case "EDQUOT":
      return new StorageError("NO_SPACE");
    case "ELOOP":
    case "ENOTDIR":
      return new StorageError("UNSAFE_PATH");
    default:
      return new StorageError("IO_ERROR");
  }
}

function assertSafeInteger(value: unknown, min: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new StorageError("INVALID_ARGUMENT");
  }
}

function sameFile(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  // Some filesystems report 0 for both; then only the lstat type check applies.
  if (a.ino === 0 && b.ino === 0) return a.dev === b.dev;
  return a.dev === b.dev && a.ino === b.ino;
}

async function closeQuietly(handle: FileHandle | undefined) {
  if (handle) await handle.close().catch(() => {});
}

/** Iterates a web stream or async iterable, failing on abort or once the deadline passes (even while waiting). */
async function* chunksWithLimits(
  source: ByteChunkSource,
  options: { deadlineAtMs?: number; signal?: AbortSignal; now: () => number }
): AsyncGenerator<Uint8Array> {
  const iterator: AsyncIterator<Uint8Array> =
    typeof (source as ReadableStream<Uint8Array>).getReader === "function"
      ? readerIterator((source as ReadableStream<Uint8Array>).getReader())
      : (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();

  let finished = false;
  try {
    for (;;) {
      if (options.signal?.aborted) throw new StorageError("ABORTED");
      if (options.deadlineAtMs !== undefined && options.now() >= options.deadlineAtMs) {
        throw new StorageError("DEADLINE_EXCEEDED");
      }
      const result = await nextWithLimits(iterator, options);
      if (result.done) {
        finished = true;
        return;
      }
      if (!(result.value instanceof Uint8Array)) throw new StorageError("INVALID_ARGUMENT");
      yield result.value;
    }
  } finally {
    // Not awaited: a source stuck mid-await (the reason for a deadline) would
    // never settle its return(), and the write must fail now, not wait for it.
    if (!finished) Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

function readerIterator(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncIterator<Uint8Array> {
  return {
    next: () => reader.read() as Promise<IteratorResult<Uint8Array>>,
    return: async () => {
      await reader.cancel().catch(() => undefined);
      return { done: true, value: undefined };
    },
  };
}

function nextWithLimits(
  iterator: AsyncIterator<Uint8Array>,
  options: { deadlineAtMs?: number; signal?: AbortSignal; now: () => number }
): Promise<IteratorResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(() => reject(new StorageError("ABORTED")));
    const finish = (settle: () => void) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      settle();
    };
    if (options.deadlineAtMs !== undefined) {
      const wait = Math.max(0, options.deadlineAtMs - options.now());
      timer = setTimeout(() => finish(() => reject(new StorageError("DEADLINE_EXCEEDED"))), wait);
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error instanceof StorageError ? error : new StorageError("IO_ERROR")))
    );
  });
}

export type LocalFileStorageOpenOptions = {
  /** Absolute path (FILE_STORAGE_ROOT). */
  root: string;
  /** The application directory the root must stay outside of (default: process.cwd()). */
  appDir?: string;
};

export class LocalFileStorage implements FileStorage {
  private constructor(private readonly root: string) {}

  /** Opens (never creates) the configured root after checking it; see the module comment. */
  static async open(options: LocalFileStorageOpenOptions): Promise<LocalFileStorage> {
    if (typeof options.root !== "string" || !path.isAbsolute(options.root)) throw new StorageError("INVALID_ARGUMENT");

    let root: string;
    try {
      root = await realpath(options.root);
    } catch (error) {
      throw errnoCode(error) === "ENOENT" ? new StorageError("ROOT_MISSING") : new StorageError("IO_ERROR");
    }

    const info = await statPath(root).catch(() => null);
    if (!info) throw new StorageError("ROOT_MISSING");
    if (!info.isDirectory()) throw new StorageError("ROOT_NOT_DIRECTORY");

    const appDir = await realpath(options.appDir ?? process.cwd()).catch(() => path.resolve(options.appDir ?? process.cwd()));
    if (isPathWithin(appDir, root) || isPathWithin(root, appDir)) throw new StorageError("ROOT_INSIDE_APPLICATION");

    if (!IS_WINDOWS && (info.mode & 0o002) !== 0) throw new StorageError("ROOT_WORLD_WRITABLE");

    try {
      await access(root, fsConstants.R_OK | fsConstants.W_OK);
    } catch {
      throw new StorageError("ROOT_NOT_WRITABLE");
    }

    return new LocalFileStorage(root);
  }

  // ---- Paths ------------------------------------------------------------------------------------

  private resolve(key: string): string {
    const absolute = path.join(this.root, ...parseStorageKey(key));
    if (absolute === this.root || !isPathWithin(this.root, absolute)) throw new StorageError("INVALID_KEY");
    return absolute;
  }

  /** Absolute paths of each directory from just below the root down to `targetDir`. */
  private directoriesBelowRoot(targetDir: string): string[] {
    if (targetDir === this.root) return [];
    const relative = path.relative(this.root, targetDir);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new StorageError("UNSAFE_PATH");
    const parts = relative.split(path.sep);
    return parts.map((_, index) => path.join(this.root, ...parts.slice(0, index + 1)));
  }

  private async assertRealDirectory(dir: string) {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new StorageError("UNSAFE_PATH");
  }

  /** True when every directory exists and is real; false at the first missing one. */
  private async directoryChainExists(targetDir: string): Promise<boolean> {
    for (const dir of this.directoriesBelowRoot(targetDir)) {
      try {
        await this.assertRealDirectory(dir);
      } catch (error) {
        if (errnoCode(error) === "ENOENT") return false;
        throw toStorageError(error);
      }
    }
    return true;
  }

  private async ensureDirectoryChain(targetDir: string) {
    for (const dir of this.directoriesBelowRoot(targetDir)) {
      try {
        await mkdir(dir, { mode: DIRECTORY_MODE });
      } catch (error) {
        if (errnoCode(error) !== "EEXIST") throw toStorageError(error);
      }
      try {
        await this.assertRealDirectory(dir);
      } catch (error) {
        throw toStorageError(error);
      }
    }
  }

  /** Opens an existing regular file (never through a link); fstat must match the lstat taken first. */
  private async openExisting(absolute: string, flags: number): Promise<FileHandle> {
    if (!(await this.directoryChainExists(path.dirname(absolute)))) throw new StorageError("NOT_FOUND");
    let before;
    try {
      before = await lstat(absolute);
    } catch (error) {
      throw toStorageError(error);
    }
    // nlink !== 1: a hard link (possibly to a file outside the root) is refused; see RL-1.1.
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new StorageError("UNSAFE_PATH");

    let handle: FileHandle | undefined;
    try {
      handle = await open(absolute, flags | O_NOFOLLOW);
      const after = await handle.stat();
      if (!after.isFile() || !sameFile(before, after) || after.nlink !== 1) throw new StorageError("UNSAFE_PATH");
      return handle;
    } catch (error) {
      await closeQuietly(handle);
      throw toStorageError(error);
    }
  }

  private async createExclusive(absolute: string): Promise<FileHandle> {
    await this.ensureDirectoryChain(path.dirname(absolute));
    try {
      return await open(absolute, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, FILE_MODE);
    } catch (error) {
      throw toStorageError(error);
    }
  }

  /** Unlinks a file this call created, only through a still-safe folder; never throws. */
  private async discardCreated(absolute: string) {
    try {
      if (await this.directoryChainExists(path.dirname(absolute))) {
        const info = await lstat(absolute);
        if (info.isFile()) await unlink(absolute);
      }
    } catch {
      /* best effort: an abandoned file is found by the maintenance service */
    }
  }

  // ---- FileStorage ------------------------------------------------------------------------------

  async ensureDirectory(key: string): Promise<void> {
    await this.ensureDirectoryChain(this.resolve(key));
  }

  async createEmptyFile(key: string): Promise<void> {
    const handle = await this.createExclusive(this.resolve(key));
    await closeQuietly(handle);
  }

  async writeNewFile(key: string, source: ByteChunkSource, options: WriteNewFileOptions): Promise<{ bytesWritten: number }> {
    assertSafeInteger(options.maxBytes, 0);
    if (options.exactBytes !== undefined) {
      assertSafeInteger(options.exactBytes, 0);
      if (options.exactBytes > options.maxBytes) throw new StorageError("INVALID_ARGUMENT");
    }
    if (options.signal?.aborted) throw new StorageError("ABORTED");

    const absolute = this.resolve(key);
    const handle = await this.createExclusive(absolute);
    const now = options.now ?? Date.now;
    let written = 0;
    try {
      for await (const chunk of chunksWithLimits(source, { deadlineAtMs: options.deadlineAtMs, signal: options.signal, now })) {
        if (written + chunk.byteLength > options.maxBytes) throw new StorageError("LIMIT_EXCEEDED");
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, written + offset);
          if (bytesWritten <= 0) throw new StorageError("IO_ERROR");
          offset += bytesWritten;
        }
        written += chunk.byteLength;
      }
      if (options.exactBytes !== undefined && written !== options.exactBytes) throw new StorageError("SIZE_MISMATCH");
      if (options.sync) await handle.sync();
      await handle.close();
      return { bytesWritten: written };
    } catch (error) {
      await closeQuietly(handle);
      await this.discardCreated(absolute);
      throw toStorageError(error);
    }
  }

  async truncate(key: string, size: number): Promise<void> {
    assertSafeInteger(size, 0);
    const handle = await this.openExisting(this.resolve(key), fsConstants.O_RDWR);
    try {
      const { size: current } = await handle.stat();
      if (size > current) throw new StorageError("INVALID_ARGUMENT");
      if (size < current) await handle.truncate(size);
    } catch (error) {
      throw toStorageError(error);
    } finally {
      await closeQuietly(handle);
    }
  }

  async append(targetKey: string, sourceKey: string): Promise<{ bytesAppended: number; size: number }> {
    const target = await this.openExisting(this.resolve(targetKey), fsConstants.O_WRONLY);
    let source: FileHandle | undefined;
    try {
      source = await this.openExisting(this.resolve(sourceKey), fsConstants.O_RDONLY);
      const start = (await target.stat()).size;
      const buffer = new Uint8Array(COPY_BLOCK_BYTES);
      let copied = 0;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, copied);
        if (bytesRead === 0) break;
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await target.write(buffer, offset, bytesRead - offset, start + copied + offset);
          if (bytesWritten <= 0) throw new StorageError("IO_ERROR");
          offset += bytesWritten;
        }
        copied += bytesRead;
      }
      await target.sync();
      return { bytesAppended: copied, size: start + copied };
    } catch (error) {
      throw toStorageError(error);
    } finally {
      await closeQuietly(source);
      await closeQuietly(target);
    }
  }

  async stat(key: string): Promise<StoredFileInfo | null> {
    const absolute = this.resolve(key);
    if (!(await this.directoryChainExists(path.dirname(absolute)))) return null;
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return null;
      throw toStorageError(error);
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new StorageError("UNSAFE_PATH");
    return { size: info.size, modifiedAtMs: info.mtimeMs };
  }

  async openByteSource(key: string): Promise<StoredByteSource> {
    const handle = await this.openExisting(this.resolve(key), fsConstants.O_RDONLY);
    let size: number;
    try {
      size = (await handle.stat()).size;
    } catch (error) {
      await closeQuietly(handle);
      throw toStorageError(error);
    }
    let closed = false;
    return {
      size,
      async read(offset: number, length: number): Promise<Uint8Array> {
        if (closed) throw new StorageError("INVALID_ARGUMENT");
        assertSafeInteger(offset, 0);
        assertSafeInteger(length, 0);
        if (offset + length > size) throw new StorageError("INVALID_ARGUMENT");
        const buffer = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled).catch((error) => {
            throw toStorageError(error);
          });
          if (bytesRead === 0) throw new StorageError("SIZE_MISMATCH"); // the file shrank
          filled += bytesRead;
        }
        return buffer;
      },
      async close() {
        if (closed) return;
        closed = true;
        await closeQuietly(handle);
      },
    };
  }

  async openRead(key: string, range?: ByteRange): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
    const handle = await this.openExisting(this.resolve(key), fsConstants.O_RDONLY);
    try {
      const { size } = await handle.stat();
      let start = 0;
      let end = size - 1;
      if (range) {
        assertSafeInteger(range.start, 0);
        assertSafeInteger(range.end, 0);
        if (range.start > range.end || range.end >= size) throw new StorageError("INVALID_ARGUMENT");
        start = range.start;
        end = range.end;
      }
      if (size === 0 || end < start) {
        await closeQuietly(handle);
        return { stream: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }), size };
      }
      // autoClose: the handle closes when the stream ends, errors or is cancelled.
      const nodeStream = handle.createReadStream({ start, end, highWaterMark: READ_STREAM_HIGH_WATER_MARK, autoClose: true });
      return { stream: Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>, size };
    } catch (error) {
      await closeQuietly(handle);
      throw toStorageError(error);
    }
  }

  async promote(fromKey: string, toKey: string): Promise<void> {
    const from = this.resolve(fromKey);
    const to = this.resolve(toKey);

    // The source must be an existing regular file reached through real directories.
    const handle = await this.openExisting(from, fsConstants.O_RDONLY);
    await closeQuietly(handle);

    const targetDir = path.dirname(to);
    await this.ensureDirectoryChain(targetDir);

    try {
      // A hard link fails with EEXIST instead of replacing an existing file.
      await link(from, to);
    } catch (error) {
      const code = errnoCode(error);
      if (code === "EEXIST") throw new StorageError("ALREADY_EXISTS");
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") throw toStorageError(error);
      // Filesystems without hard links: rename after confirming nothing is there.
      try {
        await lstat(to);
        throw new StorageError("ALREADY_EXISTS");
      } catch (statError) {
        if (statError instanceof StorageError) throw statError;
        if (errnoCode(statError) !== "ENOENT") throw toStorageError(statError);
      }
      try {
        await rename(from, to);
        return;
      } catch (renameError) {
        throw toStorageError(renameError);
      }
    }

    // The folder must not have been swapped while linking.
    if (!(await this.directoryChainExists(targetDir)) || (await realpath(targetDir)) !== targetDir) {
      throw new StorageError("UNSAFE_PATH");
    }
    try {
      await unlink(from);
    } catch {
      // Both names refer to the file; every file must have exactly one name
      // (openExisting refuses nlink !== 1), so undo the new name and fail:
      // the caller still has the source and may retry.
      await unlink(to).catch(() => undefined);
      throw new StorageError("IO_ERROR");
    }
  }

  async remove(key: string): Promise<boolean> {
    const absolute = this.resolve(key);
    if (!(await this.directoryChainExists(path.dirname(absolute)))) return false;
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return false;
      throw toStorageError(error);
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new StorageError("UNSAFE_PATH");
    try {
      await unlink(absolute);
      return true;
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return false;
      throw toStorageError(error);
    }
  }

  async removeEmptyDirectory(key: string): Promise<boolean> {
    const absolute = this.resolve(key);
    if (!(await this.directoryChainExists(path.dirname(absolute)))) return false;
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return false;
      throw toStorageError(error);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new StorageError("UNSAFE_PATH");
    try {
      await rmdir(absolute);
      return true;
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return false;
      throw toStorageError(error);
    }
  }

  async freeBytes(): Promise<number> {
    try {
      const info = await statfs(this.root);
      const free = Number(info.bavail) * Number(info.bsize);
      return Number.isFinite(free) && free >= 0 ? free : 0;
    } catch (error) {
      throw toStorageError(error);
    }
  }
}
