/*
 * Class-level automatic Free Cards, Stage 2 (backend): an enrolment with
 * ClassStudent.freeCardEligible gets an automatic Free Card on every NEW
 * current-month fee row, through every creation path, and nothing else
 * changes (real services and routes, in-memory database from
 * ./helpers/fake-db.cjs).
 *
 *   npm run test:fee-waiver
 *
 * Fixtures as in free-card.test.cjs: class "Maths", fee Rs. 2000, due week 4
 * (28 Dec), waiver launch month December 2026, rules 1 → 10%, 2 → 20%,
 * 3 → 40%, December COMPLETED lectures on the 5th, 12th and 19th, so a
 * student who joined on 20 Dec gets rule 3 (40% = Rs. 800) automatically.
 * "Now" is 21 Dec 2026 (Sri Lanka) unless a test says otherwise.
 *
 * Fee creation paths:
 *   A  ensureCurrentMonthFeeForClassStudent: assignment, public registration
 *      (tests/students/public-registration-fee.test.cjs) and the student
 *      payments page backfill (GET /api/student/payments)
 *   B  processCurrentMonthFees  (teacher fee sheet, current month)
 *   C  processPastMonthFees     (teacher fee sheet, past month)
 *   D  reprocessMonthlyFees     (teacher Reprocess)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { createFakeDb } = require("./helpers/fake-db.cjs");

const db = createFakeDb();

// Models the fee code does not model (enrolment history, views): empty,
// writes accepted and dropped.
const emptyDelegate = {
  count: async () => 0,
  findMany: async () => [],
  findFirst: async () => null,
  findUnique: async () => null,
  create: async (args) => args?.data ?? {},
};
// Interactive transactions opened through the client (connection usage).
const txCount = { value: 0 };
const client = new Proxy(db.client, {
  get(target, prop) {
    // Interactive transactions get this same client (with the empty models).
    if (prop === "$transaction") {
      return async (arg) => {
        txCount.value += 1;
        return typeof arg === "function" ? arg(client) : Promise.all(arg);
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

let sessionStudentId = "s1";
fake("lib/prisma.ts", { prisma: client });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => ({ role: "TEACHER", teacherId: "teacher-1" }),
  requireStudentSession: async () => ({ role: "STUDENT", studentId: sessionStudentId }),
  requireAppSession: async () => ({ role: "TEACHER", teacherId: "teacher-1" }),
  getOptionalSession: async () => null,
  requireAdminSession: async () => {
    throw new Error("not used");
  },
});

const feeService = require(path.join(root, "services", "class-student-fee-service.ts"));
const studentService = require(path.join(root, "services", "student-service.ts"));
const studentPaymentsRoute = require(path.join(root, "app", "api", "student", "payments", "route.ts"));

const digits = (wall) => new Date(`${wall}:00.000Z`);
const sl = (wall) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60 * 1000);
const at = (t, wall) => t.mock.timers.enable({ apis: ["Date"], now: sl(wall) });
const NOW = "2026-12-21T09:00";
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const T = "teacher-1";
const C = "class-1";
const C2 = "class-2";
const DEC_DUE = new Date(Date.UTC(2026, 11, 28, 23, 59, 59, 999));

function seed() {
  db.reset();
  txCount.value = 0;
  sessionStudentId = "s1";
  db.insert("FeeWaiverSettings", { id: "default", startYear: 2026, startMonth: 12 });
  db.insert("Class", { id: C, teacherId: T, status: 0, name: "Maths", monthlyFee: 2000, paymentDueWeek: 4, schedule: "TBD", teacher: { name: "Teacher One" } });
  db.insert("Class", { id: C2, teacherId: T, status: 0, name: "Physics", monthlyFee: 1500, paymentDueWeek: 4, schedule: "TBD", teacher: { name: "Teacher One" } });
  db.insert("ClassFeeWaiverRule", { id: "r1", classId: C, sequence: 1, type: "PERCENTAGE", value: 10 });
  db.insert("ClassFeeWaiverRule", { id: "r2", classId: C, sequence: 2, type: "PERCENTAGE", value: 20 });
  db.insert("ClassFeeWaiverRule", { id: "r3", classId: C, sequence: 3, type: "PERCENTAGE", value: 40 });
  for (const [id, wall] of [["L5", "2026-12-05T18:00"], ["L12", "2026-12-12T18:00"], ["L19", "2026-12-19T18:00"]]) {
    db.insert("Lecture", { id, classId: C, title: id, date: sl(wall), classStatus: "COMPLETED", status: 0 });
  }
}

function student(id) {
  return db.insert("Student", {
    id,
    name: `Student ${id}`,
    teacherId: T,
    status: 0,
    registrationNumber: id.toUpperCase(),
    registrationSource: "TEACHER",
    publicClassId: null,
    confirmationStatus: "APPROVED",
    confirmedAt: null,
    approvedAt: null,
  });
}

function enrol(id, studentId, over = {}) {
  return db.insert("ClassStudent", {
    id,
    classId: C,
    studentId,
    isActive: true,
    assignedAt: digits("2026-12-20T10:00"),
    removedAt: null,
    ...over,
  });
}

function fee(id, classStudentId, over = {}) {
  const amount = over.amount ?? 2000;
  return db.insert("ClassStudentFee", {
    id,
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

function pay(feeId, status, amount = 2000, studentId = "x") {
  return db.insert("ClassPayment", {
    classStudentFeeId: feeId,
    classId: C,
    studentId,
    amount,
    status,
    submittedAt: new Date(Date.UTC(2026, 11, 21)),
  });
}

const feeOf = (classStudentId, year = 2026, month = 12) =>
  db.tables.ClassStudentFee.find((r) => r.classStudentId === classStudentId && r.year === year && r.month === month);
const snapshot = (model) => JSON.parse(JSON.stringify(db.tables[model]));
const sheet = (year = 2026, month = 12) => feeService.getMonthlyFeeSheet({ teacherId: T, classId: C, year, month });
const reprocess = (year = 2026, month = 12) => feeService.reprocessMonthlyFees({ teacherId: T, classId: C, year, month });
const studentPaymentsPage = async (studentId) => {
  sessionStudentId = studentId;
  const res = await studentPaymentsRoute.GET(new Request("http://localhost/api/student/payments"));
  assert.equal(res.status, 200);
  return (await res.json()).data;
};

/** An automatic card exactly as a manual one: Rs. 0, issued now by the class teacher. */
function assertAutomaticCard(row) {
  assert.ok(row, "the fee row exists");
  assert.equal(row.freeCard, true);
  assert.equal(row.finalAmount, 0);
  assert.equal(row.freeCardIssuedByTeacherId, T, "issued by the class teacher");
  assert.equal(row.freeCardIssuedAt.getTime(), sl(NOW).getTime(), "issued at the creation instant");
}

