/*
 * Recorded Lectures RL-3.5: LocalFileStorage.listDirectory (bounded, streamed,
 * never following links, never outside the root).
 *
 *   npm run test:recorded-lectures
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { LocalFileStorage } = require(path.join(root, "lib", "file-storage", "local-file-storage.ts"));

async function withStorage(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl35-list-"));
  try {
    await fn(await LocalFileStorage.open({ root: dir, appDir: root }), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function list(storage, key, options) {
  const out = [];
  for await (const entry of storage.listDirectory(key, options)) out.push(entry);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

test("lists files and directories with their kind; a missing directory yields nothing", async () => {
  await withStorage(async (storage, dir) => {
    fs.mkdirSync(path.join(dir, "a", "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a", "f1"), "x");
    fs.writeFileSync(path.join(dir, "a", "f2"), "y");
    assert.deepEqual(await list(storage, "a"), [
      { name: "f1", kind: "file" },
      { name: "f2", kind: "file" },
      { name: "sub", kind: "directory" },
    ]);
    assert.deepEqual(await list(storage, "missing"), []);
    assert.deepEqual(await list(storage, "a/missing/deeper"), []);
  });
});

test("the entry limit is respected (streamed, stops early)", async () => {
  await withStorage(async (storage, dir) => {
    fs.mkdirSync(path.join(dir, "many"));
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, "many", `f${i}`), "");
    assert.equal((await list(storage, "many", { limit: 7 })).length, 7);
    assert.equal((await list(storage, "many")).length, 50);
    for (const bad of [0, -1, 1.5]) {
      await assert.rejects(list(storage, "many", { limit: bad }), { code: "INVALID_ARGUMENT" });
    }
  });
});

test("never outside the root: invalid keys are refused", async () => {
  await withStorage(async (storage) => {
    for (const bad of ["../x", "a/../../x", "/etc", "", "a//b"]) {
      await assert.rejects(list(storage, bad), { name: "StorageError" }, bad);
    }
  });
});

test("symlinks are reported as 'other' and never followed; a linked directory is not listed through", async (t) => {
  await withStorage(async (storage, dir) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rl35-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret"), "outside");
      fs.mkdirSync(path.join(dir, "a"));
      try {
        fs.symlinkSync(path.join(outside, "secret"), path.join(dir, "a", "file-link"), "file");
        fs.symlinkSync(outside, path.join(dir, "linked-dir"), "junction");
      } catch (error) {
        t.skip(`links cannot be created here (${error.code})`);
        return;
      }
      assert.deepEqual(await list(storage, "a"), [{ name: "file-link", kind: "other" }]);
      // Listing THROUGH a link is refused (every directory must be real), never followed.
      await assert.rejects(list(storage, "linked-dir"), { code: "UNSAFE_PATH" });
      assert.equal(fs.readFileSync(path.join(outside, "secret"), "utf8"), "outside");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("a hard-linked file is listed as a file; removing it removes only that name", async () => {
  await withStorage(async (storage, dir) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rl35-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "important"), "IMPORTANT");
      fs.mkdirSync(path.join(dir, "a"));
      fs.linkSync(path.join(outside, "important"), path.join(dir, "a", "planted"));
      assert.deepEqual(await list(storage, "a"), [{ name: "planted", kind: "file" }]);
      assert.equal(await storage.remove("a/planted"), true);
      assert.equal(fs.readFileSync(path.join(outside, "important"), "utf8"), "IMPORTANT", "the other name is untouched");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
