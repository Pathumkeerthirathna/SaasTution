/*
 * Class-level Free Card eligibility, Stage 3A: the teacher API
 * POST /api/classes/[id]/free-card-eligibility (real route and services,
 * in-memory database from ./helpers/fake-db.cjs), plus the sequential student
 * payments page backfill.
 *
 *   npm run test:fee-waiver
 *
 * The fake client below records every interactive transaction (begin, commit,
 * rollback; a rolled-back transaction's writes are undone, as in PostgreSQL)
 * and every enrolment lock in one ordered event log.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "free-card-eligibility-api-"));
process.env.ERROR_LOG_DIR = path.join(sandbox, "logs");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { createFakeDb } = require("./helpers/fake-db.cjs");

const db = createFakeDb();

const emptyDelegate = {
  count: async () => 0,
  findMany: async () => [],
  findFirst: async () => null,
  findUnique: async () => null,
  create: async (args) => args?.data ?? {},
};

// ---- Transaction + lock event log ----------------------------------------------------
const events = [];
const txState = { open: 0, maxOpen: 0, next: 0 };

const client = new Proxy(db.client, {
  get(target, prop) {
    if (prop === "$transaction") {
      return async (arg) => {
        if (typeof arg !== "function") return Promise.all(arg);
        const id = ++txState.next;
        const saved = structuredClone(db.tables);
        txState.open += 1;
        txState.maxOpen = Math.max(txState.maxOpen, txState.open);
        events.push({ type: "begin", tx: id });
        try {
          const result = await arg(client);
          events.push({ type: "commit", tx: id });
          return result;
        } catch (error) {
          for (const [model, rows] of Object.entries(saved)) {
            db.tables[model].length = 0;
            db.tables[model].push(...rows);
          }
          events.push({ type: "rollback", tx: id });
          throw error;
        } finally {
          txState.open -= 1;
        }
      };
    }
    if (prop === "$queryRaw") {
      return async (strings, ...values) => {
        const before = db.lockLog.length;
        const rows = await target.$queryRaw(strings, ...values);
        for (const lock of db.lockLog.slice(before)) events.push({ type: "lock", ...lock, open: txState.open });
        return rows;
      };
    }
    if (prop in target) return target[prop];
    return emptyDelegate;
  },
});

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

let sessionTeacherId = "teacher-1";
let sessionStudentId = "s1";
fake("lib/prisma.ts", { prisma: client });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => ({ role: "TEACHER", teacherId: sessionTeacherId }),
  requireStudentSession: async () => ({ role: "STUDENT", studentId: sessionStudentId }),
  requireAppSession: async () => ({ role: "TEACHER", teacherId: sessionTeacherId }),
  getOptionalSession: async () => null,
  requireAdminSession: async () => {
    throw new Error("not used");
  },
});

const feeService = require(path.join(root, "services", "class-student-fee-service.ts"));
const eligibilityRoute = require(path.join(root, "app", "api", "classes", "[id]", "free-card-eligibility", "route.ts"));
const freeCardsRoute = require(path.join(root, "app", "api", "payments", "fees", "free-cards", "route.ts"));
const studentPaymentsRoute = require(path.join(root, "app", "api", "student", "payments", "route.ts"));

const digits = (wall) => new Date(`${wall}:00.000Z`);
const sl = (wall) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60 * 1000);
const at = (t, wall) => t.mock.timers.enable({ apis: ["Date"], now: sl(wall) });
const NOW = "2026-12-21T09:00";
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const E = (n) => uid(100 + n); // enrolment ids
const F = (n) => uid(200 + n); // fee ids

const T = "teacher-1";
const T2 = "teacher-2";
const C = "class-1";
const C2 = "class-2";
const C3 = "class-3"; // teacher-2's class
const DEC_DUE = new Date(Date.UTC(2026, 11, 28, 23, 59, 59, 999));

function seed() {
  db.reset();
  events.length = 0;
  txState.open = 0;
  txState.maxOpen = 0;
  txState.next = 0;
  sessionTeacherId = T;
  sessionStudentId = "s1";
  db.insert("FeeWaiverSettings", { id: "default", startYear: 2026, startMonth: 12 });
  db.insert("Class", { id: C, teacherId: T, status: 0, name: "Maths", monthlyFee: 2000, paymentDueWeek: 4, schedule: "TBD", teacher: { name: "Teacher One" } });
  db.insert("Class", { id: C2, teacherId: T, status: 0, name: "Physics", monthlyFee: 1500, paymentDueWeek: 4, schedule: "TBD", teacher: { name: "Teacher One" } });
  db.insert("Class", { id: C3, teacherId: T2, status: 0, name: "Chemistry", monthlyFee: 1800, paymentDueWeek: 4, schedule: "TBD", teacher: { name: "Teacher Two" } });
}

function student(id, teacherId = T) {
  return db.insert("Student", {
    id,
    name: `Student ${id}`,
    teacherId,
    status: 0,
    registrationNumber: id.toUpperCase(),
    registrationSource: "TEACHER",
    publicClassId: null,
    confirmationStatus: "APPROVED",
    confirmedAt: null,
    approvedAt: null,
  });
}

function enrol(n, studentId, over = {}) {
  return db.insert("ClassStudent", {
    id: E(n),
    classId: C,
    studentId,
    isActive: true,
    assignedAt: digits("2026-12-01T10:00"),
    removedAt: null,
    ...over,
  });
}

function fee(n, classStudentId, over = {}) {
  const amount = over.amount ?? 2000;
  return db.insert("ClassStudentFee", {
    id: F(n),
    classStudentId,
    year: 2026,
    month: 12,
    amount,
    discount: 0,
    lateJoinDeduct: 0,
    waiverAmount: 0,
    finalAmount: amount,
    dueDate: DEC_DUE,
    status: 0,
    ...over,
  });
}

function pay(feeId, status, amount = 2000) {
  return db.insert("ClassPayment", {
    classStudentFeeId: feeId,
    classId: C,
    studentId: "x",
    amount,
    status,
    submittedAt: new Date(Date.UTC(2026, 11, 21)),
  });
}

const eligibleOf = (n) => db.row("ClassStudent", E(n)).freeCardEligible;
const snapshot = (model) => JSON.parse(JSON.stringify(db.tables[model]));

async function post(body, classId = C) {
  const res = await eligibilityRoute.POST(
    new Request(`http://localhost/api/classes/${classId}/free-card-eligibility`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: { id: classId } }
  );
  return { status: res.status, body: await res.json() };
}

function assertRejected(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  assert.equal(res.body.error?.code ?? res.body.code, code, JSON.stringify(res.body));
}

/** Three of teacher-1's students, actively enrolled in Maths, not eligible. */
function threeStudents() {
  for (const id of ["s1", "s2", "s3"]) student(id);
  enrol(1, "s1");
  enrol(2, "s2");
  enrol(3, "s3");
}