function assertNormal(row, finalAmount) {
  assert.ok(row, "the fee row exists");
  assert.equal(row.freeCard, false);
  assert.equal(row.freeCardIssuedAt, null);
  assert.equal(row.freeCardIssuedByTeacherId, null);
  assert.equal(row.finalAmount, finalAmount);
}

// ---- Path A -----------------------------------------------------------------------

test("A: an eligible enrolment's new current-month row (student payments page backfill) gets an automatic card; the waiver stays underneath", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  enrol("e1", "s1", { freeCardEligible: true });

  const data = await studentPaymentsPage("s1");

  const row = feeOf("e1");
  assertAutomaticCard(row);
  // Every component is written exactly as for a normal row (test 12).
  assert.equal(row.amount, 2000);
  assert.equal(row.discount, 0);
  assert.equal(row.waiverAmount, 0);
  assert.equal(row.lateJoinDeduct, 800, "automatic joining waiver (rule 3, 40%) kept underneath");
  assert.equal(row.joinWaiverSequence, 3);
  assert.equal(row.joinWaiverRuleId, "r3");
  assert.equal(row.joinWaiverBaseAmount, 2000);
  assert.equal(row.dueDate.getTime(), DEC_DUE.getTime());
  assert.equal(row.status, 0);

  // Exactly a Free Card everywhere downstream.
  assert.deepEqual(data.paid.map((i) => i.feeId), [row.id]);
  assert.equal(data.paid[0].state, "FREE_CARD");
  assert.deepEqual(data.toPay, []);

  // Eligibility was read under the enrolment lock (own transaction for the plain client).
  assert.deepEqual(db.enrolmentLocks, [["e1"]]);

  // Revoking it restores the normal calculation from the components.
  await feeService.setFreeCards({ teacherId: T, classId: C, year: 2026, month: 12, feeIds: [row.id], action: "revoke" });
  assertNormal(feeOf("e1"), 1200);
});

