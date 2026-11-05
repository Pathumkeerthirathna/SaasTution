/*
 * Breakout locks and transactions (lib/breakout-activities/locks.ts): the
 * exact SQL each lock sends, the lock timeout set first and kept below the
 * transaction timeout, refusal outside a transaction, the session checks,
 * the enforced lock order (compile time and run time), and that breakout
 * code starts transactions only through runBreakoutTransaction(). A fake
 * transaction client records the raw queries; no database is contacted.
 *
 *   npm run test:breakout
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const locks = require(path.join(root, "lib/breakout-activities/locks.ts"));
const { AppError } = require(path.join(root, "lib/error-handler.ts"));

const SESSION = "6e445fc0-1c04-46bd-8dd3-82acfa381b21";
const LIVE = { id: SESSION, classId: "c1", isActive: true };

/** A fake interactive-transaction client (no $transaction). */
function fakeTx(rows = []) {
  const calls = [];
  const sql = (strings) => strings.join("?").replace(/\s+/g, " ").trim();
  return {
    calls,
    $queryRaw: async (strings, ...values) => {
      calls.push({ kind: "query", sql: sql(strings), values });
      return rows;
    },
    $executeRaw: async (strings, ...values) => {
      calls.push({ kind: "execute", sql: sql(strings), values });
      return 1;
    },
    $executeRawUnsafe: async (text) => {
      calls.push({ kind: "unsafe", sql: text, values: [] });
      return 0;
    },
  };
}

// ---- Timeouts and transactions ----------------------------------------------

test("lock timeout 3 s, transaction 15 s / maxWait 5 s; a lock wait always ends first", () => {
  assert.equal(locks.BREAKOUT_LOCK_TIMEOUT_MS, 3_000);
  assert.deepEqual(locks.BREAKOUT_TRANSACTION_OPTIONS, { maxWait: 5_000, timeout: 15_000 });
  assert.ok(locks.BREAKOUT_LOCK_TIMEOUT_MS < locks.BREAKOUT_TRANSACTION_OPTIONS.timeout);
  // Two lock waits (session row, then advisory) still end before the transaction expires.
  assert.ok(2 * locks.BREAKOUT_LOCK_TIMEOUT_MS < locks.BREAKOUT_TRANSACTION_OPTIONS.timeout);
});

test("runBreakoutTransaction passes the breakout options to $transaction", async () => {
  const seen = [];
  const client = {
    $transaction: async (fn, options) => {
      seen.push(options);
      return fn("tx");
    },
  };
  assert.equal(await locks.runBreakoutTransaction(client, async (tx) => `ran in ${tx}`), "ran in tx");
  assert.deepEqual(seen, [locks.BREAKOUT_TRANSACTION_OPTIONS]);
});

test("breakout code starts transactions only through runBreakoutTransaction", () => {
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(root, "lib", "breakout-activities"));
  walk(path.join(root, "app", "api", "sessions", "[id]", "breakout"));
  if (fs.existsSync(path.join(root, "services"))) {
    for (const name of fs.readdirSync(path.join(root, "services"))) {
      if (/^breakout-.*\.(ts|mjs|js)$/.test(name)) files.push(path.join(root, "services", name));
    }
  }
  const offending = files
    .filter((file) => !file.endsWith(path.join("breakout-activities", "locks.ts")))
    .filter((file) => /\$transaction\s*\(/.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file));
  assert.deepEqual(offending, [], `use runBreakoutTransaction() instead of $transaction in: ${offending.join(", ")}`);
});

// ---- Session locks ----------------------------------------------------------

test("refused on the top-level client (it has $transaction)", async () => {
  const client = { ...fakeTx([LIVE]), $transaction: async () => {} };
  await assert.rejects(locks.lockSessionShared(client, SESSION), /inside an interactive transaction/);
  await assert.rejects(locks.lockSessionExclusive(client, SESSION), /inside an interactive transaction/);
  await assert.rejects(locks.requireActiveSessionShared(client, SESSION), /inside an interactive transaction/);
  assert.equal(client.calls.length, 0, "nothing was sent, not even SET LOCAL");
});

test("shared session lock: lock_timeout first, then SELECT ... FOR SHARE with a bound id", async () => {
  const tx = fakeTx([LIVE]);
  const row = await locks.lockSessionShared(tx, SESSION);
  assert.deepEqual(row, LIVE);
  assert.equal(tx.calls.length, 2);
  assert.deepEqual(tx.calls[0], { kind: "unsafe", sql: "SET LOCAL lock_timeout = '3000ms'", values: [] });
  assert.equal(tx.calls[1].sql, 'SELECT "id", "classId", "isActive" FROM "ClassSession" WHERE "id" = ? FOR SHARE');
  assert.deepEqual(tx.calls[1].values, [SESSION]);
});