// ---- 1, 2: enable / disable ---------------------------------------------------------

test("enable: several active enrolments become eligible in one request (200, all or nothing)", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();
  db.touch("ClassStudent", E(2), { freeCardEligible: true }); // already eligible: counted, not changed

  const res = await post({ classStudentIds: [E(3), E(1), E(2)], eligible: true });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.data, {
    classId: C,
    eligible: true,
    enrolments: [
      { classStudentId: E(3), studentId: "s3", freeCardEligible: true },
      { classStudentId: E(1), studentId: "s1", freeCardEligible: true },
      { classStudentId: E(2), studentId: "s2", freeCardEligible: true },
    ],
    changedCount: 2,
    apply: null,
  });
  assert.equal(res.body.message, "Free Card eligibility enabled for 3 students.");
  assert.deepEqual([eligibleOf(1), eligibleOf(2), eligibleOf(3)], [true, true, true]);
});

test("disable: several active enrolments stop being eligible; nothing else changes", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();
  for (const n of [1, 2, 3]) db.touch("ClassStudent", E(n), { freeCardEligible: true });

  const res = await post({ classStudentIds: [E(1), E(2)], eligible: false });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.changedCount, 2);
  assert.equal(res.body.data.apply, null);
  assert.equal(res.body.message, "Free Card eligibility disabled for 2 students. Existing Free Cards were not changed.");
  assert.deepEqual([eligibleOf(1), eligibleOf(2), eligibleOf(3)], [false, false, true]);
});

