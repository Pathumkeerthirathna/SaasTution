/*
 * P2028 fix (services/teacher-storage-usage-service.ts): without a caller
 * transaction, the seven usage reads run as ONE batch transaction at
 * REPEATABLE READ instead of an interactive transaction, which Prisma expires
 * after 5 s (exceeded by seven sequential round trips to a remote database).
 *
 * A small fake Prisma client on a virtual clock: every query takes LATENCY_MS
 * of virtual time; an interactive transaction expires 5000 ms after it starts,
 * like Prisma's default (a batch transaction has no such timer). No database.
 *
 *   node --test tests/storage-quota/usage-batch.test.cjs
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const NOW = new Date("2026-11-18T10:00:00.000Z");
const INTERACTIVE_TIMEOUT_MS = 5000; // Prisma's default interactive transaction timeout
const LATENCY_MS = 800; // one round trip to a remote database (the logs show ~5.3 s for seven)

const state = { clock: 0, calls: [], transactions: [], failOn: null };

function p2028(elapsed) {
  return Object.assign(
    new Error(
      `Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was ${INTERACTIVE_TIMEOUT_MS} ms, however ${elapsed} ms passed since the start of the transaction.`
    ),
    { code: "P2028" }
  );
}

/** A client whose every query costs LATENCY_MS; `tx` = the interactive transaction it runs in. */
function client(label, tx = null) {
  const query = (name, result) =>
    Promise.resolve().then(() => {
      state.clock += LATENCY_MS;
      state.calls.push(`${label}:${name}`);
      if (tx && state.clock - tx.startedAt > INTERACTIVE_TIMEOUT_MS) throw p2028(state.clock - tx.startedAt);
      if (state.failOn === name) throw Object.assign(new Error(`simulated failure: ${name}`), { code: "P1001" });
      return result();
    });
  return {
    recordingUploadSession: {
      findMany: () =>
        query("recordingUploadSession.findMany", () => [
          { state: "ACTIVE", expectedBytes: 1000n, receivedBytes: 400n, leaseBytes: null, leaseExpiresAt: null, expiresAt: new Date("2026-11-18T12:00:00.000Z") },
        ]),
    },
    storageReservation: {
      groupBy: () =>
        query("storageReservation.groupBy", () => [
          { category: "NOTE", _sum: { bytes: 70n } },
          { category: "SUBMISSION", _sum: { bytes: 30n } },
        ]),
    },
    recordedLecture: { aggregate: () => query("recordedLecture.aggregate", () => ({ _sum: { sizeBytes: 5_000n } })) },
    $queryRaw: () => query("$queryRaw", () => [{ notesBytes: 300n, submissionsBytes: 200n }]),
    teacherProfile: {
      findUnique: () => query("teacherProfile.findUnique", () => ({ profileImageStorageKey: "Teachers/t1/profile.jpg", profileImageSizeBytes: 50 })),
    },
    teacherStorageLimit: { findUnique: () => query("teacherStorageLimit.findUnique", () => null) },
    teacherSubscription: { findFirst: () => query("teacherSubscription.findFirst", () => ({ plan: { storageGB: 1 } })) },
  };
}

const prisma = {
  ...client("root"),
  async $transaction(arg, options) {
    if (Array.isArray(arg)) {
      // Batch: no interactive timer; the queries in order.
      state.transactions.push({ kind: "batch", options, size: arg.length });
      const results = [];
      for (const q of arg) results.push(await q);
      return results;
    }
    // Interactive: the callback's queries must finish before the timer expires.
    const tx = { startedAt: state.clock };
    state.transactions.push({ kind: "interactive", options });
    return arg(client("tx", tx));
  },
};

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
fake("lib/prisma.ts", { prisma });
fake("lib/server-clock.ts", { serverNow: async () => NOW, serverNowSync: () => NOW });

const usage = require(path.join(root, "services", "teacher-storage-usage-service.ts"));

