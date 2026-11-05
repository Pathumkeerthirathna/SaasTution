/*
 * Breakout file storage (lib/breakout-activities/storage.ts): atomic writes
 * in the session folder, removal, reads, download headers, and symlink
 * protection at every level below the storage root for upload, read, file
 * removal and session-folder removal (the root itself may be a symlink).
 *
 * Every test uses fresh folders under the OS temp directory, removed
 * afterwards; the project's storage/ folder is never touched. Symlink tests
 * are skipped (not failed) where the OS refuses to create symlinks.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const storage = require(path.join(root, "lib/breakout-activities/storage.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));

const SESSION = "6e445fc0-1c04-46bd-8dd3-82acfa381b21";
const OTHER_SESSION = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const ACTIVITY = "9db014fc-fc1d-434a-853d-6e6909c7a465";
const NOW = 1_762_300_000_000;
const LEVELS = ["breakout-activities", "<sessionId>", "submissions", "<activityId>", "<file>"];

const pdf = (size = 64, fill = 0) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set(Buffer.from("%PDF-1.7\n"));
  return bytes;
};

// ---- Helpers ----------------------------------------------------------------

const sandboxes = [];
test.after(() => {
  for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh folder with storage/ (the root) and outside/ (must never change). */
function sandbox() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "breakout-storage-test-")));
  sandboxes.push(base);
  const storageRoot = path.join(base, "storage");
  const outside = path.join(base, "outside");
  fs.mkdirSync(storageRoot);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "do not touch");
  return { base, storageRoot, outside };
}

/** Every file below `dir` with its bytes (for "untouched" comparisons). */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full).toString("base64");
    }
  };
  walk(dir);
  return out;
}

/** Creates a symlink, or returns false where the OS does not allow it. */
function link(target, linkPath, kind) {
  const types = kind === "dir" ? ["dir", "junction"] : ["file"];
  for (const type of types) {
    try {
      fs.symlinkSync(target, linkPath, type);
      return true;
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
    }
  }
  return false;
}

// Quiet (and count) the expected console.error lines of refused operations.
async function quiet(fn) {
  const saved = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.error = saved;
  }
}

const write = (storageRoot, overrides = {}) =>
  storage.writeBreakoutPdf({ sessionId: SESSION, kind: "submission", activityId: ACTIVITY, bytes: pdf(), storageRoot, nowMs: NOW, ...overrides });

/**
 * A stored file whose directory level `level` (1-4) or the file itself (5) is
 * replaced by a symlink into outside/mirror-<level>, holding an identical
 * copy: following the link would succeed, so only the refusal passes.
 */
async function storedWithSymlinkAt(t, level) {
  const box = sandbox();
  const stored = await write(box.storageRoot);
  const parts = stored.relativePath.split("/");
  const real = path.join(box.storageRoot, ...parts.slice(0, level));
  const mirror = path.join(box.outside, `mirror-${level}`);
  fs.cpSync(real, mirror, { recursive: true });
  fs.rmSync(real, { recursive: true, force: true });
  if (!link(mirror, real, level === 5 ? "file" : "dir")) {
    t.skip("symlinks are not permitted here");
    return null;
  }
  return { ...box, stored, mirror, before: snapshot(box.outside) };
}

// ---- Normal operation -------------------------------------------------------

test("storage root is <cwd>/storage, like the other uploads", () => {
  assert.equal(storage.breakoutStorageRoot(), path.join(process.cwd(), "storage"));
});

test("write: the file lands in the session folder under a server-generated name", async () => {
  const { storageRoot } = sandbox();
  const stored = await write(storageRoot);
  assert.match(stored.relativePath, new RegExp(`^breakout-activities/${SESSION}/submissions/${ACTIVITY}/${NOW}-[0-9a-f]{32}\\.pdf$`));
  assert.equal(stored.absolutePath, path.join(storageRoot, ...stored.relativePath.split("/")));
  assert.equal(stored.sizeBytes, 64);
  assert.deepEqual(new Uint8Array(fs.readFileSync(stored.absolutePath)), pdf());
  const brief = await write(storageRoot, { kind: "brief" });
  assert.match(brief.relativePath, new RegExp(`^breakout-activities/${SESSION}/briefs/${ACTIVITY}/`));
});