// ---- 3-8: ownership, validation, atomicity ------------------------------------------

test("class ownership: another teacher's class, or an unknown class, is 404 CLASS_NOT_FOUND and changes nothing", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();
  const before = snapshot("ClassStudent");

  sessionTeacherId = T2;
  assertRejected(await post({ classStudentIds: [E(1)], eligible: true }, C), 404, "CLASS_NOT_FOUND");
  sessionTeacherId = T;
  assertRejected(await post({ classStudentIds: [E(1)], eligible: true }, "class-unknown"), 404, "CLASS_NOT_FOUND");

  assert.deepEqual(snapshot("ClassStudent"), before);
  assert.deepEqual(db.lockLog, [], "rejected before any lock");
});

test("a teacher id in the body is ignored: the session's teacher is the only authority", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();

  sessionTeacherId = T2;
  const res = await post({ classStudentIds: [E(1)], eligible: true, teacherId: T });

  assertRejected(res, 404, "CLASS_NOT_FOUND");
  assert.equal(eligibleOf(1), false);
});

test("an enrolment of another class of the same teacher is rejected (404 ENROLMENT_NOT_FOUND); nothing changes", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();
  enrol(4, "s1", { classId: C2 });
  const before = snapshot("ClassStudent");

  const res = await post({ classStudentIds: [E(1), E(4)], eligible: true });

  assertRejected(res, 404, "ENROLMENT_NOT_FOUND");
  assert.deepEqual(res.body.error?.details ?? res.body.details, { classStudentIds: [E(4)] });
  assert.deepEqual(snapshot("ClassStudent"), before);
});

test("an enrolment of another teacher (its class, or its student in this class) is rejected; nothing changes", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();
  student("t2s", T2);
  enrol(5, "t2s", { classId: C3 }); // teacher-2's class
  enrol(6, "t2s"); // teacher-2's student inside teacher-1's class (inconsistent data)
  const before = snapshot("ClassStudent");

  const res = await post({ classStudentIds: [E(1), E(5), E(6)], eligible: true });

  assertRejected(res, 404, "ENROLMENT_NOT_FOUND");
  assert.deepEqual(res.body.error?.details ?? res.body.details, { classStudentIds: [E(5), E(6)] });
  assert.deepEqual(snapshot("ClassStudent"), before);
});

test("an inactive (removed) enrolment is rejected (409 ENROLMENT_NOT_ACTIVE); nothing changes", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();
  db.touch("ClassStudent", E(3), { isActive: false, removedAt: digits("2026-12-10T10:00") });
  const before = snapshot("ClassStudent");

  const res = await post({ classStudentIds: [E(1), E(3)], eligible: true });

  assertRejected(res, 409, "ENROLMENT_NOT_ACTIVE");
  assert.deepEqual(res.body.error?.details ?? res.body.details, { classStudentIds: [E(3)] });
  assert.deepEqual(snapshot("ClassStudent"), before);

  // Also when disabling.
  db.touch("ClassStudent", E(3), { freeCardEligible: true });
  assertRejected(await post({ classStudentIds: [E(3)], eligible: false }), 409, "ENROLMENT_NOT_ACTIVE");
  assert.equal(eligibleOf(3), true);
});

