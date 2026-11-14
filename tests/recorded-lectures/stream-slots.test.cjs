/*
 * Recorded Lectures RL-4.3: playback stream slots (lib/recorded-lectures/stream-slots.ts)
 * and the per-process cached storage handle (lib/recorded-lectures/storage.ts).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const S = require(path.join(root, "lib", "recorded-lectures", "stream-slots.ts"));
const storageModule = require(path.join(root, "lib", "recorded-lectures", "storage.ts"));
const { LocalFileStorage } = require(path.join(root, "lib", "file-storage", "local-file-storage.ts"));

// ---- Slots ---------------------------------------------------------------------------------------

test("slots: the approved constants are 4 per student and 64 per process", () => {
  assert.equal(S.MAX_STREAMS_PER_STUDENT, 4);
  assert.equal(S.MAX_STREAMS_PER_PROCESS, 64);
  const slots = new S.StreamSlots();
  assert.equal(slots.perStudent, 4);
  assert.equal(slots.perProcess, 64);
});

test("slots: a student gets 4, the 5th is refused as STUDENT; another student is unaffected", () => {
  const slots = new S.StreamSlots();
  const held = [1, 2, 3, 4].map(() => slots.tryAcquire("a"));
  assert.ok(held.every((h) => h.ok));
  assert.deepEqual(slots.tryAcquire("a"), { ok: false, reason: "STUDENT" });
  assert.equal(slots.studentInUse("a"), 4);
  assert.ok(slots.tryAcquire("b").ok);
  held[0].release();
  assert.ok(slots.tryAcquire("a").ok, "a released slot can be taken again");
});

test("slots: the process limit refuses as GLOBAL across students", () => {
  const slots = new S.StreamSlots(4, 64);
  for (let i = 0; i < 16; i += 1) for (let j = 0; j < 4; j += 1) assert.ok(slots.tryAcquire(`s${i}`).ok);
  assert.equal(slots.inUse, 64);
  assert.deepEqual(slots.tryAcquire("new-student"), { ok: false, reason: "GLOBAL" });
  assert.deepEqual(slots.tryAcquire("s0"), { ok: false, reason: "STUDENT" }, "a student at its own limit is told so first");
  assert.equal(slots.studentInUse("new-student"), 0, "a refusal holds nothing");
});

test("slots: release is idempotent; counts and the student map return to zero", () => {
  const slots = new S.StreamSlots(2, 3);
  const a = slots.tryAcquire("a");
  const b = slots.tryAcquire("a");
  const c = slots.tryAcquire("b");
  assert.equal(slots.inUse, 3);
  assert.equal(slots.studentsStreaming, 2);
  for (let i = 0; i < 3; i += 1) a.release();
  assert.equal(slots.inUse, 2, "a second release does nothing");
  assert.equal(slots.studentInUse("a"), 1);
  b.release();
  c.release();
  c.release();
  assert.equal(slots.inUse, 0);
  assert.equal(slots.studentsStreaming, 0, "no entry is left for students who stopped streaming");
  assert.ok(slots.tryAcquire("x").ok);
});

test("slots: refusals never change counts; a release from a refused attempt does not exist", () => {
  const slots = new S.StreamSlots(1, 1);
  const a = slots.tryAcquire("a");
  const refused = slots.tryAcquire("b");
  assert.deepEqual(refused, { ok: false, reason: "GLOBAL" });
  assert.equal(refused.release, undefined);
  assert.equal(slots.inUse, 1);
  a.release();
  assert.equal(slots.inUse, 0);
});

test("slots: invalid limits and student ids are refused", () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => new S.StreamSlots(bad, 1), TypeError);
    assert.throws(() => new S.StreamSlots(1, bad), TypeError);
  }
  assert.throws(() => new S.StreamSlots().tryAcquire(""), TypeError);
  assert.throws(() => new S.StreamSlots().tryAcquire(undefined), TypeError);
});

test("slots: one process-wide singleton; reset for tests replaces it", () => {
  const first = S.getStreamSlots();
  assert.equal(S.getStreamSlots(), first);
  const replaced = S.resetStreamSlotsForTests(1, 2);
  assert.notEqual(replaced, first);
  assert.equal(S.getStreamSlots(), replaced);
  S.resetStreamSlotsForTests();
});

test("slots: the module is pure (no imports, no timers, no environment)", () => {
  const src = fs.readFileSync(path.join(root, "lib", "recorded-lectures", "stream-slots.ts"), "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m);
  assert.doesNotMatch(src, /process\.env|setTimeout|setInterval/);
});

// ---- Cached storage handle -----------------------------------------------------------------------

function envWith(rootDir, extra = {}) {
  return { FILE_STORAGE_ROOT: rootDir, ...extra };
}

async function withRoots(fn) {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "rl43-cache-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "rl43-cache-b-"));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "rl43-cache-app-"));
  storageModule.resetRecordedLectureStorageCacheForTests();
  const opens = { count: 0 };
  const originalOpen = LocalFileStorage.open;
  LocalFileStorage.open = function countedOpen(...args) {
    opens.count += 1;
    return originalOpen.apply(this, args);
  };
  try {
    await fn({ a, b, appDir, opens });
  } finally {
    LocalFileStorage.open = originalOpen;
    storageModule.resetRecordedLectureStorageCacheForTests();
    for (const dir of [a, b, appDir]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("storage cache: opened once per process and reused (same root and configuration)", async () => {
  await withRoots(async ({ a, appDir, opens }) => {
    const first = await storageModule.getRecordedLectureStorage(envWith(a), appDir);
    assert.equal(first.ok, true);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => storageModule.getRecordedLectureStorage(envWith(a), appDir)));
    for (const r of results) assert.equal(r.storage, first.storage);
    assert.equal(opens.count, 1);
  });
});

test("storage cache: concurrent first calls share one open", async () => {
  await withRoots(async ({ a, appDir, opens }) => {
    const results = await Promise.all([1, 2, 3].map(() => storageModule.getRecordedLectureStorage(envWith(a), appDir)));
    assert.equal(opens.count, 1);
    assert.ok(results.every((r) => r.ok && r.storage === results[0].storage));
  });
});

test("storage cache: a different root or configuration opens a new handle", async () => {
  await withRoots(async ({ a, b, appDir, opens }) => {
    const first = await storageModule.getRecordedLectureStorage(envWith(a), appDir);
    const other = await storageModule.getRecordedLectureStorage(envWith(b), appDir);
    assert.notEqual(other.storage, first.storage);
    const reconfigured = await storageModule.getRecordedLectureStorage(envWith(b, { RECORDED_LECTURE_DASHBOARD_DAYS: "3" }), appDir);
    assert.notEqual(reconfigured.storage, other.storage);
    assert.equal(reconfigured.config.dashboardAvailabilityDays, 3);
    assert.equal(opens.count, 3);
  });
});

test("storage cache: invalid settings drop the cache; failures are never cached", async () => {
  await withRoots(async ({ a, appDir, opens }) => {
    await storageModule.getRecordedLectureStorage(envWith(a), appDir);
    assert.deepEqual(await storageModule.getRecordedLectureStorage({}, appDir), { ok: false, reason: "ROOT_NOT_SET" });
    assert.deepEqual(await storageModule.getRecordedLectureStorage(envWith(a, { RECORDED_LECTURE_DASHBOARD_DAYS: "99" }), appDir), { ok: false, reason: "INVALID_CONFIGURATION" });
    const again = await storageModule.getRecordedLectureStorage(envWith(a), appDir);
    assert.equal(again.ok, true);
    assert.equal(opens.count, 2, "re-opened after the configuration error dropped it");

    const missing = path.join(a, "does-not-exist");
    assert.deepEqual(await storageModule.getRecordedLectureStorage(envWith(missing), appDir), { ok: false, reason: "ROOT_MISSING" });
    fs.mkdirSync(missing);
    const fixed = await storageModule.getRecordedLectureStorage(envWith(missing), appDir);
    assert.equal(fixed.ok, true, "a root fixed later is picked up: the failure was not cached");
  });
});

test("storage cache: only ROOT_* errors invalidate it; per-file errors never do", async () => {
  await withRoots(async ({ a, appDir, opens }) => {
    const first = await storageModule.getRecordedLectureStorage(envWith(a), appDir);
    for (const code of ["NOT_FOUND", "SIZE_MISMATCH", "UNSAFE_PATH", "IO_ERROR", "INVALID_KEY", "ABORTED", undefined, null, 42]) {
      assert.equal(storageModule.invalidateRecordedLectureStorageForRootError(code), false, String(code));
      assert.equal(storageModule.isStorageRootErrorCode(code), false, String(code));
    }
    assert.equal((await storageModule.getRecordedLectureStorage(envWith(a), appDir)).storage, first.storage);
    assert.equal(opens.count, 1);
    for (const code of ["ROOT_MISSING", "ROOT_NOT_DIRECTORY", "ROOT_INSIDE_APPLICATION", "ROOT_WORLD_WRITABLE", "ROOT_NOT_WRITABLE"]) {
      assert.equal(storageModule.isStorageRootErrorCode(code), true, code);
    }
    assert.equal(storageModule.invalidateRecordedLectureStorageForRootError("ROOT_MISSING"), true);
    const reopened = await storageModule.getRecordedLectureStorage(envWith(a), appDir);
    assert.notEqual(reopened.storage, first.storage);
    assert.equal(opens.count, 2);
  });
});