test("write: no temporary file is left behind; two writes never share a name", async () => {
  const { storageRoot } = sandbox();
  const a = await write(storageRoot);
  const b = await write(storageRoot);
  assert.notEqual(a.relativePath, b.relativePath);
  assert.deepEqual(fs.readdirSync(path.dirname(a.absolutePath)).filter((n) => n.endsWith(".tmp")), []);
});

test("write: re-checks the bytes (empty or not a PDF: 400 INVALID_PDF; too large: 413 FILE_TOO_LARGE)", async () => {
  const { storageRoot } = sandbox();
  const result = async (bytes) => {
    try {
      await write(storageRoot, { bytes });
      return "written";
    } catch (e) {
      assert.ok(e instanceof AppError);
      return `${e.statusCode} ${e.code}`;
    }
  };
  assert.equal(await result(new Uint8Array(0)), "400 INVALID_PDF");
  assert.equal(await result(new Uint8Array(25 * 1024 * 1024 + 1)), "413 FILE_TOO_LARGE");
  assert.equal(await result(Buffer.from("<html>not a pdf</html>")), "400 INVALID_PDF");
  assert.equal(await result("%PDF-1.7"), "400 INVALID_PDF", "a string is not bytes");
  assert.deepEqual(fs.readdirSync(storageRoot), [], "nothing was created");
});

test("write: invalid ids are refused before anything is created", async () => {
  const { storageRoot } = sandbox();
  await assert.rejects(write(storageRoot, { sessionId: "../../etc" }), RangeError);
  await assert.rejects(write(storageRoot, { activityId: "not-a-uuid" }), RangeError);
  await assert.rejects(write(storageRoot, { kind: "other" }), RangeError);
  assert.deepEqual(fs.readdirSync(storageRoot), []);
});

test("read: returns the bytes; missing file, folder or root is 404 FILE_NOT_FOUND", async () => {
  const { base, storageRoot } = sandbox();
  const stored = await write(storageRoot);
  assert.deepEqual(await storage.readBreakoutFile(stored.relativePath, SESSION, storageRoot), pdf());
  const notFound = (e) => e instanceof AppError && e.code === "FILE_NOT_FOUND" && e.statusCode === 404;
  await assert.rejects(storage.readBreakoutFile(stored.relativePath.replace(/\d{13}-/, "1000000000000-"), SESSION, storageRoot), notFound);
  await assert.rejects(storage.readBreakoutFile(stored.relativePath.replace(ACTIVITY, OTHER_SESSION), SESSION, storageRoot), notFound);
  await assert.rejects(storage.readBreakoutFile(stored.relativePath, SESSION, path.join(base, "no-such-root")), notFound);
});

test("read: a path of another session or a tampered path is 404, never read", async () => {
  const { storageRoot } = sandbox();
  const stored = await write(storageRoot);
  const notFound = (e) => e.code === "FILE_NOT_FOUND";
  await quiet(async () => {
    await assert.rejects(storage.readBreakoutFile(stored.relativePath, OTHER_SESSION, storageRoot), notFound);
    for (const bad of ["../../secret.pdf", `breakout-activities/${SESSION}/../${OTHER_SESSION}/x.pdf`, "/etc/passwd", `breakout-activities\\${SESSION}\\x.pdf`]) {
      await assert.rejects(storage.readBreakoutFile(bad, SESSION, storageRoot), notFound, bad);
    }
  });
});