test("validation: empty, duplicate, malformed and oversized selections, bad flags and bodies are 400 and change nothing", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();
  const before = snapshot("ClassStudent");

  const cases = [
    { classStudentIds: [], eligible: true },
    { eligible: true },
    { classStudentIds: [E(1), E(1)], eligible: true },
    { classStudentIds: ["not-a-uuid"], eligible: true },
    { classStudentIds: [42], eligible: true },
    { classStudentIds: Array.from({ length: 501 }, (_, i) => uid(1000 + i)), eligible: true },
    { classStudentIds: [E(1)] },
    { classStudentIds: [E(1)], eligible: "true" },
    { classStudentIds: [E(1)], eligible: true, applyToCurrentMonth: "yes" },
    { classStudentIds: [E(1)], eligible: false, applyToCurrentMonth: true },
    [E(1)],
  ];
  for (const body of cases) {
    assertRejected(await post(body), 400, "VALIDATION_ERROR");
  }
  assertRejected(await post("{not json"), 400, "VALIDATION_ERROR");

  assert.deepEqual(snapshot("ClassStudent"), before);
  assert.deepEqual(db.lockLog, []);
});

test("atomic: one invalid enrolment among valid ones → the transaction rolls back, no enrolment updated", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();
  const before = snapshot("ClassStudent");

  const res = await post({ classStudentIds: [E(1), E(2), uid(999)], eligible: true });

  assertRejected(res, 404, "ENROLMENT_NOT_FOUND");
  assert.deepEqual(snapshot("ClassStudent"), before);
  assert.deepEqual(events.map((e) => e.type), ["begin", "lock", "rollback"]);
});

// ---- 9-12: locking, commit before apply ---------------------------------------------

test("locks: every selected enrolment, in ascending id order, FOR NO KEY UPDATE, inside the transaction, before the update", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();

  db.hooks.beforeUpdateMany = (model) => {
    assert.equal(model, "ClassStudent");
    assert.deepEqual(events.at(-1), { type: "lock", mode: "NO KEY UPDATE", ids: [E(1), E(2), E(3)], open: 1 });
  };
  const res = await post({ classStudentIds: [E(3), E(1), E(2)], eligible: true });

  assert.equal(res.status, 200);
  assert.deepEqual(events, [
    { type: "begin", tx: 1 },
    { type: "lock", mode: "NO KEY UPDATE", ids: [E(1), E(2), E(3)], open: 1 },
    { type: "commit", tx: 1 },
  ]);
});

test("apply: runs only after the eligibility transaction committed, in its own transaction (never nested)", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();
  fee(1, E(1));
  fee(2, E(2));
  pay(F(2), "PENDING");

  const res = await post({ classStudentIds: [E(1), E(2), E(3)], eligible: true, applyToCurrentMonth: true });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(events, [
    { type: "begin", tx: 1 },
    { type: "lock", mode: "NO KEY UPDATE", ids: [E(1), E(2), E(3)], open: 1 },
    { type: "commit", tx: 1 },
    { type: "begin", tx: 2 }, // setFreeCards
    { type: "lock", mode: "SHARE", ids: [E(1), E(2)], open: 1 },
    { type: "commit", tx: 2 },
  ]);
  assert.equal(txState.maxOpen, 1, "never two transactions open at once");

  assert.equal(res.body.data.apply.status, "APPLIED");
  assert.deepEqual(res.body.data.apply.processed.map((p) => p.feeId), [F(1)]);
  assert.deepEqual(res.body.data.apply.skipped.map((s) => [s.feeId, s.reason]), [[F(2), "PENDING_PAYMENT"]]);
  assert.equal(res.body.message, "Free Card eligibility enabled for 3 students. 1 Free Card issued for this month, 1 skipped.");
  assert.equal(db.row("ClassStudentFee", F(1)).freeCard, true);
  assert.equal(db.row("ClassStudentFee", F(1)).freeCardIssuedByTeacherId, T);
  assert.equal(db.row("ClassStudentFee", F(2)).freeCard, false, "the pending slip is never covered");
  assert.equal(db.tables.ClassStudentFee.length, 2, "no row created for the enrolment without one");
});

