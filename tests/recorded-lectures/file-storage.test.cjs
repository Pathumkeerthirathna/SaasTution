/*
 * Recorded Lectures RL-1: the storage layer
 * (lib/file-storage/local-file-storage.ts, keys.ts, config.ts) and the
 * feature's storage opener (lib/recorded-lectures/storage.ts).
 *
 *   npm run test:recorded-lectures
 *
 * Real filesystem, in fresh temporary folders (never the repository).
 * Symbolic-link cases use junctions / links where the platform allows them
 * and are skipped otherwise.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { LocalFileStorage } = require(path.join(root, "lib", "file-storage", "local-file-storage.ts"));
const { parseStorageKey, isValidStorageKey, joinStorageKey, parentStorageKey } = require(path.join(root, "lib", "file-storage", "keys.ts"));
const { readStorageRootSetting, isPathWithin } = require(path.join(root, "lib", "file-storage", "config.ts"));
const { StorageError } = require(path.join(root, "lib", "file-storage", "types.ts"));
const { openRecordedLectureStorage } = require(path.join(root, "lib", "recorded-lectures", "storage.ts"));

const IS_WINDOWS = process.platform === "win32";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withStorage(fn) {
  const storageRoot = tempDir("rl1-root-");
  const appDir = tempDir("rl1-app-");
  try {
    const storage = await LocalFileStorage.open({ root: storageRoot, appDir });
    await fn(storage, storageRoot);
  } finally {
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(appDir, { recursive: true, force: true });
  }
}

async function* chunks(...parts) {
  for (const part of parts) yield typeof part === "string" ? new TextEncoder().encode(part) : part;
}

const code = (c) => (error) => error instanceof StorageError && error.code === c;
const read = (dir, key) => fs.readFileSync(path.join(dir, ...key.split("/")));

// ---- Keys ---------------------------------------------------------------------------------------------

test("keys: safe relative keys accepted; traversal, absolute, drive, backslash, empty, device and odd names refused", () => {
  for (const key of ["a", "Teachers/abc/Lectures", "System/TemporaryUploads/x.part", "A_b-c.d/e9"]) {
    assert.deepEqual(parseStorageKey(key), key.split("/"));
    assert.equal(isValidStorageKey(key), true);
  }
  const bad = [
    "", "/", "/abs", "a/", "/a", "a//b", ".", "..", "../x", "a/../b", "a/./b", "a\\b", "..\\x", "C:", "C:/x", "c:x",
    "a/b/", ".hidden", "-dash", "con", "NUL.txt", "a/com1", "lpt9.mp4", "trailing.", "sp ace", "ü", "a\0b", "x".repeat(129),
    Array.from({ length: 17 }, () => "a").join("/"), "a".repeat(513),
  ];
  for (const key of bad) assert.equal(isValidStorageKey(key), false, JSON.stringify(key));
  assert.equal(isValidStorageKey(42), false);
  assert.throws(() => parseStorageKey("../x"), code("INVALID_KEY"));
  assert.equal(joinStorageKey("a", "b"), "a/b");
  assert.throws(() => joinStorageKey("a", ".."), code("INVALID_KEY"));
  assert.equal(parentStorageKey("a/b/c"), "a/b");
  assert.equal(parentStorageKey("a"), null);
});

// ---- Root configuration -------------------------------------------------------------------------------

test("FILE_STORAGE_ROOT: required, absolute, outside the application and not containing it", () => {
  const app = path.resolve(os.tmpdir(), "slc-app");
  assert.deepEqual(readStorageRootSetting({}, app), { ok: false, problem: "NOT_SET" });
  assert.deepEqual(readStorageRootSetting({ FILE_STORAGE_ROOT: "  " }, app), { ok: false, problem: "NOT_SET" });
  assert.deepEqual(readStorageRootSetting({ FILE_STORAGE_ROOT: "relative/files" }, app), { ok: false, problem: "NOT_ABSOLUTE" });
  assert.deepEqual(readStorageRootSetting({ FILE_STORAGE_ROOT: path.join(app, "storage") }, app), { ok: false, problem: "INSIDE_APPLICATION" });
  assert.deepEqual(readStorageRootSetting({ FILE_STORAGE_ROOT: app }, app), { ok: false, problem: "INSIDE_APPLICATION" });
  assert.deepEqual(readStorageRootSetting({ FILE_STORAGE_ROOT: path.dirname(app) }, app), { ok: false, problem: "CONTAINS_APPLICATION" });
  const outside = path.resolve(os.tmpdir(), "SLClassRoomFiles");
  assert.deepEqual(readStorageRootSetting({ FILE_STORAGE_ROOT: ` ${outside} ` }, app), { ok: true, root: outside });
  assert.equal(isPathWithin(app, path.join(app, "x")), true);
  assert.equal(isPathWithin(app, path.join(app, "..", "x")), false);
});

test("open: root must exist, be a directory, be outside the application (also via links), be writable", async () => {
  const appDir = tempDir("rl1-app-");
  const parent = tempDir("rl1-parent-");
  try {
    await assert.rejects(LocalFileStorage.open({ root: path.join(parent, "missing"), appDir }), code("ROOT_MISSING"));
    fs.writeFileSync(path.join(parent, "file"), "x");
    await assert.rejects(LocalFileStorage.open({ root: path.join(parent, "file"), appDir }), code("ROOT_NOT_DIRECTORY"));
    fs.mkdirSync(path.join(appDir, "inner"));
    await assert.rejects(LocalFileStorage.open({ root: path.join(appDir, "inner"), appDir }), code("ROOT_INSIDE_APPLICATION"));
    await assert.rejects(LocalFileStorage.open({ root: parent, appDir: path.join(parent, "app-below") }), code("ROOT_INSIDE_APPLICATION"));
    await assert.rejects(LocalFileStorage.open({ root: "relative", appDir }), code("INVALID_ARGUMENT"));

    const ok = path.join(parent, "ok");
    fs.mkdirSync(ok);
    assert.ok(await LocalFileStorage.open({ root: ok, appDir }));
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("open: a root that is a link INTO the application directory is refused after resolving it", async (t) => {
  const appDir = tempDir("rl1-app-");
  const parent = tempDir("rl1-parent-");
  try {
    fs.mkdirSync(path.join(appDir, "inner"));
    const linkPath = path.join(parent, "link-to-app");
    try {
      fs.symlinkSync(path.join(appDir, "inner"), linkPath, "junction");
    } catch (error) {
      t.skip(`directory links cannot be created by this account (${error.code})`);
      return;
    }
    await assert.rejects(LocalFileStorage.open({ root: linkPath, appDir }), code("ROOT_INSIDE_APPLICATION"));
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test(
  "open (Linux/POSIX): a world-writable root is refused",
  { skip: IS_WINDOWS && "POSIX permission bits do not exist on Windows; run on Linux" },
  async () => {
    const appDir = tempDir("rl1-app-");
    const parent = tempDir("rl1-parent-");
    try {
      const open = path.join(parent, "world");
      fs.mkdirSync(open);
      fs.chmodSync(open, 0o777);
      await assert.rejects(LocalFileStorage.open({ root: open, appDir }), code("ROOT_WORLD_WRITABLE"));
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }
);

test(
  "layout (Linux/POSIX): created folders are 0750 (before umask), files 0640",
  { skip: IS_WINDOWS && "POSIX permission bits do not exist on Windows; run on Linux" },
  async () => {
    await withStorage(async (storage, dir) => {
      await storage.createEmptyFile("Teachers/x/file");
      const umask = process.umask();
      assert.equal(fs.statSync(path.join(dir, "Teachers")).mode & 0o777, 0o750 & ~umask);
      assert.equal(fs.statSync(path.join(dir, "Teachers", "x", "file")).mode & 0o777, 0o640 & ~umask);
    });
  }
);

test("openRecordedLectureStorage: not configured / invalid settings report a reason; configured creates the layout", async () => {
  const appDir = tempDir("rl1-app-");
  const storageRoot = tempDir("rl1-root-");
  try {
    assert.deepEqual(await openRecordedLectureStorage({}, appDir), { ok: false, reason: "ROOT_NOT_SET" });
    assert.deepEqual(
      await openRecordedLectureStorage({ FILE_STORAGE_ROOT: storageRoot, RECORDED_LECTURE_CHUNK_BYTES: "abc" }, appDir),
      { ok: false, reason: "INVALID_CONFIGURATION" }
    );
    assert.deepEqual(
      await openRecordedLectureStorage({ FILE_STORAGE_ROOT: path.join(appDir, "files") }, appDir),
      { ok: false, reason: "ROOT_INSIDE_APPLICATION" }
    );
    assert.deepEqual(
      await openRecordedLectureStorage({ FILE_STORAGE_ROOT: path.join(storageRoot, "missing") }, appDir),
      { ok: false, reason: "ROOT_MISSING" }
    );

    const opened = await openRecordedLectureStorage({ FILE_STORAGE_ROOT: storageRoot }, appDir);
    assert.equal(opened.ok, true);
    assert.equal(opened.config.maxPartBytes, 4_000_000_000);
    assert.ok(fs.statSync(path.join(storageRoot, "Teachers")).isDirectory());
    assert.ok(fs.statSync(path.join(storageRoot, "System", "TemporaryUploads")).isDirectory());
    // Opening again is idempotent.
    assert.equal((await openRecordedLectureStorage({ FILE_STORAGE_ROOT: storageRoot }, appDir)).ok, true);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

// ---- Writes ---------------------------------------------------------------------------------------------

test("createEmptyFile: creates folders, then refuses to replace anything (exclusive)", async () => {
  await withStorage(async (storage, dir) => {
    await storage.createEmptyFile("System/TemporaryUploads/u.part");
    assert.equal(read(dir, "System/TemporaryUploads/u.part").length, 0);
    fs.writeFileSync(path.join(dir, "System", "TemporaryUploads", "u.part"), "keep");
    await assert.rejects(storage.createEmptyFile("System/TemporaryUploads/u.part"), code("ALREADY_EXISTS"));
    assert.equal(read(dir, "System/TemporaryUploads/u.part").toString(), "keep", "existing content untouched");
    await assert.rejects(storage.createEmptyFile("../escape"), code("INVALID_KEY"));
  });
});

test("writeNewFile: streams chunks (async iterable or web stream); exact size and limits; nothing kept on failure", async () => {
  await withStorage(async (storage, dir) => {
    assert.deepEqual(await storage.writeNewFile("a/one", chunks("abc", "def"), { maxBytes: 6, exactBytes: 6, sync: true }), { bytesWritten: 6, directorySynced: false });
    assert.equal(read(dir, "a/one").toString(), "abcdef");

    const web = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("xy")); c.close(); } });
    assert.deepEqual(await storage.writeNewFile("a/web", web, { maxBytes: 10 }), { bytesWritten: 2, directorySynced: false });

    await assert.rejects(storage.writeNewFile("a/big", chunks("abcd", "ef"), { maxBytes: 5 }), code("LIMIT_EXCEEDED"));
    assert.equal(fs.existsSync(path.join(dir, "a", "big")), false);
    await assert.rejects(storage.writeNewFile("a/short", chunks("abc"), { maxBytes: 10, exactBytes: 4 }), code("SIZE_MISMATCH"));
    assert.equal(fs.existsSync(path.join(dir, "a", "short")), false);
    await assert.rejects(storage.writeNewFile("a/one", chunks("zz"), { maxBytes: 10 }), code("ALREADY_EXISTS"));
    assert.equal(read(dir, "a/one").toString(), "abcdef", "an existing file is never truncated");
    await assert.rejects(storage.writeNewFile("a/bad", chunks("x"), { maxBytes: -1 }), code("INVALID_ARGUMENT"));
    await assert.rejects(storage.writeNewFile("a/bad", chunks("x"), { maxBytes: 2, exactBytes: 3 }), code("INVALID_ARGUMENT"));
  });
});

test("writeNewFile: a stalled source fails at the deadline; an abort fails at once; no partial file remains", async () => {
  await withStorage(async (storage, dir) => {
    let release;
    const stalled = (async function* () {
      yield new TextEncoder().encode("first");
      await new Promise((resolve) => (release = resolve)); // never sends more
    })();
    const started = Date.now();
    await assert.rejects(storage.writeNewFile("s/stalled", stalled, { maxBytes: 100, deadlineAtMs: Date.now() + 80 }), code("DEADLINE_EXCEEDED"));
    assert.ok(Date.now() - started < 2000, "did not wait for the source");
    assert.equal(fs.existsSync(path.join(dir, "s", "stalled")), false);
    release?.();

    const controller = new AbortController();
    const slow = (async function* () {
      yield new TextEncoder().encode("a");
      await new Promise((resolve) => setTimeout(resolve, 5000));
      yield new TextEncoder().encode("b");
    })();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(storage.writeNewFile("s/aborted", slow, { maxBytes: 100, signal: controller.signal }), code("ABORTED"));
    assert.equal(fs.existsSync(path.join(dir, "s", "aborted")), false);

    const already = new AbortController();
    already.abort();
    await assert.rejects(storage.writeNewFile("s/pre", chunks("a"), { maxBytes: 10, signal: already.signal }), code("ABORTED"));
    assert.equal(fs.existsSync(path.join(dir, "s", "pre")), false, "nothing created when already aborted");

    let clock = 1000;
    await assert.rejects(
      storage.writeNewFile("s/clock", chunks("a", "b"), { maxBytes: 10, deadlineAtMs: 1000, now: () => clock }),
      code("DEADLINE_EXCEEDED")
    );
    clock = 0;
  });
});

test("truncate + append: cut back to the confirmed size, then append a chunk file", async () => {
  await withStorage(async (storage, dir) => {
    await storage.writeNewFile("t/upload.part", chunks("0123456789"), { maxBytes: 100 });
    await storage.truncate("t/upload.part", 6);
    assert.equal(read(dir, "t/upload.part").toString(), "012345");
    await storage.truncate("t/upload.part", 6); // same size: no-op
    await assert.rejects(storage.truncate("t/upload.part", 50), code("INVALID_ARGUMENT"), "never extends");
    await assert.rejects(storage.truncate("t/missing", 0), code("NOT_FOUND"));

    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    await storage.writeNewFile("t/chunk", chunks(new Uint8Array(big)), { maxBytes: big.length });
    assert.deepEqual(await storage.append("t/upload.part", "t/chunk"), { bytesAppended: big.length, size: 6 + big.length });
    const result = read(dir, "t/upload.part");
    assert.equal(result.subarray(0, 6).toString(), "012345");
    assert.ok(result.subarray(6).equals(big), "appended bytes in order (multi-block copy)");
    await assert.rejects(storage.append("t/upload.part", "t/missing"), code("NOT_FOUND"));
  });
});

// ---- Reads ----------------------------------------------------------------------------------------------

test("stat / openByteSource / openRead: sizes, random access, whole and ranged streams (in pieces)", async () => {
  await withStorage(async (storage) => {
    const data = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
    await storage.writeNewFile("r/file", chunks(new Uint8Array(data)), { maxBytes: data.length });
    const info = await storage.stat("r/file");
    assert.equal(info.size, data.length);
    assert.equal(await storage.stat("r/none"), null);
    assert.equal(await storage.stat("nofolder/none"), null);

    const source = await storage.openByteSource("r/file");
    assert.equal(source.size, data.length);
    assert.ok(Buffer.from(await source.read(1000, 50)).equals(data.subarray(1000, 1050)));
    await assert.rejects(source.read(data.length - 2, 10), code("INVALID_ARGUMENT"));
    await source.close();
    await source.close();

    const collect = async (stream) => {
      const parts = [];
      for await (const part of stream) parts.push(Buffer.from(part));
      return parts;
    };
    const whole = await storage.openRead("r/file");
    const parts = await collect(whole.stream);
    assert.ok(parts.length > 1, "streamed in several pieces, not one buffer");
    assert.ok(Buffer.concat(parts).equals(data));

    const ranged = await storage.openRead("r/file", { start: 10, end: 19 });
    assert.ok(Buffer.concat(await collect(ranged.stream)).equals(data.subarray(10, 20)));
    await assert.rejects(storage.openRead("r/file", { start: 5, end: data.length }), code("INVALID_ARGUMENT"));
    await assert.rejects(storage.openRead("r/file", { start: 9, end: 3 }), code("INVALID_ARGUMENT"));
    await assert.rejects(storage.openRead("r/none"), code("NOT_FOUND"));

    // A cancelled stream releases the file (it can be removed afterwards, also on Windows).
    const cancelled = await storage.openRead("r/file");
    const reader = cancelled.stream.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await storage.remove("r/file"), true);
  });
});

// ---- Promote / remove ---------------------------------------------------------------------------------

test("promote: moves into a new folder; never replaces an existing file; source must exist", async () => {
  await withStorage(async (storage, dir) => {
    await storage.writeNewFile("System/TemporaryUploads/u.part", chunks("video"), { maxBytes: 10 });
    await storage.promote("System/TemporaryUploads/u.part", "Teachers/t/Lectures/l/RecordedLectures/r/f.mp4");
    assert.equal(read(dir, "Teachers/t/Lectures/l/RecordedLectures/r/f.mp4").toString(), "video");
    assert.equal(fs.existsSync(path.join(dir, "System", "TemporaryUploads", "u.part")), false);

    await storage.writeNewFile("System/TemporaryUploads/v.part", chunks("other"), { maxBytes: 10 });
    await assert.rejects(storage.promote("System/TemporaryUploads/v.part", "Teachers/t/Lectures/l/RecordedLectures/r/f.mp4"), code("ALREADY_EXISTS"));
    assert.equal(read(dir, "Teachers/t/Lectures/l/RecordedLectures/r/f.mp4").toString(), "video", "target unchanged");
    assert.equal(read(dir, "System/TemporaryUploads/v.part").toString(), "other", "source kept");
    await assert.rejects(storage.promote("System/TemporaryUploads/none.part", "x/y"), code("NOT_FOUND"));
  });
});

test("remove / removeEmptyDirectory: false when missing; directories only when empty; never the root", async () => {
  await withStorage(async (storage, dir) => {
    await storage.writeNewFile("d/e/f", chunks("x"), { maxBytes: 1 });
    assert.equal(await storage.remove("d/e/missing"), false);
    assert.equal(await storage.remove("nofolder/x"), false);
    assert.equal(await storage.removeEmptyDirectory("d/e"), false, "not empty");
    assert.equal(await storage.remove("d/e/f"), true);
    assert.equal(await storage.removeEmptyDirectory("d/e"), true);
    assert.equal(await storage.removeEmptyDirectory("d/e"), false);
    await assert.rejects(storage.remove("d"), code("UNSAFE_PATH"), "a directory is not removed as a file");
    assert.ok(fs.existsSync(dir));
  });
});

test("freeBytes: a positive whole number from the storage filesystem", async () => {
  await withStorage(async (storage) => {
    const free = await storage.freeBytes();
    assert.ok(Number.isSafeInteger(free) && free > 0);
  });
});

// ---- Links -----------------------------------------------------------------------------------------------

test("directory links below the root are refused, never followed", async (t) => {
  await withStorage(async (storage, dir) => {
    const outside = tempDir("rl1-outside-");
    try {
      fs.writeFileSync(path.join(outside, "secret"), "do not touch");
      try {
        fs.symlinkSync(outside, path.join(dir, "linked"), "junction");
      } catch (error) {
        t.skip(`directory links cannot be created by this account (${error.code})`);
        return;
      }
      await assert.rejects(storage.createEmptyFile("linked/new"), code("UNSAFE_PATH"));
      await assert.rejects(storage.writeNewFile("linked/new", chunks("x"), { maxBytes: 1 }), code("UNSAFE_PATH"));
      await assert.rejects(storage.stat("linked/secret"), code("UNSAFE_PATH"));
      await assert.rejects(storage.openRead("linked/secret"), code("UNSAFE_PATH"));
      await assert.rejects(storage.remove("linked/secret"), code("UNSAFE_PATH"));
      await assert.rejects(storage.ensureDirectory("linked/sub"), code("UNSAFE_PATH"));
      assert.equal(fs.readFileSync(path.join(outside, "secret"), "utf8"), "do not touch");
      assert.deepEqual(fs.readdirSync(outside), ["secret"], "nothing created outside the root");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("file symbolic links below the root are refused, never followed", async (t) => {
  await withStorage(async (storage, dir) => {
    const outside = tempDir("rl1-outside-");
    try {
      fs.writeFileSync(path.join(outside, "secret"), "do not touch");
      fs.mkdirSync(path.join(dir, "real"));
      try {
        fs.symlinkSync(path.join(outside, "secret"), path.join(dir, "real", "file-link"), "file");
      } catch (error) {
        t.skip(`file symbolic links need administrator rights or Developer Mode on Windows (${error.code})`);
        return;
      }
      await assert.rejects(storage.openByteSource("real/file-link"), code("UNSAFE_PATH"));
      await assert.rejects(storage.openRead("real/file-link"), code("UNSAFE_PATH"));
      await assert.rejects(storage.truncate("real/file-link", 0), code("UNSAFE_PATH"));
      await assert.rejects(storage.append("real/file-link", "real/file-link"), code("UNSAFE_PATH"));
      await assert.rejects(storage.stat("real/file-link"), code("UNSAFE_PATH"));
      await assert.rejects(storage.remove("real/file-link"), code("UNSAFE_PATH"));
      assert.equal(fs.readFileSync(path.join(outside, "secret"), "utf8"), "do not touch");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---- Hard links (RL-1.1, review finding L-1) --------------------------------------------------------------

test("hard link inside storage to an outside file: truncate, append and reads are refused; the outside file is unchanged", async (t) => {
  await withStorage(async (storage, dir) => {
    const outside = tempDir("rl1-outside-");
    const secret = path.join(outside, "important.txt");
    try {
      fs.writeFileSync(secret, "IMPORTANT DATA");
      fs.mkdirSync(path.join(dir, "System", "TemporaryUploads"), { recursive: true });
      const planted = path.join(dir, "System", "TemporaryUploads", "u.part");
      try {
        fs.linkSync(secret, planted);
      } catch (error) {
        t.skip(`hard links cannot be created here (${error.code}); e.g. different volumes`);
        return;
      }
      const key = "System/TemporaryUploads/u.part";
      await storage.writeNewFile("System/TemporaryUploads/chunk", chunks("APPENDED"), { maxBytes: 100 });

      await assert.rejects(storage.truncate(key, 3), code("UNSAFE_PATH"), "truncate");
      await assert.rejects(storage.append(key, "System/TemporaryUploads/chunk"), code("UNSAFE_PATH"), "append into it");
      await assert.rejects(storage.append("System/TemporaryUploads/chunk", key), code("UNSAFE_PATH"), "append from it");
      await assert.rejects(storage.openRead(key), code("UNSAFE_PATH"), "streamed read (playback)");
      await assert.rejects(storage.openRead(key, { start: 0, end: 3 }), code("UNSAFE_PATH"), "ranged read");
      await assert.rejects(storage.openByteSource(key), code("UNSAFE_PATH"), "random-access read (MP4 inspection)");
      await assert.rejects(storage.promote(key, "Teachers/t/x.mp4"), code("UNSAFE_PATH"), "promote");

      assert.equal(fs.readFileSync(secret, "utf8"), "IMPORTANT DATA", "the outside file was not modified");
      assert.equal(fs.statSync(secret).size, 14);
      assert.equal(fs.existsSync(path.join(dir, "Teachers", "t", "x.mp4")), false, "nothing promoted");

      // Removing the planted name only unlinks that name; the outside file survives.
      assert.equal(await storage.remove(key), true);
      assert.equal(fs.readFileSync(secret, "utf8"), "IMPORTANT DATA");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("a hard link created by the attacker AFTER our own file existed is also refused (nlink rises to 2)", async (t) => {
  await withStorage(async (storage, dir) => {
    await storage.writeNewFile("System/TemporaryUploads/own.part", chunks("0123456789"), { maxBytes: 100 });
    const own = path.join(dir, "System", "TemporaryUploads", "own.part");
    const extra = path.join(dir, "System", "TemporaryUploads", "extra-name");
    try {
      fs.linkSync(own, extra);
    } catch (error) {
      t.skip(`hard links cannot be created here (${error.code})`);
      return;
    }
    await assert.rejects(storage.truncate("System/TemporaryUploads/own.part", 2), code("UNSAFE_PATH"));
    assert.equal(fs.readFileSync(own, "utf8"), "0123456789");
    fs.unlinkSync(extra);
    await storage.truncate("System/TemporaryUploads/own.part", 2);
    assert.equal(fs.readFileSync(own, "utf8"), "01", "works again once the file has one name");
  });
});

test("promote leaves the final file with exactly one name, so it can be read and played", async () => {
  await withStorage(async (storage, dir) => {
    await storage.writeNewFile("System/TemporaryUploads/p.part", chunks("video-bytes"), { maxBytes: 100 });
    await storage.promote("System/TemporaryUploads/p.part", "Teachers/t/Lectures/l/RecordedLectures/r/f.mp4");
    const final = path.join(dir, "Teachers", "t", "Lectures", "l", "RecordedLectures", "r", "f.mp4");
    assert.equal(fs.statSync(final).nlink, 1);
    const { stream } = await storage.openRead("Teachers/t/Lectures/l/RecordedLectures/r/f.mp4");
    const parts = [];
    for await (const part of stream) parts.push(Buffer.from(part));
    assert.equal(Buffer.concat(parts).toString(), "video-bytes");
  });
});

test("errors never reveal paths or keys", async () => {
  await withStorage(async (storage, dir) => {
    for (const promise of [storage.stat("../x"), storage.openRead("q/none"), storage.truncate("q/none", 0)]) {
      const error = await promise.then(() => null, (e) => e);
      assert.ok(error instanceof StorageError);
      assert.doesNotMatch(error.message, /[\\/]|none|rl1-root/);
      assert.ok(!error.message.includes(dir));
    }
  });
});