test("remove file: removed, already gone, missing folder or root, invalid path; never throws", async () => {
  const { base, storageRoot } = sandbox();
  const stored = await write(storageRoot);
  assert.equal(await storage.removeBreakoutFile(stored.relativePath, SESSION, storageRoot), true);
  assert.equal(fs.existsSync(stored.absolutePath), false);
  assert.equal(await storage.removeBreakoutFile(stored.relativePath, SESSION, storageRoot), true, "already gone");
  assert.equal(await storage.removeBreakoutFile(stored.relativePath.replace(ACTIVITY, OTHER_SESSION), SESSION, storageRoot), true, "no folder");
  assert.equal(await storage.removeBreakoutFile(stored.relativePath, SESSION, path.join(base, "no-such-root")), true, "no root");
  assert.equal(await storage.removeBreakoutFile(null, SESSION, storageRoot), true);
  assert.equal((await quiet(() => storage.removeBreakoutFile("../../x.pdf", SESSION, storageRoot))).result, false);
});

test("remove session folder: only that session's folder; missing is fine", async () => {
  const { base, storageRoot } = sandbox();
  const mine = await write(storageRoot);
  const other = await write(storageRoot, { sessionId: OTHER_SESSION });
  assert.deepEqual(await storage.removeBreakoutSessionDir(SESSION, storageRoot), { removed: true });
  assert.equal(fs.existsSync(path.join(storageRoot, "breakout-activities", SESSION)), false);
  assert.equal(fs.existsSync(mine.absolutePath), false);
  assert.equal(fs.existsSync(other.absolutePath), true, "another session is untouched");
  assert.deepEqual(await storage.removeBreakoutSessionDir(SESSION, storageRoot), { removed: true }, "already gone");
  assert.deepEqual(await storage.removeBreakoutSessionDir(SESSION, path.join(base, "no-such-root")), { removed: true });
  assert.deepEqual((await quiet(() => storage.removeBreakoutSessionDir("..", storageRoot))).result, { removed: false });
});

// ---- Symlinks ---------------------------------------------------------------

test("the storage root itself may be a symlink: all operations work through it", async (t) => {
  const { base, outside } = sandbox();
  const realRoot = path.join(base, "volume");
  fs.mkdirSync(realRoot);
  const linkedRoot = path.join(base, "linked-storage");
  if (!link(realRoot, linkedRoot, "dir")) return t.skip("symlinks are not permitted here");
  const before = snapshot(outside);

  const stored = await write(linkedRoot);
  assert.equal(stored.absolutePath, path.join(realRoot, ...stored.relativePath.split("/")), "resolved once, under the real root");
  assert.ok(fs.existsSync(stored.absolutePath));
  assert.deepEqual(await storage.readBreakoutFile(stored.relativePath, SESSION, linkedRoot), pdf());
  assert.equal(await storage.removeBreakoutFile(stored.relativePath, SESSION, linkedRoot), true);
  assert.equal(fs.existsSync(stored.absolutePath), false);
  await write(linkedRoot);
  assert.deepEqual(await storage.removeBreakoutSessionDir(SESSION, linkedRoot), { removed: true });
  assert.equal(fs.existsSync(path.join(realRoot, "breakout-activities", SESSION)), false);
  assert.deepEqual(snapshot(outside), before);
});

for (const level of [1, 2, 3, 4]) {
  test(`upload refused: symlink at level ${level} (${LEVELS[level - 1]}); outside untouched`, async (t) => {
    const s = await storedWithSymlinkAt(t, level);
    if (!s) return;
    const { result, lines } = await quiet(() => write(s.storageRoot, { bytes: pdf(64, 7) }).then(() => "written", (e) => e));
    assert.ok(result instanceof Error && result.name === "UnsafeStoragePathError", String(result));
    assert.equal(lines.length, 1, "logged once");
    assert.deepEqual(snapshot(s.outside), s.before, "no file written through the link");
  });
}

test("upload refused: a regular file where a folder belongs", async () => {
  const { storageRoot, outside } = sandbox();
  fs.writeFileSync(path.join(storageRoot, "breakout-activities"), "not a folder");
  const { result } = await quiet(() => write(storageRoot).then(() => "written", (e) => e));
  assert.ok(result instanceof Error && result.name === "UnsafeStoragePathError");
  assert.equal(fs.readFileSync(path.join(storageRoot, "breakout-activities"), "utf8"), "not a folder");
  assert.deepEqual(Object.keys(snapshot(outside)), ["sentinel.txt"]);
});