test("apply is never called unless explicitly requested (enable without it: no fee lock, no fee change)", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();
  fee(1, E(1));
  fee(2, E(2), { discount: 300, finalAmount: 1700 });
  const fees = snapshot("ClassStudentFee");

  for (const body of [
    { classStudentIds: [E(1), E(2)], eligible: true },
    { classStudentIds: [E(1), E(2)], eligible: true, applyToCurrentMonth: false },
  ]) {
    events.length = 0;
    const res = await post(body);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.apply, null);
    assert.deepEqual(events.map((e) => e.type), ["begin", "lock", "commit"], "only the eligibility transaction");
    assert.ok(!events.some((e) => e.mode === "SHARE"), "no apply step");
  }
  assert.deepEqual(snapshot("ClassStudentFee"), fees, "existing fee rows untouched");
});

test("apply failure: eligibility stays saved and the response says so (never a false rollback)", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();
  fee(1, E(1));

  // An unexpected database failure in the apply step (after the commit).
  db.hooks.failOn = (model, method) => model === "ClassStudentFee" && method === "findMany";
  const res = await post({ classStudentIds: [E(1), E(2)], eligible: true, applyToCurrentMonth: true });
  db.hooks.failOn = null;

  assert.equal(res.status, 200, "the eligibility change itself succeeded");
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.data.apply, {
    status: "FAILED",
    code: "FREE_CARD_APPLY_FAILED",
    message: "Free Cards could not be applied to this month's fees. Please try again.",
  });
  assert.match(res.body.message, /saved and has not been reverted/);
  assert.doesNotMatch(res.body.message, /simulated failure/, "no raw error text in the response");
  assert.deepEqual([eligibleOf(1), eligibleOf(2)], [true, true], "committed eligibility kept");
  assert.equal(db.row("ClassStudentFee", F(1)).freeCard, false);
  assert.ok(events.some((e) => e.type === "commit" && e.tx === 1));
});

test("apply failure with a known error (lock contention → FREE_CARD_BUSY) is reported with its message", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();
  fee(1, E(1));

  db.hooks.onEnrolmentLock = () => {
    db.hooks.onEnrolmentLock = null;
    const error = new Error("lock timeout");
    error.code = "P2010";
    throw error;
  };
  const res = await post({ classStudentIds: [E(1)], eligible: true, applyToCurrentMonth: true });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.apply.status, "FAILED");
  assert.equal(res.body.data.apply.code, "FREE_CARD_BUSY");
  assert.match(res.body.message, /being changed by another request/);
  assert.equal(eligibleOf(1), true);
  assert.deepEqual(events.map((e) => e.type), ["begin", "lock", "commit", "begin", "rollback"]);
});

test("eligibility lock contention is 409 FREE_CARD_ELIGIBILITY_BUSY and changes nothing", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();
  const before = snapshot("ClassStudent");

  db.hooks.failOn = (model, method) => {
    if (model === "ClassStudent" && method === "findMany") {
      db.hooks.failOn = null;
      const error = new Error("canceling statement due to lock timeout");
      error.code = "P2010";
      throw error;
    }
    return false;
  };
  assertRejected(await post({ classStudentIds: [E(1)], eligible: true }), 409, "FREE_CARD_ELIGIBILITY_BUSY");
  assert.deepEqual(snapshot("ClassStudent"), before);
});

// ---- 13-15: fees and the manual Free Card API untouched -----------------------------

test("disable never revokes: existing Free Cards (automatic or manual) stay exactly as they are", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();
  for (const n of [1, 2]) db.touch("ClassStudent", E(n), { freeCardEligible: true });
  fee(1, E(1), { freeCard: true, finalAmount: 0, freeCardIssuedAt: sl("2026-12-01T10:00"), freeCardIssuedByTeacherId: T });
  fee(2, E(2), { freeCard: true, finalAmount: 0, freeCardIssuedAt: sl("2026-12-05T10:00"), freeCardIssuedByTeacherId: T, discount: 200 });
  const fees = snapshot("ClassStudentFee");

  const res = await post({ classStudentIds: [E(1), E(2)], eligible: false });

  assert.equal(res.status, 200);
  assert.deepEqual(snapshot("ClassStudentFee"), fees);
  assert.ok(!events.some((e) => e.mode === "SHARE"), "no Free Card operation at all");
});