test("A: a non-eligible enrolment's new row is exactly the existing normal row", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  enrol("e1", "s1");

  await studentPaymentsPage("s1");

  const row = feeOf("e1");
  assertNormal(row, 1200);
  assert.equal(row.lateJoinDeduct, 800);
  assert.equal(row.joinWaiverSequence, 3);
});

test("A: an existing row is never touched, even for an eligible enrolment (no row created, no card)", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  enrol("e1", "s1", { freeCardEligible: true });
  fee(uid(1), "e1");
  const before = snapshot("ClassStudentFee");

  await studentPaymentsPage("s1");
  await feeService.ensureCurrentMonthFeeForClassStudent(client, "e1");

  assert.deepEqual(snapshot("ClassStudentFee"), before);
});

test("A: assignment (and re-enrolment) creates the enrolment with freeCardEligible = false, never copied; its fee is normal", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  // The earlier enrolment of the same class, removed while eligible, with
  // its automatically carded fee.
  enrol("old", "s1", { isActive: false, freeCardEligible: true, assignedAt: digits("2026-12-02T10:00"), removedAt: digits("2026-12-15T10:00") });
  fee(uid(9), "old", { freeCard: true, finalAmount: 0, freeCardIssuedAt: sl("2026-12-02T10:00"), freeCardIssuedByTeacherId: T });
  const oldEnrolment = snapshot("ClassStudent")[0];
  const oldFee = snapshot("ClassStudentFee")[0];

  const record = await studentService.assignStudentToClass(T, C, "s1");

  const fresh = db.row("ClassStudent", record.id);
  assert.notEqual(record.id, "old", "a new enrolment row");
  assert.equal(fresh.freeCardEligible, false, "a new enrolment starts not eligible");
  // Normal, by the existing calculation (the joining waiver counts the
  // earlier enrolment of this month, so no deduction here).
  const newFee = feeOf(record.id);
  assertNormal(newFee, newFee.amount - newFee.lateJoinDeduct);
  assert.equal(newFee.finalAmount, 2000);
  assert.deepEqual(db.enrolmentLocks, [[record.id]], "the new enrolment was locked inside the assignment transaction");

  assert.deepEqual(JSON.parse(JSON.stringify(db.row("ClassStudent", "old"))), oldEnrolment, "the earlier enrolment is unchanged");
  assert.deepEqual(JSON.parse(JSON.stringify(db.row("ClassStudentFee", uid(9)))), oldFee, "its fee (and card) unchanged");
});

// ---- Path B -----------------------------------------------------------------------

test("B: the current-month sheet cards new rows of eligible enrolments only; existing rows are left as they are", async (t) => {
  seed();
  at(t, NOW);
  for (const id of ["s1", "s2", "s3", "s4", "s5"]) student(id);
  enrol("e1", "s1", { freeCardEligible: true });
  enrol("e2", "s2");
  enrol("e3", "s3", { freeCardEligible: true }); // existing unpaid row
  enrol("e4", "s4", { freeCardEligible: true }); // existing row with a pending slip
  enrol("e5", "s5", { freeCardEligible: true }); // existing partly paid row
  fee(uid(3), "e3", { lateJoinDeduct: 800, finalAmount: 1200, joinWaiverRuleId: "r3", joinWaiverSequence: 3, joinWaiverType: "PERCENTAGE", joinWaiverValue: 40, joinWaiverLecturesBefore: 3, joinWaiverEnrolledAt: digits("2026-12-20T10:00"), joinWaiverBaseAmount: 2000 });
  fee(uid(4), "e4");
  fee(uid(5), "e5");
  pay(uid(4), "PENDING");
  pay(uid(5), "CONFIRMED", 500);
  const paymentsBefore = snapshot("ClassPayment");

  const result = await sheet();

  assertAutomaticCard(feeOf("e1"));
  assert.equal(feeOf("e1").lateJoinDeduct, 800, "waiver underneath");
  assertNormal(feeOf("e2"), 1200);
  // Existing rows: never carded because of eligibility.
  assert.equal(db.row("ClassStudentFee", uid(3)).freeCard, false);
  assert.equal(db.row("ClassStudentFee", uid(4)).freeCard, false);
  assert.equal(db.row("ClassStudentFee", uid(5)).freeCard, false);
  assert.deepEqual(snapshot("ClassPayment"), paymentsBefore, "payments and slips untouched");
  // Only the missing enrolments were locked, in id order.
  assert.deepEqual(db.enrolmentLocks, [["e1", "e2"]]);

  const byFee = new Map(result.rows.map((r) => [r.feeId, r]));
  assert.equal(byFee.get(feeOf("e1").id).paymentStatus, "FREE_CARD");
  assert.equal(byFee.get(uid(4)).paymentStatus, "PENDING", "the slip is still waiting for review");
  assert.equal(byFee.get(uid(5)).paymentStatus, "PARTIAL");
});