test("exclusive session lock: SELECT ... FOR UPDATE", async () => {
  const tx = fakeTx([LIVE]);
  await locks.lockSessionExclusive(tx, SESSION);
  assert.equal(tx.calls[0].sql, "SET LOCAL lock_timeout = '3000ms'");
  assert.equal(tx.calls[1].sql, 'SELECT "id", "classId", "isActive" FROM "ClassSession" WHERE "id" = ? FOR UPDATE');
  assert.deepEqual(tx.calls[1].values, [SESSION]);
});

test("missing session: null; empty id refused before any query", async () => {
  assert.equal(await locks.lockSessionShared(fakeTx([]), SESSION), null);
  const tx = fakeTx();
  await assert.rejects(locks.lockSessionShared(tx, ""), TypeError);
  assert.equal(tx.calls.length, 0);
});

test("requireActiveSessionShared: 404 SESSION_NOT_FOUND / 409 SESSION_ENDED / a frozen lock", async () => {
  await assert.rejects(locks.requireActiveSessionShared(fakeTx([]), SESSION), (e) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.statusCode, 404);
    assert.equal(e.code, "SESSION_NOT_FOUND");
    return true;
  });
  await assert.rejects(locks.requireActiveSessionShared(fakeTx([{ ...LIVE, isActive: false }]), SESSION), (e) => {
    assert.equal(e.statusCode, 409);
    assert.equal(e.code, "SESSION_ENDED");
    return true;
  });
  const lock = await locks.requireActiveSessionShared(fakeTx([LIVE]), SESSION);
  assert.deepEqual({ ...lock }, LIVE);
  assert.ok(Object.isFrozen(lock));
});

// ---- Submission lock and lock order -----------------------------------------

test("submission lock: namespaced key, bound as a parameter, pg_advisory_xact_lock", async () => {
  assert.equal(locks.submissionLockKey("a1", "s1"), "breakout-submission:a1:s1");
  assert.notEqual(locks.submissionLockKey("a1", "s1"), locks.submissionLockKey("s1", "a1"));
  assert.throws(() => locks.submissionLockKey("", "s1"), TypeError);
  assert.throws(() => locks.submissionLockKey("a1", undefined), TypeError);

  const tx = fakeTx([LIVE]);
  const session = await locks.requireActiveSessionShared(tx, SESSION);
  await locks.lockSubmissionSlot(tx, session, "a1", "s1");
  assert.deepEqual(
    tx.calls.map((c) => c.sql),
    [
      "SET LOCAL lock_timeout = '3000ms'",
      'SELECT "id", "classId", "isActive" FROM "ClassSession" WHERE "id" = ? FOR SHARE',
      "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
    ],
    "the session lock (and its lock_timeout) always come first"
  );
  assert.equal(tx.calls[2].kind, "execute", "void result: $executeRaw, not $queryRaw");
  assert.deepEqual(tx.calls[2].values, ["breakout-submission:a1:s1"]);
});

test("lock order enforced at run time: no lock, a forged lock or another transaction's lock is refused", async () => {
  const tx = fakeTx([LIVE]);
  const other = fakeTx([LIVE]);
  const otherLock = await locks.requireActiveSessionShared(other, SESSION);
  const plainShared = await locks.lockSessionShared(tx, SESSION);
  const exclusive = await locks.lockSessionExclusive(tx, SESSION);
  const sent = tx.calls.length;

  for (const [label, session] of [
    ["none", undefined],
    ["null", null],
    ["hand-built", { ...LIVE }],
    ["a copy of a real lock", { ...otherLock }],
    ["plain shared lock", plainShared],
    ["exclusive lock", exclusive],
    ["another transaction's lock", otherLock],
  ]) {
    await assert.rejects(locks.lockSubmissionSlot(tx, session, "a1", "s1"), /Take the session lock/, label);
  }
  assert.equal(tx.calls.length, sent, "no advisory lock was requested");

  const client = { ...fakeTx([LIVE]), $transaction: async () => {} };
  await assert.rejects(locks.lockSubmissionSlot(client, otherLock, "a1", "s1"), /inside an interactive transaction/);
});