test("enable without apply never modifies existing fee rows (unpaid, paid, pending)", async (t) => {
  seed();
  at(t, NOW);
  threeStudents();
  fee(1, E(1));
  fee(2, E(2), { status: 1 });
  fee(3, E(3));
  pay(F(2), "CONFIRMED");
  pay(F(3), "PENDING");
  const fees = snapshot("ClassStudentFee");
  const payments = snapshot("ClassPayment");

  const res = await post({ classStudentIds: [E(1), E(2), E(3)], eligible: true });

  assert.equal(res.status, 200);
  assert.deepEqual(snapshot("ClassStudentFee"), fees);
  assert.deepEqual(snapshot("ClassPayment"), payments);
});

test("the manual Free Card API is unchanged: issues for a non-eligible student, no enrolment lock", async (t) => {
  seed();
  at(t, NOW);
  threeStudents(); // none eligible
  fee(1, E(1));
  fee(2, E(2));
  pay(F(2), "PENDING");

  const res = await freeCardsRoute.POST(
    new Request("http://localhost/api/payments/fees/free-cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ classId: C, year: 2026, month: 12, feeIds: [F(1), F(2)], action: "issue" }),
    })
  );
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.message, "1 Free Card issued.");
  assert.deepEqual(body.data.processed.map((p) => p.feeId), [F(1)]);
  assert.deepEqual(body.data.skipped.map((s) => [s.feeId, s.reason]), [[F(2), "PENDING_PAYMENT"]]);
  assert.deepEqual(db.lockLog, [], "the manual path never locks enrolments");
  assert.equal(db.row("ClassStudentFee", F(1)).freeCard, true);
});

// ---- 16: sequential student payments page backfill -----------------------------------

async function studentPayments(studentId) {
  sessionStudentId = studentId;
  const res = await studentPaymentsRoute.GET(new Request("http://localhost/api/student/payments"));
  return { status: res.status, body: await res.json() };
}

test("payments page backfill: one enrolment at a time, every missing row created, same response shape", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  enrol(1, "s1", { freeCardEligible: true });
  enrol(2, "s1", { classId: C2 });
  db.insert("ClassStudent", { id: E(3), classId: C, studentId: "s1", isActive: false, assignedAt: digits("2026-11-01T10:00"), removedAt: digits("2026-11-20T10:00") });

  const res = await studentPayments("s1");

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  // The route's existing response shape.
  assert.deepEqual(Object.keys(res.body.data), ["toPay", "inReview", "paid", "classes"]);
  assert.deepEqual(res.body.data.classes.map((c) => c.id).sort(), [C, C2]);
  assert.equal(txState.maxOpen, 1, "never two backfill transactions at once (sequential)");
  assert.deepEqual(
    events.filter((e) => e.type !== "lock").map((e) => e.type),
    ["begin", "commit", "begin", "commit"],
    "one short transaction per missing row, one after the other"
  );
  const created = db.tables.ClassStudentFee.map((r) => r.classStudentId).sort();
  assert.deepEqual(created, [E(1), E(2)], "both active enrolments, not the removed one");
  assert.equal(db.tables.ClassStudentFee.find((r) => r.classStudentId === E(1)).freeCard, true);
  assert.deepEqual(res.body.data.paid.map((i) => i.feeId), [db.tables.ClassStudentFee.find((r) => r.classStudentId === E(1)).id]);
  assert.deepEqual(res.body.data.toPay.map((i) => i.finalAmount), [1500]);
});

test("payments page backfill: a failure is still the route's existing 500 response, and later enrolments are not attempted", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  enrol(1, "s1");
  enrol(2, "s1", { classId: C2 });

  db.hooks.failOn = (model, method) => model === "ClassStudentFee" && method === "create";
  const res = await studentPayments("s1");
  db.hooks.failOn = null;

  assert.equal(res.status, 500);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error?.code ?? res.body.code, "INTERNAL_SERVER_ERROR");
  assert.equal(db.tables.ClassStudentFee.length, 0, "the failed row rolled back; nothing half-written");
  assert.equal(events.filter((e) => e.type === "begin").length, 1, "stopped at the first failure");
});