test("B: an inactive eligible enrolment is not in the current sheet; a second load creates nothing", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  student("s2");
  enrol("e1", "s1", { freeCardEligible: true });
  enrol("e2", "s2", { freeCardEligible: true, isActive: false, removedAt: digits("2026-12-21T08:00") });

  await sheet();
  const after = snapshot("ClassStudentFee");
  await sheet();

  assertAutomaticCard(feeOf("e1"));
  assert.equal(feeOf("e2"), undefined, "the current-month pass only creates rows for active enrolments (unchanged)");
  assert.deepEqual(snapshot("ClassStudentFee"), after, "nothing re-created or changed on reload");
});

// ---- Path C -----------------------------------------------------------------------

test("C: a past-month backfill never gets an automatic card", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  student("s2");
  enrol("e1", "s1", { freeCardEligible: true, assignedAt: digits("2026-10-01T10:00") });
  enrol("e2", "s2", { freeCardEligible: true, assignedAt: digits("2026-10-01T10:00"), isActive: false, removedAt: digits("2026-12-01T10:00") });

  await sheet(2026, 11);

  assertNormal(feeOf("e1", 2026, 11), 2000);
  assertNormal(feeOf("e2", 2026, 11), 2000);
  assert.deepEqual(db.enrolmentLocks, [], "no eligibility read at all");
});

// ---- Path D -----------------------------------------------------------------------

test("D: Reprocess of the current month cards new rows of eligible ACTIVE enrolments only", async (t) => {
  seed();
  at(t, NOW);
  for (const id of ["s1", "s2", "s3"]) student(id);
  enrol("e1", "s1", { freeCardEligible: true });
  enrol("e2", "s2");
  // Removed this month while eligible: Reprocess still back-fills its row (as
  // before), but never with an automatic card.
  enrol("e3", "s3", { freeCardEligible: true, isActive: false, assignedAt: digits("2026-12-02T10:00"), removedAt: digits("2026-12-15T10:00") });

  await reprocess();

  assertAutomaticCard(feeOf("e1"));
  assert.equal(feeOf("e1").lateJoinDeduct, 800, "Reprocess waiver underneath");
  assertNormal(feeOf("e2"), 1200);
  assert.ok(feeOf("e3"), "the removed enrolment's row is still back-filled");
  assert.equal(feeOf("e3").freeCard, false, "inactive: no automatic card");
  assert.deepEqual(db.enrolmentLocks, [["e1", "e2", "e3"]]);
});

test("D: Reprocess of a past month never cards, and never cards existing rows", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  student("s2");
  enrol("e1", "s1", { freeCardEligible: true, assignedAt: digits("2026-10-01T10:00") });
  enrol("e2", "s2", { freeCardEligible: true });
  fee(uid(2), "e2");

  await reprocess(2026, 11);
  assertNormal(feeOf("e1", 2026, 11), 2000);
  assert.deepEqual(db.enrolmentLocks, []);

  await reprocess(2026, 12);
  assert.equal(db.row("ClassStudentFee", uid(2)).freeCard, false, "existing current-month row: recalculated as before, no card");
  assert.equal(db.row("ClassStudentFee", uid(2)).finalAmount, 1200);
});