for (const level of [1, 2, 3, 4, 5]) {
  test(`read refused (404): symlink at level ${level} (${LEVELS[level - 1]}); outside untouched`, async (t) => {
    const s = await storedWithSymlinkAt(t, level);
    if (!s) return;
    const { result, lines } = await quiet(() => storage.readBreakoutFile(s.stored.relativePath, SESSION, s.storageRoot).then(() => "read", (e) => e));
    assert.ok(result instanceof AppError, String(result));
    assert.equal(result.code, "FILE_NOT_FOUND");
    assert.equal(result.statusCode, 404);
    assert.equal(lines.length, 1, "logged once");
    assert.deepEqual(snapshot(s.outside), s.before);
  });

  test(`file removal refused: symlink at level ${level} (${LEVELS[level - 1]}); outside untouched`, async (t) => {
    const s = await storedWithSymlinkAt(t, level);
    if (!s) return;
    const { result, lines } = await quiet(() => storage.removeBreakoutFile(s.stored.relativePath, SESSION, s.storageRoot));
    assert.equal(result, false);
    assert.equal(lines.length, 1, "logged once");
    assert.deepEqual(snapshot(s.outside), s.before, "the mirrored file still exists");
  });
}

for (const level of [1, 2]) {
  test(`session folder removal refused: symlink at level ${level} (${LEVELS[level - 1]}); outside untouched`, async (t) => {
    const s = await storedWithSymlinkAt(t, level);
    if (!s) return;
    const { result, lines } = await quiet(() => storage.removeBreakoutSessionDir(SESSION, s.storageRoot));
    assert.deepEqual(result, { removed: false });
    assert.equal(lines.length, 1, "logged once");
    assert.deepEqual(snapshot(s.outside), s.before);
  });
}

for (const level of [3, 4, 5]) {
  test(`session folder removal: a symlink inside the folder (level ${level}, ${LEVELS[level - 1]}) is removed as a link, never followed`, async (t) => {
    const s = await storedWithSymlinkAt(t, level);
    if (!s) return;
    const result = await storage.removeBreakoutSessionDir(SESSION, s.storageRoot);
    assert.deepEqual(result, { removed: true });
    assert.equal(fs.existsSync(path.join(s.storageRoot, "breakout-activities", SESSION)), false);
    assert.deepEqual(snapshot(s.outside), s.before, "the link's target is untouched");
  });
}

// ---- Download headers -------------------------------------------------------

test("download headers: attachment, nosniff, no caching, UTF-8 filename*", () => {
  const h = storage.breakoutPdfDownloadHeaders("ගණිතය පිළිතුරු.pdf", 1234);
  assert.equal(h["Content-Type"], "application/pdf");
  assert.equal(h["Content-Length"], "1234");
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["Cache-Control"], "private, no-store");
  const cd = h["Content-Disposition"];
  assert.match(cd, /^attachment; filename="[\x20-\x7E]+"; filename\*=UTF-8''/);
  const encoded = cd.split("filename*=UTF-8''")[1];
  assert.equal(decodeURIComponent(encoded), "ගණිතය පිළිතුරු.pdf");
  assert.doesNotMatch(encoded, /[^A-Za-z0-9%._~-]/, "only unreserved characters and %XX");
});

test("download headers: quotes, backslashes and control characters cannot break the header", () => {
  const cd = storage.attachmentContentDisposition('evil"\\name\r\nX-Injected: 1.pdf');
  assert.doesNotMatch(cd, /[\r\n]/);
  const ascii = cd.match(/filename="([^"]*)"/)[1];
  assert.doesNotMatch(ascii, /["\\]/);
  assert.match(storage.attachmentContentDisposition(""), /filename="document\.pdf"/);
});