const ORDER = [
  "recordingUploadSession.findMany",
  "storageReservation.groupBy",
  "recordedLecture.aggregate",
  "$queryRaw",
  "teacherProfile.findUnique",
  "teacherStorageLimit.findUnique",
  "teacherSubscription.findFirst",
];

test.beforeEach(() => {
  state.clock = 0;
  state.calls = [];
  state.transactions = [];
  state.failOn = null;
});

test("default path: ONE batch transaction of the seven reads at REPEATABLE READ (no interactive callback)", async () => {
  await usage.getTeacherStorageUsage("t1");
  assert.deepEqual(state.transactions, [{ kind: "batch", options: { isolationLevel: "RepeatableRead" }, size: 7 }]);
  assert.deepEqual(state.calls, ORDER.map((name) => `root:${name}`), "same queries, same order");
});

test("caller's transaction: its own client is used, in order, and no transaction is started", async () => {
  const callerTx = client("caller");
  await usage.getTeacherStorageUsage("t1", { db: callerTx, now: NOW });
  assert.deepEqual(state.transactions, [], "no nested transaction");
  assert.deepEqual(state.calls, ORDER.map((name) => `caller:${name}`), "reservations first, then committed rows, then the limit");
});

test("both paths compute the identical usage from identical rows (calculations unchanged)", async () => {
  const viaBatch = await usage.getTeacherStorageUsage("t1");
  const viaCaller = await usage.getTeacherStorageUsage("t1", { db: client("caller"), now: NOW });
  assert.deepEqual(viaBatch, viaCaller);
  // The values flow to the right places.
  assert.equal(viaBatch.teacherId, "t1");
  assert.equal(viaBatch.committed.recordedLectures, 5_000n);
  assert.equal(viaBatch.committed.notes, 300n);
  assert.equal(viaBatch.committed.submissions, 200n);
  assert.equal(viaBatch.committed.profileImages, 50n);
  assert.equal(viaBatch.reserved.notes, 70n);
  assert.equal(viaBatch.reserved.submissions, 30n);
  assert.equal(viaBatch.reserved.profileImages, 0n);
  assert.equal(viaBatch.limit.source, "PLAN");
});

test("regression (P2028): seven sequential reads in an INTERACTIVE transaction expire; the batch completes", async () => {
  // The previous implementation: prisma.$transaction((tx) => seven sequential awaits, { RepeatableRead }).
  const legacy = () =>
    prisma.$transaction(
      async (tx) => {
        const results = [];
        for (const q of usage.usageQueries(tx, "t1", NOW)) results.push(await q);
        return results;
      },
      { isolationLevel: "RepeatableRead" }
    );
  await assert.rejects(legacy(), (error) => {
    assert.equal(error.code, "P2028");
    assert.match(error.message, /expired transaction.*5000 ms, however 5600 ms passed/);
    return true;
  });
  assert.equal(state.calls.at(-1), "tx:teacherSubscription.findFirst", "the 7th query fails, as in the logs");

  state.clock = 0;
  state.calls = [];
  const result = await usage.getTeacherStorageUsage("t1");
  assert.equal(state.clock, 7 * LATENCY_MS, "same total latency (5.6 s)...");
  assert.equal(result.committed.recordedLectures, 5_000n, "...but the batch has no interactive timer and succeeds");
});

test("a failing read fails the whole call: never a partial or zero usage", async () => {
  for (const name of ["storageReservation.groupBy", "$queryRaw", "teacherSubscription.findFirst"]) {
    state.failOn = name;
    await assert.rejects(usage.getTeacherStorageUsage("t1"), new RegExp(`simulated failure: ${name.replace("$", "\\$")}`), `batch: ${name}`);
    await assert.rejects(usage.getTeacherStorageUsage("t1", { db: client("caller"), now: NOW }), /simulated failure/, `caller tx: ${name}`);
  }
});
