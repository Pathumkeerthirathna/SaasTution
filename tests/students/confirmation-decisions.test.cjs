/*
 * Approval decisions and their history (services/student-service.ts:
 * decideStudentConfirmation / confirmStudent / declineStudent /
 * confirmAllPendingStudents).
 *
 *   npm run test:confirmation
 *
 * Runs the real service through tsx against an in-memory model of the parts
 * of PostgreSQL the protocol relies on:
 *   - row locks on Student (FOR NO KEY UPDATE, also taken by UPDATE): one
 *     holder per row, waiters granted in order, held until the transaction
 *     ends; a blocked request can be made to fail with Prisma's lock-timeout
 *     error shape;
 *   - READ COMMITTED: the lock SELECT returns the row as committed AFTER the
 *     lock wait, and the bulk SELECT re-checks its WHERE on rows it waited
 *     for (rows that no longer match are skipped);
 *   - transactions: writes are visible to others only at commit, discarded on
 *     error;
 *   - the history table's CHECK constraints (a violation fails the insert).
 * The fee-waiver recalculation is replaced by a recorder.
 *
 * NOT covered here: real PostgreSQL. See confirmation-history.db.test.cjs
 * (opt-in, needs an explicitly configured throwaway local database).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

const T = "teacher-1";
const OTHER_T = "teacher-2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let log = [];
const record = (entry) => log.push(entry);

// ---- Row locks on Student ----------------------------------------------------------

function lockTimeoutError() {
  // Prisma 5.22's shape for a raw query that hit lock_timeout (SQLSTATE 55P03).
  return Object.assign(new Error("canceling statement due to lock timeout"), {
    name: "PrismaClientKnownRequestError",
    code: "P2010",
    meta: { code: "55P03" },
  });
}

const locks = {
  held: new Map(), // row -> owner
  waiting: [], // { row, owner, grant }
  failWhenBlocked: false,

  async acquire(row, owner) {
    const holder = this.held.get(row);
    if (holder === owner) return;
    if (holder === undefined && !this.waiting.some((w) => w.row === row)) {
      this.held.set(row, owner);
      return;
    }
    if (this.failWhenBlocked) throw lockTimeoutError();
    record(`${owner}:waits:${row}`);
    await new Promise((grant) => this.waiting.push({ row, owner, grant }));
    record(`${owner}:got:${row}`);
  },

  release(owner) {
    for (const [row, holder] of [...this.held]) if (holder === owner) this.held.delete(row);
    let granted = true;
    while (granted) {
      granted = false;
      const index = this.waiting.findIndex((w) => !this.held.has(w.row));
      if (index !== -1) {
        const [next] = this.waiting.splice(index, 1);
        this.held.set(next.row, next.owner);
        next.grant();
        granted = true;
      }
    }
  },

  holds(row, owner) {
    return this.held.get(row) === owner;
  },
};

// ---- Committed state ---------------------------------------------------------------

let db;

function student(id, over = {}) {
  db.students.set(id, {
    id,
    teacherId: T,
    status: 0,
    registrationSource: "PUBLIC_CLASS",
    confirmationStatus: "PENDING",
    confirmedAt: null,
    confirmedById: null,
    approvedAt: null,
    ...over,
  });
}

function resetDb() {
  db = { students: new Map(), history: [] };
  log = [];
  txSeq = 0;
  locks.held.clear();
  locks.waiting.length = 0;
  locks.failWhenBlocked = false;
  hooks.afterLock = null;
  recalculated.length = 0;
  transactionOptions.length = 0;
  rawStatements.length = 0;
}

const row = (id) => db.students.get(id);
const historyOf = (id) => db.history.filter((h) => h.studentId === id);

// ---- History CHECK constraints (as in the migration) ------------------------------

function checkHistoryRow(h) {
  const violations = [];
  if (h.fromStatus === h.toStatus) violations.push("status_change");
  if (h.toStatus === "PENDING") violations.push("toStatus");
  if ((h.source === "BULK") !== (h.batchId !== null && h.batchId !== undefined)) violations.push("batch");
  if (h.source === "BULK" && !(h.fromStatus === "PENDING" && h.toStatus === "APPROVED")) violations.push("bulk_transition");
  if (h.previousConfirmedAt && !(h.previousConfirmedAt.getTime() < h.decidedAt.getTime())) violations.push("order");
  if (!(h.decidedAt instanceof Date)) violations.push("decidedAt");
  if (violations.length > 0) {
    throw Object.assign(new Error(`new row violates check constraint(s): ${violations.join(", ")}`), {
      name: "PrismaClientKnownRequestError",
      code: "P2010",
      meta: { code: "23514" },
    });
  }
}

// ---- Hooks the tests use to pause a transaction ----------------------------------

const hooks = { afterLock: null }; // async (label, studentIds) => void

// ---- Transactions ------------------------------------------------------------------

const transactionOptions = [];
const rawStatements = [];
let txSeq = 0;

const matchesWhere = (r, where) =>
  Object.entries(where).every(([key, cond]) => {
    if (cond && typeof cond === "object" && !(cond instanceof Date) && "in" in cond) return cond.in.includes(r[key]);
    if (cond instanceof Date) return r[key] instanceof Date && r[key].getTime() === cond.getTime();
    return (r[key] ?? null) === (cond ?? null);
  });

function makeTx(label) {
  const tx = { updates: new Map(), history: [] };
  const visible = (id) => {
    const committed = db.students.get(id);
    return committed ? { ...committed, ...(tx.updates.get(id) || {}) } : null;
  };
  const write = (id, data) => {
    assert.ok(locks.holds(id, label), `${label} updated ${id} without holding its row lock`);
    tx.updates.set(id, { ...(tx.updates.get(id) || {}), ...data });
  };

  tx.client = {
    $executeRawUnsafe: async (sql) => {
      rawStatements.push({ tx: label, sql });
      if (/^SET LOCAL lock_timeout = '3000ms'$/.test(sql)) return 0;
      throw new Error("unexpected raw SQL " + sql);
    },
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join("?");
      rawStatements.push({ tx: label, sql, values });
      if (!/FROM "Student"/.test(sql) || !/FOR NO KEY UPDATE$/.test(sql.trim())) throw new Error("unexpected raw SQL " + sql);

      if (/WHERE "id" = \? AND "teacherId" = \?/.test(sql)) {
        const [id, teacherId] = values;
        const candidate = db.students.get(id);
        if (!candidate || candidate.teacherId !== teacherId) return [];
        await locks.acquire(id, label);
        record(`${label}:locked:${id}`);
        const current = visible(id);
        if (hooks.afterLock) await hooks.afterLock(label, [id]);
        return current.teacherId === teacherId
          ? [{ id, confirmationStatus: current.confirmationStatus, confirmedAt: current.confirmedAt }]
          : [];
      }

      assert.match(sql, /WHERE "teacherId" = \? AND "status" = 0 AND "confirmationStatus" = 'PENDING'\s+ORDER BY "id"/);
      const [teacherId] = values;
      const matches = (r) => r.teacherId === teacherId && r.status === 0 && r.confirmationStatus === "PENDING";
      // Candidates from the statement's snapshot, locked in id order; a row
      // that changed while we waited is re-checked against the WHERE.
      const candidates = [...db.students.values()].filter(matches).map((r) => r.id).sort();
      const result = [];
      for (const id of candidates) {
        await locks.acquire(id, label);
        const latest = db.students.get(id);
        if (matches(latest)) {
          result.push({ id, confirmedAt: latest.confirmedAt });
          record(`${label}:locked:${id}`);
        } else {
          record(`${label}:skipped:${id}`);
        }
      }
      if (hooks.afterLock) await hooks.afterLock(label, result.map((r) => r.id));
      return result;
    },
    student: {
      update: async ({ where, data }) => {
        assert.deepEqual(Object.keys(where), ["id"]);
        write(where.id, data);
        return visible(where.id);
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const id of db.students.keys()) {
          const current = visible(id);
          if (matchesWhere(current, where)) {
            write(id, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    studentConfirmationHistory: {
      create: async ({ data }) => {
        const entry = { id: `h-${db.history.length + tx.history.length + 1}`, ...data };
        checkHistoryRow(entry);
        tx.history.push(entry);
        return entry;
      },
      createMany: async ({ data }) => {
        for (const item of data) {
          const entry = { id: `h-${db.history.length + tx.history.length + 1}`, ...item };
          checkHistoryRow(entry);
          tx.history.push(entry);
        }
        return { count: data.length };
      },
    },
  };

  tx.commit = () => {
    for (const [id, data] of tx.updates) Object.assign(db.students.get(id), data);
    db.history.push(...tx.history);
  };

  return tx;
}

const fakePrisma = {
  $transaction: async (fn, options) => {
    assert.equal(typeof fn, "function", "an interactive transaction");
    transactionOptions.push(options);
    txSeq += 1;
    const label = currentLabel ?? `tx${txSeq}`;
    const tx = makeTx(label);
    try {
      const result = await fn(tx.client);
      tx.commit();
      record(`${label}:commit`);
      return result;
    } catch (error) {
      record(`${label}:rollback`);
      throw error;
    } finally {
      locks.release(label);
    }
  },
};

// Label the next transaction(s) started by a call (synchronously, before its first await).
let currentLabel = null;
function labelled(label, fn) {
  currentLabel = label;
  try {
    return fn();
  } finally {
    currentLabel = null;
  }
}

// ---- Module fakes ------------------------------------------------------------------

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

const recalculated = [];
fake("lib/prisma.ts", { prisma: fakePrisma });
fake("services/fee-waiver-events.ts", {
  recalculateAfterStudentDecision: async (studentId) => {
    recalculated.push(studentId);
    record(`recalculate:${studentId}`);
  },
});

const service = require(path.join(root, "services", "student-service.ts"));
const { confirmationTimeline } = require(path.join(root, "lib", "student-confirmation-history.ts"));

const appError = (status, code) => (error) => {
  assert.equal(error.name, "AppError", String(error && error.stack));
  assert.equal(error.statusCode, status);
  assert.equal(error.code, code);
  return true;
};

// Wait until a labelled transaction is blocked on a lock (or a condition holds).
async function until(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`condition never met: ${JSON.stringify(log)}`);
}

// A test value: the chain checks do not depend on the feature start.
const HISTORY_CONTEXT = { approvalFeatureStartedAt: new Date("2026-07-28T00:00:00.000Z") };

function assertTruthfulChain(id) {
  const s = row(id);
  const timeline = confirmationTimeline(
    { confirmationStatus: s.confirmationStatus, confirmedAt: s.confirmedAt, approvedAt: s.approvedAt },
    historyOf(id),
    HISTORY_CONTEXT
  );
  assert.notEqual(timeline, null, `history of ${id} is a valid chain: ${JSON.stringify(historyOf(id))}`);
  assert.ok(
    timeline.every((segment) => segment.reason !== "APPROVED_AT_CONFLICT"),
    `approvedAt of ${id} is consistent with its history`
  );
}

test.beforeEach(() => resetDb());

// ---- Individual decisions ------------------------------------------------------------

test("approve: status, confirmedAt, confirmedById, first approvedAt and one truthful history row, all in one locked transaction", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-10T04:00:00.000Z") });
  student("s1");

  const result = await service.confirmStudent(T, "s1");

  assert.deepEqual(result, { fromStatus: "PENDING", toStatus: "APPROVED" });
  const at = new Date("2026-11-10T04:00:00.000Z");
  assert.equal(row("s1").confirmationStatus, "APPROVED");
  assert.deepEqual(row("s1").confirmedAt, at);
  assert.equal(row("s1").confirmedById, T);
  assert.deepEqual(row("s1").approvedAt, at);
  assert.deepEqual(historyOf("s1").map(({ id, ...h }) => h), [
    {
      studentId: "s1",
      fromStatus: "PENDING",
      toStatus: "APPROVED",
      decidedAt: at,
      previousConfirmedAt: null,
      decidedByTeacherId: T,
      source: "INDIVIDUAL",
      batchId: null,
    },
  ]);
  assert.deepEqual(transactionOptions, [{ maxWait: 5000, timeout: 15000 }]);
  assert.deepEqual(rawStatements.map((s) => s.sql.replace(/\s+/g, " ").trim()), [
    "SET LOCAL lock_timeout = '3000ms'",
    'SELECT "id", "confirmationStatus", "confirmedAt" FROM "Student" WHERE "id" = ? AND "teacherId" = ? FOR NO KEY UPDATE',
  ]);
  assert.deepEqual(rawStatements[1].values, ["s1", T], "bind parameters, never interpolated");
  assert.deepEqual(recalculated, ["s1"]);
  assert.ok(log.indexOf("tx1:commit") < log.indexOf("recalculate:s1"), "fee waivers recalculated after the commit");
});

test("decline a pending student: REJECTED, approvedAt untouched, no fee-waiver recalculation (nothing was approved)", async () => {
  student("s1");
  await service.declineStudent(T, "s1");
  assert.equal(row("s1").confirmationStatus, "REJECTED");
  assert.equal(row("s1").confirmedById, T);
  assert.equal(row("s1").approvedAt, null);
  assert.deepEqual(historyOf("s1").map((h) => [h.fromStatus, h.toStatus, h.source]), [["PENDING", "REJECTED", "INDIVIDUAL"]]);
  assert.deepEqual(recalculated, []);
});

test("decline after approval and re-approval: approvedAt keeps the FIRST approval; each step recorded with its previous confirmedAt", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T00:00:00.000Z") });
  student("s1");

  await service.confirmStudent(T, "s1");
  const first = row("s1").confirmedAt;
  t.mock.timers.setTime(Date.parse("2026-11-05T00:00:00.000Z"));
  await service.declineStudent(T, "s1");
  const second = row("s1").confirmedAt;
  t.mock.timers.setTime(Date.parse("2026-11-09T00:00:00.000Z"));
  await service.confirmStudent(T, "s1");

  assert.deepEqual(row("s1").approvedAt, first, "re-approval never overwrites approvedAt");
  assert.deepEqual(row("s1").confirmedAt, new Date("2026-11-09T00:00:00.000Z"));
  assert.deepEqual(
    historyOf("s1").map((h) => [h.fromStatus, h.toStatus, h.previousConfirmedAt && h.previousConfirmedAt.toISOString()]),
    [
      ["PENDING", "APPROVED", null],
      ["APPROVED", "REJECTED", first.toISOString()],
      ["REJECTED", "APPROVED", second.toISOString()],
    ]
  );
  assert.deepEqual(recalculated, ["s1", "s1", "s1"], "APPROVED is the old or the new status every time");
  assertTruthfulChain("s1");
});

test("a student created already approved (teacher / import, confirmedAt null) can be declined; history starts from APPROVED with no previous time", async () => {
  student("s1", { registrationSource: "TEACHER", confirmationStatus: "APPROVED" });
  await service.declineStudent(T, "s1");
  assert.deepEqual(historyOf("s1").map((h) => [h.fromStatus, h.toStatus, h.previousConfirmedAt]), [["APPROVED", "REJECTED", null]]);
  assert.equal(row("s1").approvedAt, null, "no approval decision was ever made; approvedAt stays null");
  assert.deepEqual(recalculated, ["s1"]);
  assertTruthfulChain("s1");
});

test("inactive students can be decided individually", async () => {
  student("s1", { status: 1 });
  await service.confirmStudent(T, "s1");
  assert.equal(row("s1").confirmationStatus, "APPROVED");
});

test("missing student, or another teacher's: 404 STUDENT_NOT_FOUND, nothing locked or written", async () => {
  student("mine");
  student("theirs", { teacherId: OTHER_T });
  await assert.rejects(service.confirmStudent(T, "nope"), appError(404, "STUDENT_NOT_FOUND"));
  await assert.rejects(service.declineStudent(T, "theirs"), appError(404, "STUDENT_NOT_FOUND"));
  assert.equal(row("theirs").confirmationStatus, "PENDING");
  assert.deepEqual(db.history, []);
  assert.deepEqual(recalculated, []);
});

test("same-status decisions: 409 STUDENT_ALREADY_APPROVED / STUDENT_ALREADY_REJECTED, no write, no history", async () => {
  student("a", { confirmationStatus: "APPROVED", confirmedAt: new Date("2026-10-01T00:00:00.000Z") });
  student("r", { confirmationStatus: "REJECTED", confirmedAt: new Date("2026-10-01T00:00:00.000Z") });
  const before = JSON.stringify([...db.students.values()]);

  await assert.rejects(service.confirmStudent(T, "a"), appError(409, "STUDENT_ALREADY_APPROVED"));
  await assert.rejects(service.declineStudent(T, "r"), appError(409, "STUDENT_ALREADY_REJECTED"));
  assert.equal(JSON.stringify([...db.students.values()]), before);
  assert.deepEqual(db.history, []);
  assert.deepEqual(recalculated, []);
  assert.deepEqual(locks.held, new Map(), "locks released after the rollback");
});

test("confirmedAt is strictly increasing: a stored decision in the future (or the same millisecond) is followed 1 ms later", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-10T04:00:00.000Z") });
  const future = new Date("2026-11-10T05:00:00.000Z");
  student("s1", { confirmationStatus: "REJECTED", confirmedAt: future });

  await service.confirmStudent(T, "s1");
  assert.deepEqual(row("s1").confirmedAt, new Date(future.getTime() + 1));
  await service.declineStudent(T, "s1");
  assert.deepEqual(row("s1").confirmedAt, new Date(future.getTime() + 2), "same frozen clock: still strictly later");
  assertTruthfulChain("s1");
});

test("nextDecisionInstant: now, unless that is not strictly after the previous decision", () => {
  const now = new Date("2026-11-10T04:00:00.000Z");
  assert.equal(service.nextDecisionInstant(now, null), now);
  assert.deepEqual(service.nextDecisionInstant(now, new Date("2026-11-10T03:59:59.999Z")), now);
  assert.deepEqual(service.nextDecisionInstant(now, now), new Date(now.getTime() + 1));
});

test("a lock timeout or deadlock: 409 STUDENT_DECISION_BUSY, nothing written", async () => {
  student("s1");
  locks.held.set("s1", "someone-else");
  locks.failWhenBlocked = true;
  await assert.rejects(service.confirmStudent(T, "s1"), appError(409, "STUDENT_DECISION_BUSY"));

  locks.failWhenBlocked = false;
  locks.held.clear();
  const deadlock = Object.assign(new Error("deadlock detected"), {
    name: "PrismaClientKnownRequestError",
    code: "P2010",
    meta: { code: "40P01" },
  });
  hooks.afterLock = async () => {
    throw deadlock;
  };
  await assert.rejects(service.declineStudent(T, "s1"), appError(409, "STUDENT_DECISION_BUSY"));
  assert.equal(row("s1").confirmationStatus, "PENDING");
  assert.deepEqual(db.history, []);
  assert.deepEqual(recalculated, []);
});

test("any other failure rolls everything back (no status change without its history row)", async () => {
  student("s1");
  const original = fakePrisma.$transaction;
  // Make the history insert fail.
  let failed = false;
  fakePrisma.$transaction = async (fn, options) =>
    original(async (client) => {
      client.studentConfirmationHistory.create = async () => {
        failed = true;
        throw new Error("insert failed");
      };
      return fn(client);
    }, options);
  try {
    await assert.rejects(service.confirmStudent(T, "s1"), /insert failed/);
  } finally {
    fakePrisma.$transaction = original;
  }
  assert.ok(failed);
  assert.equal(row("s1").confirmationStatus, "PENDING");
  assert.equal(row("s1").approvedAt, null);
  assert.deepEqual(db.history, []);
  assert.deepEqual(recalculated, []);
});

// ---- Concurrent individual decisions --------------------------------------------------

test("concurrent opposite decisions serialize on the row lock and are both recorded truthfully (fixes the stale-read fee-waiver bug)", async () => {
  student("s1");
  const release = deferred();
  hooks.afterLock = async (label) => {
    if (label === "approve") await release.promise;
  };

  const approve = labelled("approve", () => service.confirmStudent(T, "s1"));
  await until(() => log.includes("approve:locked:s1"));
  const decline = labelled("decline", () => service.declineStudent(T, "s1"));
  await until(() => log.includes("decline:waits:s1"));

  assert.equal(row("s1").confirmationStatus, "PENDING", "nothing visible before the commit");
  hooks.afterLock = null;
  release.resolve();
  const [approved, declined] = await Promise.all([approve, decline]);

  assert.deepEqual(approved, { fromStatus: "PENDING", toStatus: "APPROVED" });
  assert.deepEqual(declined, { fromStatus: "APPROVED", toStatus: "REJECTED" }, "the decline saw the committed approval");
  assert.equal(row("s1").confirmationStatus, "REJECTED");
  assert.deepEqual(historyOf("s1").map((h) => [h.fromStatus, h.toStatus]), [
    ["PENDING", "APPROVED"],
    ["APPROVED", "REJECTED"],
  ]);
  assertTruthfulChain("s1");
  // Before Stage 4 the decline read PENDING and skipped the recalculation,
  // leaving the approval's waiver on a rejected student.
  assert.deepEqual(recalculated, ["s1", "s1"]);
  assert.ok(log.indexOf("approve:commit") < log.indexOf("decline:got:s1"));
});

test("concurrent duplicate approvals: one history row; the second gets 409 STUDENT_ALREADY_APPROVED", async () => {
  student("s1");
  const release = deferred();
  hooks.afterLock = async (label) => {
    if (label === "first") await release.promise;
  };

  const first = labelled("first", () => service.confirmStudent(T, "s1"));
  await until(() => log.includes("first:locked:s1"));
  const second = labelled("second", () => service.confirmStudent(T, "s1"));
  await until(() => log.includes("second:waits:s1"));
  hooks.afterLock = null;
  release.resolve();

  await first;
  await assert.rejects(second, appError(409, "STUDENT_ALREADY_APPROVED"));
  assert.equal(historyOf("s1").length, 1);
  assert.deepEqual(recalculated, ["s1"]);
});

test("a decision that waited for the lock is recorded strictly after the one it waited for, even with a frozen clock", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-10T04:00:00.000Z") });
  student("s1");
  const release = deferred();
  hooks.afterLock = async (label) => {
    if (label === "first") await release.promise;
  };
  const first = labelled("first", () => service.confirmStudent(T, "s1"));
  await until(() => log.includes("first:locked:s1"));
  const second = labelled("second", () => service.declineStudent(T, "s1"));
  await until(() => log.includes("second:waits:s1"));
  hooks.afterLock = null;
  release.resolve();
  await Promise.all([first, second]);

  const [a, b] = historyOf("s1");
  assert.equal(b.decidedAt.getTime(), a.decidedAt.getTime() + 1);
  assert.deepEqual(b.previousConfirmedAt, a.decidedAt);
  assertTruthfulChain("s1");
});

// ---- Bulk approval ---------------------------------------------------------------------

test("bulk: only this teacher's ACTIVE pending students, locked in id order, one shared batchId and instant, count = approved", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-10T04:00:00.000Z") });
  student("p-b");
  student("p-a", { approvedAt: new Date("2026-10-01T00:00:00.000Z") });
  student("inactive", { status: 1 });
  student("deleted", { status: 2 });
  student("approved", { confirmationStatus: "APPROVED" });
  student("rejected", { confirmationStatus: "REJECTED", confirmedAt: new Date("2026-10-02T00:00:00.000Z") });
  student("other", { teacherId: OTHER_T });

  const count = await service.confirmAllPendingStudents(T);

  assert.equal(count, 2);
  const at = new Date("2026-11-10T04:00:00.000Z");
  for (const id of ["p-a", "p-b"]) {
    assert.equal(row(id).confirmationStatus, "APPROVED");
    assert.deepEqual(row(id).confirmedAt, at);
    assert.equal(row(id).confirmedById, T);
  }
  assert.deepEqual(row("p-b").approvedAt, at);
  assert.deepEqual(row("p-a").approvedAt, new Date("2026-10-01T00:00:00.000Z"), "approvedAt only where null");
  for (const id of ["inactive", "deleted", "other"]) {
    assert.equal(row(id).confirmationStatus, "PENDING", id);
    assert.equal(row(id).confirmedById, null, id);
  }
  assert.equal(row("rejected").confirmationStatus, "REJECTED");

  assert.equal(db.history.length, 2);
  const [batchId] = new Set(db.history.map((h) => h.batchId));
  assert.match(batchId, UUID);
  assert.deepEqual(
    db.history.map(({ id, batchId: b, ...h }) => h),
    ["p-a", "p-b"].map((studentId) => ({
      studentId,
      fromStatus: "PENDING",
      toStatus: "APPROVED",
      decidedAt: at,
      previousConfirmedAt: null,
      decidedByTeacherId: T,
      source: "BULK",
    }))
  );
  assert.deepEqual(log.filter((e) => e.includes(":locked:")), ["tx1:locked:p-a", "tx1:locked:p-b"], "id order");
  assert.deepEqual(recalculated, ["p-a", "p-b"], "only the students actually approved");
  assert.deepEqual(transactionOptions, [{ maxWait: 5000, timeout: 15000 }]);
});

test("bulk: a second run gets a new batchId; nothing pending → 0, no history, no recalculation", async () => {
  student("p1");
  await service.confirmAllPendingStudents(T);
  student("p2");
  await service.confirmAllPendingStudents(T);
  assert.notEqual(historyOf("p1")[0].batchId, historyOf("p2")[0].batchId);

  recalculated.length = 0;
  const before = db.history.length;
  assert.equal(await service.confirmAllPendingStudents(T), 0);
  assert.equal(db.history.length, before);
  assert.deepEqual(recalculated, []);
});

test("bulk: the shared instant is strictly after every locked row's previous confirmedAt", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-10T04:00:00.000Z") });
  // Not produced by the application (nothing returns a student to PENDING),
  // but the CHECK constraint must never be violated by odd data.
  student("p1", { confirmedAt: new Date("2026-11-10T06:00:00.000Z") });
  student("p2");
  await service.confirmAllPendingStudents(T);
  assert.deepEqual(row("p1").confirmedAt, new Date("2026-11-10T06:00:00.001Z"));
  assert.deepEqual(row("p2").confirmedAt, new Date("2026-11-10T06:00:00.001Z"), "one shared instant");
  assert.deepEqual(historyOf("p1")[0].previousConfirmedAt, new Date("2026-11-10T06:00:00.000Z"));
});

test("bulk with a concurrent individual decline: the declined student is skipped and never gets approvedAt (fixes the bulk approvedAt bug)", async () => {
  student("s1");
  student("s2");
  student("s3");
  const release = deferred();
  hooks.afterLock = async (label) => {
    if (label === "decline") await release.promise;
  };

  const decline = labelled("decline", () => service.declineStudent(T, "s2"));
  await until(() => log.includes("decline:locked:s2"));
  const bulk = labelled("bulk", () => service.confirmAllPendingStudents(T));
  await until(() => log.includes("bulk:waits:s2"));
  hooks.afterLock = null;
  release.resolve();

  await decline;
  const count = await bulk;

  assert.equal(count, 2);
  assert.equal(row("s2").confirmationStatus, "REJECTED");
  assert.equal(row("s2").approvedAt, null, "before Stage 4 bulk set approvedAt on a student it did not approve");
  assert.ok(log.includes("bulk:skipped:s2"));
  assert.deepEqual(historyOf("s2").map((h) => [h.fromStatus, h.toStatus, h.source]), [["PENDING", "REJECTED", "INDIVIDUAL"]]);
  assert.deepEqual(db.history.filter((h) => h.source === "BULK").map((h) => h.studentId), ["s1", "s3"]);
  assert.deepEqual(recalculated, ["s1", "s3"]);
  for (const id of ["s1", "s2", "s3"]) assertTruthfulChain(id);
});

test("an individual decline that arrives during a bulk approval waits and records APPROVED -> REJECTED", async () => {
  student("s1");
  const release = deferred();
  hooks.afterLock = async (label) => {
    if (label === "bulk") await release.promise;
  };
  const bulk = labelled("bulk", () => service.confirmAllPendingStudents(T));
  await until(() => log.includes("bulk:locked:s1"));
  const decline = labelled("decline", () => service.declineStudent(T, "s1"));
  await until(() => log.includes("decline:waits:s1"));
  hooks.afterLock = null;
  release.resolve();
  await Promise.all([bulk, decline]);

  assert.deepEqual(historyOf("s1").map((h) => [h.fromStatus, h.toStatus, h.source]), [
    ["PENDING", "APPROVED", "BULK"],
    ["APPROVED", "REJECTED", "INDIVIDUAL"],
  ]);
  assert.notEqual(row("s1").approvedAt, null, "it really was approved, briefly");
  assertTruthfulChain("s1");
});

test("two concurrent bulk approvals: no deadlock, no duplicate history; the second approves nothing", async () => {
  student("s1");
  student("s2");
  const release = deferred();
  hooks.afterLock = async (label) => {
    if (label === "bulk-1") await release.promise;
  };
  const first = labelled("bulk-1", () => service.confirmAllPendingStudents(T));
  await until(() => log.includes("bulk-1:locked:s2"));
  const second = labelled("bulk-2", () => service.confirmAllPendingStudents(T));
  await until(() => log.includes("bulk-2:waits:s1"));
  hooks.afterLock = null;
  release.resolve();

  assert.deepEqual(await Promise.all([first, second]), [2, 0]);
  assert.equal(db.history.length, 2);
  assert.equal(new Set(db.history.map((h) => h.studentId)).size, 2);
});

test("bulk lock timeout: 409 STUDENT_DECISION_BUSY and nothing written (all or nothing)", async () => {
  student("s1");
  student("s2");
  locks.held.set("s2", "someone-else");
  locks.failWhenBlocked = true;
  await assert.rejects(service.confirmAllPendingStudents(T), appError(409, "STUDENT_DECISION_BUSY"));
  assert.equal(row("s1").confirmationStatus, "PENDING");
  assert.deepEqual(db.history, []);
  assert.deepEqual(recalculated, []);
});

// ---- Static guard: every decision write goes through these two functions -----------

test("only the decision functions change confirmationStatus / confirmedAt / confirmedById / approvedAt of existing students", () => {
  const fs = require("node:fs");
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  for (const dir of ["app", "services", "lib", "components", "scripts"]) {
    if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  }

  const serviceFile = path.join(root, "services", "student-service.ts");
  const serviceSource = fs.readFileSync(serviceFile, "utf8");
  const decisionsStart = serviceSource.indexOf("export async function decideStudentConfirmation");
  const decisionsEnd = serviceSource.indexOf("return approvedIds.length;");
  assert.ok(decisionsStart > 0 && decisionsEnd > decisionsStart);

  const offenders = [];
  let decisionWrites = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    // Student update / updateMany / upsert calls (creation is not a decision).
    if (!/\.student\.(update|upsert)/.test(source)) continue;
    for (const call of source.matchAll(/\.student\.(update|updateMany|upsert)\(\{[\s\S]*?\n\s*\}\)/g)) {
      if (!/\b(confirmationStatus|confirmedAt|confirmedById|approvedAt)\s*:/.test(call[0])) continue;
      if (file === serviceFile && call.index > decisionsStart && call.index < decisionsEnd) {
        decisionWrites += 1;
        continue;
      }
      offenders.push(`${path.relative(root, file)}: ${call[0].slice(0, 80).replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(offenders, []);
  assert.equal(decisionWrites, 4, "individual: status + approvedAt; bulk: status + approvedAt");
});

test("no code updates or deletes history rows (append-only; the database trigger refuses it too)", () => {
  const fs = require("node:fs");
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
        const source = fs.readFileSync(full, "utf8");
        if (/studentConfirmationHistory\.(update|updateMany|upsert|delete|deleteMany)\b/.test(source)) hits.push(full);
        if (/(UPDATE|DELETE FROM|TRUNCATE)\s+"StudentConfirmationHistory"/.test(source)) hits.push(full);
      }
    }
  };
  for (const dir of ["app", "services", "lib", "components", "scripts"]) {
    if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  }
  assert.deepEqual(hits, []);
});