test("lock order enforced at compile time (tests/breakout-activities/lock-order.typecheck.ts)", () => {
  const ts = require("typescript");
  const fixture = path.join(root, "tests", "breakout-activities", "lock-order.typecheck.ts");
  // The same fixture without its @ts-expect-error lines: every one of those
  // calls must then be a compile error, proving each line really is rejected.
  const source = fs.readFileSync(fixture, "utf8");
  const expected = (source.match(/^\s*\/\/ @ts-expect-error/gm) || []).length;
  assert.equal(expected, 5);
  // Served from memory next to the fixture (same module resolution); never written to disk.
  const unguarded = path.join(path.dirname(fixture), "lock-order.unguarded.virtual.ts");
  const unguardedSource = source.replace(/^\s*\/\/ @ts-expect-error.*$/gm, "");
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile).config;
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const options = { ...parsed.options, noEmit: true, incremental: false };
  const host = ts.createCompilerHost(options);
  const isVirtual = (file) => path.resolve(file) === unguarded;
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (file, languageVersion, ...rest) =>
    isVirtual(file) ? ts.createSourceFile(file, unguardedSource, languageVersion, true) : getSourceFile.call(host, file, languageVersion, ...rest);
  host.fileExists = (file) => isVirtual(file) || fileExists.call(host, file);
  host.readFile = (file) => (isVirtual(file) ? unguardedSource : readFile.call(host, file));

  const program = ts.createProgram([fixture, unguarded], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const text = (d) => ts.flattenDiagnosticMessageText(d.messageText, "\n");
  const inFile = (file) => diagnostics.filter((d) => d.file && path.resolve(d.file.fileName) === file);
  assert.deepEqual(inFile(fixture).map(text), [], "the fixture type-checks: every @ts-expect-error line is an error");
  assert.equal(inFile(unguarded).length, expected, inFile(unguarded).map(text).join("\n"));
  const elsewhere = diagnostics.filter((d) => !d.file || ![fixture, unguarded].includes(path.resolve(d.file.fileName)));
  assert.deepEqual(elsewhere.map(text), []);
  assert.equal(fs.existsSync(unguarded), false, "the unguarded copy never touches the disk");
});

// ---- Input handling ---------------------------------------------------------

test("a hostile id is only ever a bound value, never SQL text", async () => {
  const evil = `x'; DROP TABLE "ClassSession"; --`;
  const tx = fakeTx([LIVE]);
  const session = await locks.requireActiveSessionShared(tx, evil);
  await locks.lockSubmissionSlot(tx, session, evil, evil);
  for (const call of tx.calls) assert.doesNotMatch(call.sql, /DROP/);
});

test("lock timeout is internal: not exported, and no caller can change it", async () => {
  assert.equal("setBreakoutLockTimeout" in locks, false, "not part of the module's API");
  const lockFunctions = Object.entries(locks).filter(([, v]) => typeof v === "function").map(([k]) => k).sort();
  assert.deepEqual(lockFunctions, [
    "lockSessionExclusive",
    "lockSessionShared",
    "lockSubmissionSlot",
    "requireActiveSessionShared",
    "runBreakoutTransaction",
    "submissionLockKey",
  ]);
  // Extra arguments to the public lock functions never reach SET LOCAL.
  const tx = fakeTx([LIVE]);
  await locks.lockSessionShared(tx, SESSION, 60_000);
  await locks.lockSessionExclusive(tx, SESSION, 60_000);
  const session = await locks.requireActiveSessionShared(tx, SESSION, 60_000);
  await locks.lockSubmissionSlot(tx, session, "a1", "s1", 60_000);
  const timeouts = tx.calls.filter((c) => c.sql.startsWith("SET LOCAL"));
  assert.equal(timeouts.length, 3, "one per session lock");
  for (const call of timeouts) {
    assert.equal(call.sql, `SET LOCAL lock_timeout = '${locks.BREAKOUT_LOCK_TIMEOUT_MS}ms'`);
  }
});

test("every lock operation is bounded by exactly BREAKOUT_LOCK_TIMEOUT_MS, set before it locks", async () => {
  const LOCK_SQL = /FOR SHARE|FOR UPDATE|pg_advisory_xact_lock/;
  const expected = `SET LOCAL lock_timeout = '${locks.BREAKOUT_LOCK_TIMEOUT_MS}ms'`;
  const runs = {
    lockSessionShared: (tx) => locks.lockSessionShared(tx, SESSION),
    lockSessionExclusive: (tx) => locks.lockSessionExclusive(tx, SESSION),
    requireActiveSessionShared: (tx) => locks.requireActiveSessionShared(tx, SESSION),
    lockSubmissionSlot: async (tx) => locks.lockSubmissionSlot(tx, await locks.requireActiveSessionShared(tx, SESSION), "a1", "s1"),
  };
  for (const [name, run] of Object.entries(runs)) {
    const tx = fakeTx([LIVE]);
    await run(tx);
    const sqls = tx.calls.map((c) => c.sql);
    const firstLock = sqls.findIndex((s) => LOCK_SQL.test(s));
    assert.ok(firstLock > 0, `${name}: a lock statement was sent`);
    assert.equal(sqls[0], expected, `${name}: the timeout is the first statement`);
    for (const [i, s] of sqls.entries()) {
      if (s.startsWith("SET LOCAL")) assert.equal(s, expected, `${name}: statement ${i}`);
    }
    assert.ok(locks.BREAKOUT_LOCK_TIMEOUT_MS < locks.BREAKOUT_TRANSACTION_OPTIONS.timeout);
  }
});
