/*
 * Recorded Lectures RL-3.3: directory flush after a new file
 * (lib/file-storage/local-file-storage.ts: syncDirectoryPath and
 * writeNewFile({ syncDirectory: true })), so a committed chunk's file name
 * survives a crash.
 *
 * Platform behaviour (verified): on POSIX (Linux, production) the directory
 * is opened read-only and fsync'ed; a failure fails the write and removes the
 * file. On Windows, Node.js can open a directory but fsync on it fails with
 * EPERM, so it is not supported: syncDirectoryPath returns false and
 * writeNewFile reports directorySynced: false (development only).
 *
 *   npm run test:recorded-lectures
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { LocalFileStorage, DIRECTORY_SYNC_SUPPORTED, syncDirectoryPath } = require(path.join(root, "lib", "file-storage", "local-file-storage.ts"));

const IS_WINDOWS = process.platform === "win32";

async function withStorage(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl33-dirsync-"));
  try {
    const storage = await LocalFileStorage.open({ root: dir, appDir: root });
    await fn(storage, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function* chunks(...parts) {
  for (const part of parts) yield new TextEncoder().encode(part);
}

test("platform: directory fsync is supported everywhere except Windows", () => {
  assert.equal(DIRECTORY_SYNC_SUPPORTED, !IS_WINDOWS);
});

test("syncDirectoryPath: flushes a real directory on POSIX; reports false (does nothing) on Windows", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl33-dirsync-"));
  try {
    assert.equal(await syncDirectoryPath(dir), !IS_WINDOWS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows: the underlying limitation is real (fsync on a directory handle fails with EPERM)", { skip: !IS_WINDOWS && "Windows-only check" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl33-dirsync-"));
  const handle = await fsp.open(dir, "r");
  try {
    await assert.rejects(handle.sync(), { code: "EPERM" });
  } finally {
    await handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POSIX: a directory that cannot be opened makes syncDirectoryPath throw (the caller fails the write)", { skip: IS_WINDOWS && "POSIX-only: Windows does not flush directories" }, async () => {
  await assert.rejects(syncDirectoryPath(path.join(os.tmpdir(), "rl33-does-not-exist", "x")));
});

test("writeNewFile: syncDirectory reports whether the directory was flushed; the file is intact either way", async () => {
  await withStorage(async (storage, dir) => {
    const synced = await storage.writeNewFile("a/synced", chunks("abc"), { maxBytes: 3, exactBytes: 3, sync: true, syncDirectory: true });
    assert.deepEqual(synced, { bytesWritten: 3, directorySynced: !IS_WINDOWS });
    assert.equal(fs.readFileSync(path.join(dir, "a", "synced"), "utf8"), "abc");

    const plain = await storage.writeNewFile("a/plain", chunks("xy"), { maxBytes: 2, sync: true });
    assert.deepEqual(plain, { bytesWritten: 2, directorySynced: false }, "not requested: not done");
  });
});

test("writeNewFile: a failed write with syncDirectory still leaves nothing behind", async () => {
  await withStorage(async (storage, dir) => {
    await assert.rejects(
      storage.writeNewFile("a/short", chunks("ab"), { maxBytes: 3, exactBytes: 3, sync: true, syncDirectory: true }),
      { name: "StorageError", code: "SIZE_MISMATCH" }
    );
    assert.ok(!fs.existsSync(path.join(dir, "a", "short")));
  });
});