test("D: a deleted student never gets an automatic card through current-month Reprocess (as paths A and B)", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  student("s2");
  student("s3");
  db.touch("Student", "s2", { status: 1 }); // deleted
  db.touch("Student", "s3", { status: 2 }); // deleted (other non-zero status)
  // All three keep an ACTIVE, eligible enrolment.
  enrol("e1", "s1", { freeCardEligible: true });
  enrol("e2", "s2", { freeCardEligible: true });
  enrol("e3", "s3", { freeCardEligible: true });

  await reprocess();

  assertAutomaticCard(feeOf("e1"));
  // Reprocess still back-fills their rows exactly as before (the existing
  // calculation: no joining waiver for a deleted student); only no card.
  for (const id of ["e2", "e3"]) {
    const row = feeOf(id);
    assertNormal(row, row.amount - row.discount - row.lateJoinDeduct - row.waiverAmount);
    assert.equal(row.amount, 2000);
  }
  assert.deepEqual(db.enrolmentLocks, [["e1", "e2", "e3"]], "all missing enrolments still locked in id order");
});

// ---- Payments, revocation ---------------------------------------------------------

test("existing payments and pending / clarification slips are untouched by every path", async (t) => {
  seed();
  at(t, NOW);
  for (const id of ["s1", "s2", "s3", "s4"]) student(id);
  enrol("e1", "s1", { freeCardEligible: true });
  enrol("e2", "s2", { freeCardEligible: true });
  enrol("e3", "s3", { freeCardEligible: true });
  enrol("e4", "s4", { freeCardEligible: true });
  fee(uid(1), "e1", { status: 1 });
  fee(uid(2), "e2");
  fee(uid(3), "e3");
  fee(uid(4), "e4");
  pay(uid(1), "CONFIRMED", 2000, "s1");
  pay(uid(2), "CONFIRMED", 700, "s2"); // partly paid
  pay(uid(3), "PENDING", 2000, "s3");
  pay(uid(4), "NEEDS_CLARIFICATION", 2000, "s4");
  const paymentsBefore = snapshot("ClassPayment");

  await sheet();
  await reprocess();
  for (const id of ["s1", "s2", "s3", "s4"]) await studentPaymentsPage(id);

  for (const n of [1, 2, 3, 4]) {
    assert.equal(db.row("ClassStudentFee", uid(n)).freeCard, false, `fee ${n}: no card`);
  }
  assert.equal(db.row("ClassStudentFee", uid(2)).finalAmount, 2000, "partly paid fee keeps its frozen amount");
  assert.deepEqual(snapshot("ClassPayment"), paymentsBefore, "no payment or slip changed");
  assert.equal(db.tables.ClassStudentFee.length, 4, "no extra row");
});

test("a manually revoked automatic card is never re-issued by sheet reload, Reprocess or the student payments page", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  enrol("e1", "s1", { freeCardEligible: true });

  await sheet();
  const feeId = feeOf("e1").id;
  assertAutomaticCard(feeOf("e1"));

  const revoked = await feeService.setFreeCards({ teacherId: T, classId: C, year: 2026, month: 12, feeIds: [feeId], action: "revoke" });
  assert.deepEqual(revoked.processed.map((p) => p.feeId), [feeId]);
  assertNormal(feeOf("e1"), 1200);

  await sheet();
  await reprocess();
  await studentPaymentsPage("s1");

  assertNormal(db.row("ClassStudentFee", feeId), 1200);
  assert.equal(db.tables.ClassStudentFee.length, 1);
});

test("eligibility is per enrolment: eligible in Maths, normal in Physics", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  enrol("e1", "s1", { freeCardEligible: true });
  enrol("e2", "s1", { classId: C2 });

  await studentPaymentsPage("s1");

  assertAutomaticCard(feeOf("e1"));
  assertNormal(feeOf("e2"), 1500);
});

// ---- Concurrency: eligibility read under the enrolment lock ------------------------

test("concurrency: an eligibility change committed while the creator waited for the lock is the one used", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  student("s2");
  enrol("e1", "s1"); // made eligible while B waits
  enrol("e2", "s2", { freeCardEligible: true }); // made not eligible while B waits

  db.hooks.onEnrolmentLock = (ids, api) => {
    db.hooks.onEnrolmentLock = null;
    assert.deepEqual(ids, ["e1", "e2"]);
    api.touch("ClassStudent", "e1", { freeCardEligible: true });
    api.touch("ClassStudent", "e2", { freeCardEligible: false });
  };
  await sheet();

  assertAutomaticCard(feeOf("e1"));
  assertNormal(feeOf("e2"), 1200);
});

