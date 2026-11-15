/*
 * Teacher storage quota, Stage 3.1: the per-teacher quota advisory lock
 * (lib/storage-quota/locks.ts) and the global lock order.
 *
 *   npm run test:storage-quota
 *
 * The SQL is recorded through a fake transaction client: this proves what is
 * SENT, not PostgreSQL's blocking behaviour across connections (that is
 * tests/storage-quota/usage.db.test.cjs, skipped without a local test database).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const L = require(path.join(root, "lib", "storage-quota", "locks.ts"));
const RL = require(path.join(root, "lib", "recorded-lectures", "upload-locks.ts"));

const T1 = "11111111-1111-4111-8111-111111111111";

function fakeTx() {
  const calls = [];
  return {
    calls,
    $executeRaw: async (strings, ...values) => calls.push(["raw", strings.join("?"), values]),
    $executeRawUnsafe: async (sql) => calls.push(["unsafe", sql]),
  };
}

test("the lock: pg_advisory_xact_lock on a per-teacher key in its own namespace, as a bound parameter", async () => {
  const tx = fakeTx();
  await L.setStorageQuotaLockTimeout(tx);
  await L.lockTeacherStorageQuota(tx, T1);
  assert.deepEqual(tx.calls, [
    ["unsafe", "SET LOCAL lock_timeout = '10000ms'"],
    ["raw", "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [`storage-quota:teacher:${T1}`]],
  ]);
});

test("the key: per teacher, never equal to any Recorded Lectures lock key; invalid ids are refused", () => {
  const T2 = "22222222-2222-4222-8222-222222222222";
  assert.notEqual(L.teacherStorageQuotaLockKey(T1), L.teacherStorageQuotaLockKey(T2));
  assert.notEqual(L.teacherStorageQuotaLockKey(T1), RL.teacherUploadLockKey(T1), "distinct from the RL per-teacher lock");
  assert.notEqual(L.teacherStorageQuotaLockKey(T1), RL.CAPACITY_LOCK_KEY);
  for (const bad of ["", "../x", "a b", "a:b", "x".repeat(129), null, 5]) {
    assert.throws(() => L.teacherStorageQuotaLockKey(bad), TypeError, String(bad));
  }
});

test("the lock refuses to run outside an interactive transaction (an xact lock there would be released at once)", async () => {
  const prismaLike = { ...fakeTx(), $transaction: async () => {} };
  await assert.rejects(L.lockTeacherStorageQuota(prismaLike, T1), /inside an interactive transaction/);
  await assert.rejects(L.setStorageQuotaLockTimeout(prismaLike), /inside an interactive transaction/);
  await assert.rejects(L.lockTeacherStorageQuota(null, T1), /inside an interactive transaction/);
  assert.equal(prismaLike.calls.length, 0, "nothing was sent");
});

// ---- Lock order ---------------------------------------------------------------------------------------

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const LEVEL = { lockTeacherUploads: 1, lockTeacherStorageQuota: 2, lockUploadCapacity: 3 };

/** The awaited lock levels of every function in one source text, in source order. */
function sequencesOf(text, name) {
  const ts = require(require.resolve("typescript", { paths: [root] }));
  const sequences = [];
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, name.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visitFunction = (fn) => {
    const levels = [];
    const walk = (node) => {
      if (node !== fn && ts.isFunctionLike(node)) return; // nested functions are their own sequences
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && LEVEL[node.expression.text] && node.parent && ts.isAwaitExpression(node.parent)) {
        levels.push(LEVEL[node.expression.text]);
      }
      ts.forEachChild(node, walk);
    };
    walk(fn);
    if (levels.length > 0) sequences.push({ where: `${name}:${sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1}`, levels });
  };
  const visit = (node) => {
    if (ts.isFunctionLike(node)) visitFunction(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sequences;
}

const orderViolations = (sequences) =>
  sequences.filter(({ levels }) => levels.some((level, i) => i > 0 && level < levels[i - 1])).map((s) => `${s.where}: ${s.levels.join(" -> ")}`);

/** For every function body in app / services / lib that awaits these locks: the levels in source order. */
function lockSequences() {
  const sequences = [];
  for (const dir of ["app", "services", "lib"]) {
    for (const file of listFiles(path.join(root, dir))) {
      const text = fs.readFileSync(file, "utf8");
      if (!/lock(TeacherUploads|TeacherStorageQuota|UploadCapacity)\(/.test(text)) continue;
      sequences.push(...sequencesOf(text, path.relative(root, file)));
    }
  }
  return sequences;
}

test("the order check itself detects a backwards order (synthetic source)", () => {
  const bad = `async function f(tx, t) { await lockTeacherUploads(tx, t); await lockUploadCapacity(tx); await lockTeacherStorageQuota(tx, t); }`;
  const good = `async function g(tx, t) { await lockTeacherUploads(tx, t); await lockTeacherStorageQuota(tx, t); await lockUploadCapacity(tx); }`;
  const quotaFirst = `async function h(tx, t) { await lockTeacherStorageQuota(tx, t); await lockTeacherUploads(tx, t); }`;
  assert.deepEqual(orderViolations(sequencesOf(bad, "bad.ts")), ["bad.ts:1: 1 -> 3 -> 2"]);
  assert.deepEqual(orderViolations(sequencesOf(good, "good.ts")), []);
  assert.equal(orderViolations(sequencesOf(quotaFirst, "h.ts")).length, 1);
});

test("lock order everywhere: RL teacher lock (1) -> storage quota lock (2) -> global capacity lock (3), never backwards", () => {
  const sequences = lockSequences();
  // The existing Recorded Lectures start / chunk / completion code already takes 1 -> 3.
  assert.ok(sequences.some((s) => s.levels.includes(1) && s.levels.includes(3)), "the scan sees the Recorded Lectures transactions");
  assert.deepEqual(orderViolations(sequences), [], "a lower-level lock acquired after a higher one");
});

test("Stages 3.3 / 3.4 / 3.6: the quota lock is taken only by the reservation service, the admin limit change and the assignment deletion finalize (alone) and the Recorded Lecture upload start (1 -> 2 -> 3)", () => {
  const callers = lockSequences().filter((s) => s.levels.includes(2) && !s.where.startsWith(`lib${path.sep}storage-quota`));
  const reservation = callers.filter((c) => c.where.startsWith(path.join("services", "storage-reservation-service.ts")));
  const admin = callers.filter((c) => c.where.startsWith(path.join("services", "admin-teacher-storage-service.ts")));
  const recording = callers.filter((c) => c.where.startsWith(path.join("services", "recorded-lecture-upload-service.ts")));
  const deletion = callers.filter((c) => c.where.startsWith(path.join("services", "permanent-deletion-service.ts")));
  assert.deepEqual(reservation.map((c) => c.levels), [[2]], "Notes / submissions: the quota lock alone");
  assert.deepEqual(admin.map((c) => c.levels), [[2]], "an admin limit change: the quota lock alone");
  assert.deepEqual(recording.map((c) => c.levels), [[1, 2, 3]], "the recording start: teacher upload lock, quota lock, capacity lock");
  assert.deepEqual(deletion.map((c) => c.levels), [[2]], "Stage 3.6: an assignment's deletion finalize (serialised with submission commits): the quota lock alone");
  assert.equal(callers.length, reservation.length + admin.length + recording.length + deletion.length, callers.map((c) => c.where).join(", "));
  // The Notes / submission routes and services never take a lock themselves.
  for (const rel of [["app", "api", "lectures", "[id]", "notes", "route.ts"], ["app", "api", "assignments", "[assignmentId]", "submit", "route.ts"], ["services", "lecture-service.ts"]]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, ...rel), "utf8"), /lock(TeacherUploads|UploadCapacity|TeacherStorageQuota)\(/, rel.join("/"));
  }
});
