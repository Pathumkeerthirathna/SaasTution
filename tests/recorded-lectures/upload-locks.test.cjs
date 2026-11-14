/*
 * Recorded Lectures RL-3.1: upload locks (lib/recorded-lectures/upload-locks.ts):
 * advisory-lock keys and statements (against a fake transaction client: no
 * database), and the in-process keyed mutex.
 *
 *   node --test tests/recorded-lectures/upload-locks.test.cjs
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const L = require(path.join(root, "lib", "recorded-lectures", "upload-locks.ts"));

const TEACHER = "0f8b4c2e-1d3a-4b5c-8d9e-0a1b2c3d4e5f";
const UPLOAD = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ---- Advisory-lock keys and statements ---------------------------------------------------------------

test("advisory-lock keys: namespaced, exact format", () => {
  assert.equal(L.RECORDED_LECTURE_LOCK_NAMESPACE, "recorded-lectures");
  assert.equal(L.teacherUploadLockKey(TEACHER), `recorded-lectures:teacher:${TEACHER}`);
  assert.equal(L.CAPACITY_LOCK_KEY, "recorded-lectures:capacity");
  assert.equal(L.uploadMutexKey(UPLOAD), `recorded-lectures:upload:${UPLOAD}`);
  // Distinct from the only other advisory-lock users (breakout).
  assert.ok(!L.CAPACITY_LOCK_KEY.startsWith("breakout"));
});

test("advisory-lock keys: only lowercase UUIDs are accepted (no injection of ':' or other text)", () => {
  for (const bad of [TEACHER.toUpperCase(), `${TEACHER}:x`, "teacher-1", "", null, undefined, 42]) {
    assert.throws(() => L.teacherUploadLockKey(bad), TypeError);
    assert.throws(() => L.uploadMutexKey(bad), TypeError);
  }
});

function fakeTx() {
  const calls = [];
  return {
    calls,
    $executeRawUnsafe: async (sql) => calls.push({ kind: "unsafe", sql }),
    $executeRaw: async (strings, ...values) => calls.push({ kind: "raw", sql: strings.join("?"), values }),
  };
}

test("lock statements: transaction-level advisory locks with a bound key, lock timeout first", async () => {
  const tx = fakeTx();
  await L.setUploadLockTimeout(tx);
  await L.lockTeacherUploads(tx, TEACHER);
  await L.lockUploadCapacity(tx);
  assert.deepEqual(tx.calls, [
    { kind: "unsafe", sql: "SET LOCAL lock_timeout = '3000ms'" },
    { kind: "raw", sql: "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", values: [`recorded-lectures:teacher:${TEACHER}`] },
    { kind: "raw", sql: "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", values: ["recorded-lectures:capacity"] },
  ]);
  assert.deepEqual(L.RECORDED_LECTURE_TRANSACTION_OPTIONS, { maxWait: 5000, timeout: 15000 });
  assert.ok(L.RECORDED_LECTURE_LOCK_TIMEOUT_MS < L.RECORDED_LECTURE_TRANSACTION_OPTIONS.timeout);
});

test("lock statements: refused outside an interactive transaction (a client with $transaction)", async () => {
  const client = { ...fakeTx(), $transaction: async () => {} };
  await assert.rejects(() => L.lockUploadCapacity(client), /inside an interactive transaction/);
  await assert.rejects(() => L.lockTeacherUploads(client, TEACHER), /inside an interactive transaction/);
  await assert.rejects(() => L.setUploadLockTimeout(client), /inside an interactive transaction/);
  assert.equal(client.calls.length, 0);
});

// ---- In-process mutex ----------------------------------------------------------------------------------------

test("mutex: exclusive per key; the next waiter runs only after release (FIFO)", async () => {
  const mutex = new L.UploadMutex();
  const order = [];
  const release1 = await mutex.acquire("k");
  assert.ok(mutex.isHeld("k"));

  const second = mutex.acquire("k", { timeoutMs: 1000 }).then((release) => (order.push("second"), release));
  const third = mutex.acquire("k", { timeoutMs: 1000 }).then((release) => (order.push("third"), release));
  await tick();
  assert.deepEqual(order, [], "nobody else runs while held");

  release1();
  const release2 = await second;
  await tick();
  assert.deepEqual(order, ["second"]);
  release2();
  const release3 = await third;
  assert.deepEqual(order, ["second", "third"]);
  release3();
  assert.ok(!mutex.isHeld("k"));
  assert.equal(mutex.size, 0, "idle keys are forgotten");
});

test("mutex: different keys do not block each other", async () => {
  const mutex = new L.UploadMutex();
  const a = await mutex.acquire("a");
  const b = await mutex.acquire("b", { timeoutMs: 0 });
  assert.ok(mutex.isHeld("a") && mutex.isHeld("b"));
  a();
  b();
  assert.equal(mutex.size, 0);
});

test("mutex: concurrent critical sections never overlap", async () => {
  const mutex = new L.UploadMutex();
  let inside = 0;
  let maxInside = 0;
  const runs = Array.from({ length: 25 }, (_, i) =>
    mutex.withLock("k", async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((resolve) => setTimeout(resolve, i % 3));
      inside--;
      return i;
    }, { timeoutMs: 5000 })
  );
  assert.deepEqual(await Promise.all(runs), Array.from({ length: 25 }, (_, i) => i));
  assert.equal(maxInside, 1);
  assert.equal(mutex.size, 0);
});

test("mutex: a bounded wait times out with UploadMutexTimeoutError and leaves the queue clean", async () => {
  const mutex = new L.UploadMutex();
  const release = await mutex.acquire("k");
  const started = Date.now();
  await assert.rejects(mutex.acquire("k", { timeoutMs: 30 }), (error) => {
    assert.equal(error.name, "UploadMutexTimeoutError");
    assert.ok(L.isUploadMutexTimeoutError(error));
    return true;
  });
  assert.ok(Date.now() - started >= 25);
  await assert.rejects(mutex.acquire("k", { timeoutMs: 0 }), { name: "UploadMutexTimeoutError" });

  // The timed-out waiters are gone: release frees the key completely.
  release();
  assert.ok(!mutex.isHeld("k"));
  assert.equal(mutex.size, 0);
  const again = await mutex.acquire("k", { timeoutMs: 0 });
  again();
});

test("mutex: withLock releases after an exception (and after a synchronous throw)", async () => {
  const mutex = new L.UploadMutex();
  await assert.rejects(mutex.withLock("k", async () => { throw new Error("boom"); }), /boom/);
  assert.ok(!mutex.isHeld("k"));
  await assert.rejects(mutex.withLock("k", () => { throw new Error("sync boom"); }), /sync boom/);
  assert.ok(!mutex.isHeld("k"));
  assert.equal(await mutex.withLock("k", () => 7, { timeoutMs: 0 }), 7);
  assert.equal(mutex.size, 0);
});

test("mutex: release is idempotent (a second call never frees someone else's hold)", async () => {
  const mutex = new L.UploadMutex();
  const first = await mutex.acquire("k");
  const waiting = mutex.acquire("k", { timeoutMs: 1000 });
  first();
  const second = await waiting;
  first(); // stale, repeated release
  assert.ok(mutex.isHeld("k"), "still held by the second owner");
  await assert.rejects(mutex.acquire("k", { timeoutMs: 0 }), { name: "UploadMutexTimeoutError" });
  second();
  assert.ok(!mutex.isHeld("k"));
});

test("mutex: invalid keys and timeouts are rejected", async () => {
  const mutex = new L.UploadMutex();
  await assert.rejects(mutex.acquire(""), TypeError);
  await assert.rejects(mutex.acquire(null), TypeError);
  await assert.rejects(mutex.acquire("k", { timeoutMs: -1 }), TypeError);
  await assert.rejects(mutex.acquire("k", { timeoutMs: Number.NaN }), TypeError);
  assert.equal(mutex.size, 0);
});

test("mutex: one process-wide instance (globalThis singleton)", () => {
  assert.equal(L.getUploadMutex(), L.getUploadMutex());
  assert.ok(L.getUploadMutex() instanceof L.UploadMutex);
});