test("concurrency: path A reads eligibility after its lock as well", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  enrol("e1", "s1");
  db.hooks.onEnrolmentLock = (ids, api) => {
    db.hooks.onEnrolmentLock = null;
    api.touch("ClassStudent", "e1", { freeCardEligible: true });
  };

  await studentPaymentsPage("s1");

  assertAutomaticCard(feeOf("e1"));
});

// ---- Optional current-month application (reuses setFreeCards) ----------------------

test("issueFreeCardsForEligibleEnrolments: existing current-month rows of eligible active enrolments, through setFreeCards and its skip rules", async (t) => {
  seed();
  at(t, NOW);
  for (const id of ["s1", "s2", "s3", "s4", "s5", "s6", "s7"]) student(id);
  enrol("e1", "s1", { freeCardEligible: true }); // unpaid → issued
  enrol("e2", "s2", { freeCardEligible: true }); // pending slip → skipped
  enrol("e3", "s3", { freeCardEligible: true }); // confirmed → skipped
  enrol("e4", "s4", { freeCardEligible: true }); // already carded → skipped
  enrol("e5", "s5"); // not eligible → ignored
  enrol("e6", "s6", { freeCardEligible: true, isActive: false, removedAt: digits("2026-12-21T08:00") }); // inactive → ignored
  enrol("e7", "s7", { freeCardEligible: true, classId: C2 }); // another class → ignored
  fee(uid(1), "e1", { discount: 100, finalAmount: 1900 });
  fee(uid(2), "e2");
  fee(uid(3), "e3", { status: 1 });
  fee(uid(4), "e4", { freeCard: true, finalAmount: 0, freeCardIssuedAt: sl("2026-12-10T10:00"), freeCardIssuedByTeacherId: T });
  fee(uid(5), "e5");
  fee(uid(6), "e6");
  fee(uid(7), "e7", { amount: 1500, finalAmount: 1500 });
  pay(uid(2), "PENDING", 2000, "s2");
  pay(uid(3), "CONFIRMED", 2000, "s3");
  const card4 = JSON.parse(JSON.stringify(db.row("ClassStudentFee", uid(4))));

  const result = await feeService.issueFreeCardsForEligibleEnrolments({
    teacherId: T,
    classId: C,
    classStudentIds: ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e1"],
  });

  assert.equal(result.action, "issue");
  assert.deepEqual(result.processed.map((p) => p.feeId), [uid(1)]);
  assert.deepEqual(
    result.skipped.map((s) => [s.feeId, s.reason]).sort(),
    [[uid(2), "PENDING_PAYMENT"], [uid(3), "CONFIRMED_PAYMENT"], [uid(4), "ALREADY_FREE_CARD"]].sort()
  );
  const issued = db.row("ClassStudentFee", uid(1));
  assert.equal(issued.freeCard, true);
  assert.equal(issued.finalAmount, 0);
  assert.equal(issued.discount, 100, "adjustment kept underneath");
  assert.equal(issued.freeCardIssuedByTeacherId, T);
  assert.deepEqual(JSON.parse(JSON.stringify(db.row("ClassStudentFee", uid(4)))), card4, "existing card's issue details unchanged");
  for (const n of [2, 3, 5, 6, 7]) assert.equal(db.row("ClassStudentFee", uid(n)).freeCard, false, `fee ${n}`);
});

test("issueFreeCardsForEligibleEnrolments: nothing to issue, validation and ownership", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  enrol("e1", "s1", { freeCardEligible: true }); // no current-month row yet

  const none = await feeService.issueFreeCardsForEligibleEnrolments({ teacherId: T, classId: C, classStudentIds: ["e1"] });
  assert.deepEqual([none.processed, none.skipped], [[], []]);
  assert.equal(db.tables.ClassStudentFee.length, 0, "creates no row (the row gets its card when created)");

  await assert.rejects(
    feeService.issueFreeCardsForEligibleEnrolments({ teacherId: T, classId: C, classStudentIds: [] }),
    (error) => error.statusCode === 400 && error.code === "VALIDATION_ERROR"
  );
  await assert.rejects(
    feeService.issueFreeCardsForEligibleEnrolments({ teacherId: "teacher-2", classId: C, classStudentIds: ["e1"] }),
    (error) => error.statusCode === 404 && error.code === "CLASS_NOT_FOUND"
  );
});

test("issueFreeCardsForEligibleEnrolments: eligibility removed (or the student removed) before the enrolment lock is obtained → no card", async (t) => {
  seed();
  at(t, NOW);
  for (const id of ["s1", "s2", "s3"]) student(id);
  enrol("e1", "s1", { freeCardEligible: true }); // eligibility removed meanwhile
  enrol("e2", "s2", { freeCardEligible: true }); // removed from the class meanwhile
  enrol("e3", "s3", { freeCardEligible: true }); // unchanged → issued
  fee(uid(1), "e1");
  fee(uid(2), "e2");
  fee(uid(3), "e3");

  // The pre-filter saw all three eligible; the changes commit before the
  // apply transaction obtains the enrolment locks.
  db.hooks.onEnrolmentLock = (ids, api) => {
    db.hooks.onEnrolmentLock = null;
    api.touch("ClassStudent", "e1", { freeCardEligible: false });
    api.touch("ClassStudent", "e2", { isActive: false, removedAt: digits("2026-12-21T08:59") });
  };

  const result = await feeService.issueFreeCardsForEligibleEnrolments({ teacherId: T, classId: C, classStudentIds: ["e3", "e2", "e1"] });

  assert.deepEqual(db.enrolmentLocks, [["e1", "e2", "e3"]], "the fees' enrolments, locked in id order");
  assert.deepEqual(result.processed.map((p) => p.feeId), [uid(3)]);
  assert.deepEqual(
    result.skipped.map((s) => [s.feeId, s.reason, s.message]).sort(),
    [
      [uid(1), "NOT_ELIGIBLE", "No longer a Free Card student of this class."],
      [uid(2), "NOT_ELIGIBLE", "No longer a Free Card student of this class."],
    ]
  );
  assertNormal(db.row("ClassStudentFee", uid(1)), 2000);
  assertNormal(db.row("ClassStudentFee", uid(2)), 2000);
  assert.equal(db.row("ClassStudentFee", uid(3)).freeCard, true);
  assert.equal(db.row("ClassStudentFee", uid(3)).freeCardIssuedByTeacherId, T);
});

test("manual Free Cards (setFreeCards as the route calls it) are unchanged: no enrolment lock, no eligibility needed", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  enrol("e1", "s1"); // not eligible
  fee(uid(1), "e1");

  const result = await feeService.setFreeCards({ teacherId: T, classId: C, year: 2026, month: 12, feeIds: [uid(1)], action: "issue" });

  assert.deepEqual(result.processed.map((p) => p.feeId), [uid(1)]);
  assert.equal(db.row("ClassStudentFee", uid(1)).freeCard, true);
  assert.deepEqual(db.enrolmentLocks, [], "the manual path never locks enrolments");

  // The internal flag never affects a revoke.
  const revoked = await feeService.setFreeCards({ teacherId: T, classId: C, year: 2026, month: 12, feeIds: [uid(1)], action: "revoke", eligibleEnrolmentsOnly: true });
  assert.deepEqual(revoked.processed.map((p) => p.feeId), [uid(1)]);
  assert.deepEqual(db.enrolmentLocks, []);
});

test("connection usage: the student payments page opens no transaction when this month's rows exist; one per missing row", async (t) => {
  seed();
  at(t, NOW);
  student("s1");
  enrol("e1", "s1", { freeCardEligible: true });
  enrol("e2", "s1", { classId: C2 });
  fee(uid(1), "e1");

  await studentPaymentsPage("s1");
  assert.equal(txCount.value, 1, "only the missing Physics row opened a transaction");
  assert.deepEqual(db.enrolmentLocks, [["e2"]]);
  assert.equal(db.row("ClassStudentFee", uid(1)).freeCard, false, "the existing row is untouched");

  txCount.value = 0;
  await studentPaymentsPage("s1");
  await studentPaymentsPage("s1");
  assert.equal(txCount.value, 0, "every row exists: no transaction, no connection held");
  assert.deepEqual(db.enrolmentLocks, [["e2"]], "no further lock");
});
