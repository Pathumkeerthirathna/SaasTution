/*
 * Automatic joining fee waiver — integration with the fee sheet, approvals,
 * lecture events, rules API and reset (real services, in-memory database).
 *
 *   npm run test:fee-waiver
 *
 * Fixtures (class "Maths", fee Rs. 2000, launch month December 2026):
 *   rules: 1 → 10%, 2 → 20%, 3 → 40%
 *   December COMPLETED lectures at 18:00 Sri Lanka on the 5th, 12th, 19th
 *   (plus a LIVE 8th, a CANCELLED 10th, a deleted COMPLETED 15th, and another
 *   class's COMPLETED 6th — none of which may count).
 * digits() = ClassStudent.assignedAt convention; sl() = real instant.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { createFakeDb } = require("./helpers/fake-db.cjs");

const db = createFakeDb();

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

let sessionTeacherId = "teacher-1";
fake("lib/prisma.ts", { prisma: db.client });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => ({ role: "TEACHER", teacherId: sessionTeacherId }),
  requireStudentSession: async () => ({ role: "STUDENT", studentId: "none" }),
  requireAppSession: async () => ({ role: "TEACHER", teacherId: sessionTeacherId }),
  getOptionalSession: async () => null,
  requireAdminSession: async () => {
    throw new Error("not used");
  },
});

const feeService = require(path.join(root, "services", "class-student-fee-service.ts"));
const studentService = require(path.join(root, "services", "student-service.ts"));
const lectureService = require(path.join(root, "services", "lecture-service.ts"));
const events = require(path.join(root, "services", "fee-waiver-events.ts"));
const rulesRoute = require(path.join(root, "app", "api", "classes", "[id]", "fee-waiver-rules", "route.ts"));
const ruleRoute = require(path.join(root, "app", "api", "classes", "[id]", "fee-waiver-rules", "[ruleId]", "route.ts"));
const resetRoute = require(path.join(root, "app", "api", "payments", "fees", "[id]", "reset-late-join", "route.ts"));

const digits = (wall) => new Date(`${wall}:00.000Z`);
const sl = (wall) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60 * 1000);

const T = "teacher-1";
const C = "class-1";
const OTHER_CLASS = "class-2";

// Silence the expected "[FEE_WAIVER] ..." logs of the failure tests.
const originalError = console.error;
test.before(() => {
  console.error = (...args) => {
    if (String(args[0]).startsWith("[FEE_WAIVER]")) return;
    originalError(...args);
  };
});
test.after(() => {
  console.error = originalError;
});

function seed({ dueWeek = 4 } = {}) {
  db.reset();
  db.insert("FeeWaiverSettings", { id: "default", startYear: 2026, startMonth: 12 });
  db.insert("Class", { id: C, teacherId: T, status: 0, name: "Maths", monthlyFee: 2000, paymentDueWeek: dueWeek, schedule: "TBD" });
  db.insert("Class", { id: OTHER_CLASS, teacherId: T, status: 0, name: "Physics", monthlyFee: 1500, paymentDueWeek: dueWeek, schedule: "TBD" });
  db.insert("ClassFeeWaiverRule", { id: "r1", classId: C, sequence: 1, type: "PERCENTAGE", value: 10 });
  db.insert("ClassFeeWaiverRule", { id: "r2", classId: C, sequence: 2, type: "PERCENTAGE", value: 20 });
  db.insert("ClassFeeWaiverRule", { id: "r3", classId: C, sequence: 3, type: "PERCENTAGE", value: 40 });
  const lecture = (id, wall, classStatus = "COMPLETED", status = 0, classId = C) =>
    db.insert("Lecture", { id, classId, title: id, date: sl(wall), classStatus, status });
  lecture("L5", "2026-12-05T18:00");
  lecture("L8", "2026-12-08T18:00", "LIVE");
  lecture("L10", "2026-12-10T18:00", "CANCELLED");
  lecture("L12", "2026-12-12T18:00");
  lecture("L15", "2026-12-15T18:00", "COMPLETED", 1);
  lecture("L19", "2026-12-19T18:00");
  lecture("P6", "2026-12-06T18:00", "COMPLETED", 0, OTHER_CLASS);
}

function student(id, over = {}) {
  return db.insert("Student", {
    id,
    name: id,
    teacherId: T,
    status: 0,
    registrationNumber: id.toUpperCase(),
    registrationSource: "TEACHER",
    publicClassId: null,
    confirmationStatus: "APPROVED",
    confirmedAt: null,
    approvedAt: null,
    ...over,
  });
}

function enrol(id, studentId, assignedWall, removedWall = null, classId = C) {
  return db.insert("ClassStudent", {
    id,
    classId,
    studentId,
    isActive: !removedWall,
    assignedAt: digits(assignedWall),
    removedAt: removedWall ? digits(removedWall) : null,
  });
}

const DEC_DUE = new Date(Date.UTC(2026, 11, 28, 23, 59, 59, 999)); // week 4 (digits)

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

function pay(feeId, status = "CONFIRMED") {
  return db.insert("ClassPayment", { classStudentFeeId: feeId, classId: C, studentId: "x", amount: 1, status, submittedAt: new Date(Date.UTC(2026, 11, 1)) });
}

const at = (t, wall) => t.mock.timers.enable({ apis: ["Date"], now: sl(wall) });
const feeRow = (id) => db.row("ClassStudentFee", id);
const feeRowOf = (classStudentId, month = 12, year = 2026) =>
  db.tables.ClassStudentFee.find((r) => r.classStudentId === classStudentId && r.month === month && r.year === year);

// ---- Invoice creation ---------------------------------------------------------

test("new current-month invoice (enrolment) gets the waiver inside the enrolment transaction", async (t) => {
  seed();
  at(t, "2026-12-20T10:00");
  student("s1");
  enrol("e1", "s1", "2026-12-20T10:00");

  await feeService.ensureCurrentMonthFeeForClassStudent(db.client, "e1");

  const row = feeRowOf("e1");
  assert.equal(row.lateJoinDeduct, 800, "3 completed lectures (5, 12, 19) → rule 3 = 40%; LIVE/CANCELLED/deleted/other class ignored");
  assert.equal(row.finalAmount, 1200);
  assert.equal(row.joinWaiverSequence, 3);
  assert.equal(row.joinWaiverRuleId, "r3");
  assert.equal(row.joinWaiverLecturesBefore, 3);
  assert.equal(row.joinWaiverEnrolledAt.toISOString(), sl("2026-12-20T10:00").toISOString());
  assert.equal(row.joinWaiverBaseAmount, 2000);
  assert.equal(row.lateJoinDeductManual, false);
});

test("launch gate: November invoices never get waiver columns, December ones do", async (t) => {
  seed();
  db.insert("Lecture", { id: "N1", classId: C, title: "n", date: sl("2026-11-05T18:00"), classStatus: "COMPLETED", status: 0 });
  at(t, "2026-11-30T23:59");
  student("s1");
  enrol("e1", "s1", "2026-11-30T23:59");
  await feeService.ensureCurrentMonthFeeForClassStudent(db.client, "e1");
  const nov = feeRowOf("e1", 11);
  assert.equal(nov.lateJoinDeduct, 0);
  assert.equal(nov.joinWaiverSequence, null);
  assert.equal(nov.joinWaiverComputedAt, null);
});

test("missing settings row: automatic waivers off everywhere (fail-safe)", async (t) => {
  seed();
  db.tables.FeeWaiverSettings.length = 0;
  at(t, "2026-12-20T10:00");
  student("s1");
  enrol("e1", "s1", "2026-12-20T10:00");
  await feeService.ensureCurrentMonthFeeForClassStudent(db.client, "e1");
  assert.equal(feeRowOf("e1").lateJoinDeduct, 0);
});

test("page load (current month, before the due date): automatic rows recalculated; manual and paid untouched", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("auto");
  student("manual");
  student("paid");
  enrol("ea", "auto", "2026-12-20T10:00");
  enrol("em", "manual", "2026-12-20T10:00");
  enrol("ep", "paid", "2026-12-20T10:00");
  fee("fa", "ea");
  fee("fm", "em", { lateJoinDeduct: 300, finalAmount: 1700, lateJoinDeductManual: true });
  fee("fp", "ep");
  pay("fp");

  const sheet = await feeService.getMonthlyFeeSheet({ teacherId: T, classId: C, year: 2026, month: 12 });

  assert.equal(feeRow("fa").lateJoinDeduct, 800);
  assert.equal(feeRow("fa").finalAmount, 1200);
  assert.equal(feeRow("fm").lateJoinDeduct, 300, "manual kept");
  assert.equal(feeRow("fp").lateJoinDeduct, 0, "paid frozen");
  assert.equal(sheet.joinWaiversActive, true);
  const autoRow = sheet.rows.find((r) => r.feeId === "fa");
  assert.deepEqual(
    { ...autoRow.joinWaiver, computedAt: undefined },
    { sequence: 3, type: "PERCENTAGE", value: 40, lecturesBefore: 3, enrolledAt: sl("2026-12-20T10:00").toISOString(), baseAmount: 2000, computedAt: undefined }
  );
  assert.equal(sheet.rows.find((r) => r.feeId === "fm").lateJoinDeductManual, true);
  assert.equal(sheet.rows.find((r) => r.feeId === "fm").joinWaiver, null);
});

test("page load after the due date: existing rows frozen, new rows still get their waiver", async (t) => {
  seed({ dueWeek: 1 }); // due 7 Dec
  at(t, "2026-12-21T09:00");
  student("old");
  student("new");
  enrol("eo", "old", "2026-12-20T10:00");
  enrol("en", "new", "2026-12-21T08:00");
  fee("fo", "eo", { dueDate: new Date(Date.UTC(2026, 11, 7, 23, 59, 59, 999)) });

  await feeService.getMonthlyFeeSheet({ teacherId: T, classId: C, year: 2026, month: 12 });

  assert.equal(feeRow("fo").lateJoinDeduct, 0, "frozen by the existing due-date rule");
  assert.equal(feeRowOf("en").lateJoinDeduct, 800, "new invoice calculated on creation");
});

test("past month on page load: only NEW rows get a waiver; existing past rows untouched", async (t) => {
  seed();
  at(t, "2027-01-05T09:00");
  student("old");
  student("new");
  enrol("eo", "old", "2026-12-20T10:00");
  enrol("en", "new", "2026-12-20T11:00", "2026-12-30T10:00");
  fee("fo", "eo");

  await feeService.getMonthlyFeeSheet({ teacherId: T, classId: C, year: 2026, month: 12 });

  assert.equal(feeRow("fo").lateJoinDeduct, 0, "existing past row not recalculated by a page load");
  assert.equal(feeRowOf("en").lateJoinDeduct, 800, "back-filled row calculated");
});

test("Reprocess: unpaid automatic rows recalculated (any month ≥ launch); manual / paid untouched; November never", async (t) => {
  seed({ dueWeek: 1 });
  at(t, "2027-01-05T09:00");
  student("auto");
  student("manual");
  student("paid");
  enrol("ea", "auto", "2026-12-20T10:00");
  enrol("em", "manual", "2026-12-20T10:00");
  enrol("ep", "paid", "2026-12-20T10:00");
  fee("fa", "ea");
  fee("fm", "em", { lateJoinDeduct: 300, finalAmount: 1700, lateJoinDeductManual: true });
  fee("fp", "ep", { lateJoinDeduct: 0 });
  pay("fp");
  // A stale November automatic row must stay untouched (before the launch month).
  fee("fnov", "ea", { month: 11, lateJoinDeduct: 0 });
  db.insert("Lecture", { id: "N1", classId: C, title: "n", date: sl("2026-11-05T18:00"), classStatus: "COMPLETED", status: 0 });

  await feeService.reprocessMonthlyFees({ teacherId: T, classId: C, year: 2026, month: 12 });
  await feeService.reprocessMonthlyFees({ teacherId: T, classId: C, year: 2026, month: 11 });

  assert.equal(feeRow("fa").lateJoinDeduct, 800);
  assert.equal(feeRow("fa").finalAmount, 1200);
  assert.equal(feeRow("fm").lateJoinDeduct, 300);
  assert.equal(feeRow("fm").finalAmount, 1700);
  assert.equal(feeRow("fp").lateJoinDeduct, 0);
  assert.equal(feeRow("fp").status, 1, "paid: status only (existing behaviour)");
  assert.equal(feeRow("fnov").lateJoinDeduct, 0);
  assert.equal(feeRow("fnov").joinWaiverSequence, null);
});

test("amount change: percentage waivers follow the new fee; manual rows keep their deduction", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("auto");
  student("manual");
  enrol("ea", "auto", "2026-12-20T10:00");
  enrol("em", "manual", "2026-12-20T10:00");
  fee("fa", "ea", { lateJoinDeduct: 800, finalAmount: 1200, joinWaiverSequence: 3 });
  fee("fm", "em", { lateJoinDeduct: 300, finalAmount: 1700, lateJoinDeductManual: true });

  await feeService.setMonthlyFeeAmount({ teacherId: T, classId: C, year: 2026, month: 12, amount: 3000, applyToAll: true });

  assert.equal(feeRow("fa").amount, 3000);
  assert.equal(feeRow("fa").lateJoinDeduct, 1200, "40% of 3000");
  assert.equal(feeRow("fa").finalAmount, 1800);
  assert.equal(feeRow("fm").amount, 3000);
  assert.equal(feeRow("fm").lateJoinDeduct, 300);
  assert.equal(feeRow("fm").finalAmount, 2700);
});

test("teacher edit of lateJoinDeduct marks it manual and clears the snapshot; same value does not", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s1");
  enrol("e1", "s1", "2026-12-20T10:00");
  fee("f1", "e1", { lateJoinDeduct: 800, finalAmount: 1200, joinWaiverSequence: 3, joinWaiverRuleId: "r3" });

  await feeService.updateStudentFeeAdjustment({ teacherId: T, feeId: "f1", lateJoinDeduct: 800 });
  assert.equal(feeRow("f1").lateJoinDeductManual, false, "unchanged value is not an override");

  await feeService.updateStudentFeeAdjustment({ teacherId: T, feeId: "f1", discount: 100 });
  assert.equal(feeRow("f1").lateJoinDeductManual, false, "other adjustments do not touch the flag");

  const updated = await feeService.updateStudentFeeAdjustment({ teacherId: T, feeId: "f1", lateJoinDeduct: 500 });
  assert.equal(updated.lateJoinDeductManual, true);
  assert.equal(feeRow("f1").joinWaiverSequence, null);
  assert.equal(feeRow("f1").joinWaiverRuleId, null);
  assert.equal(feeRow("f1").finalAmount, 1400);

  await feeService.getMonthlyFeeSheet({ teacherId: T, classId: C, year: 2026, month: 12 });
  assert.equal(feeRow("f1").lateJoinDeduct, 500, "never overwritten by the automatic pass");
});

// ---- Reset to automatic ------------------------------------------------------------

test("reset: manual → automatic, only the late-join fields change", async (t) => {
  seed({ dueWeek: 1 });
  at(t, "2026-12-29T09:00");
  student("s1");
  enrol("e1", "s1", "2026-12-20T10:00");
  fee("f1", "e1", { discount: 100, waiverAmount: 50, lateJoinDeduct: 300, finalAmount: 1550, lateJoinDeductManual: true });
  db.insert("ClassPayment", { classStudentFeeId: "f1", classId: C, studentId: "s1", amount: 10, status: "PENDING", submittedAt: new Date() });

  const response = await resetRoute.POST(new Request("http://x/reset", { method: "POST" }), { params: { id: "f1" } });
  assert.equal(response.status, 200);

  const row = feeRow("f1");
  assert.equal(row.lateJoinDeductManual, false);
  assert.equal(row.lateJoinDeduct, 800, "ignores the due-date freeze (explicit)");
  assert.equal(row.discount, 100);
  assert.equal(row.waiverAmount, 50);
  assert.equal(row.amount, 2000);
  assert.equal(row.finalAmount, 2000 - 100 - 800 - 50);
  assert.equal(db.tables.ClassPayment.filter((p) => p.classStudentFeeId === "f1").length, 1, "payments untouched");
});

test("reset refusals: paid, already automatic, pre-launch month, another teacher", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s1");
  enrol("e1", "s1", "2026-12-20T10:00");
  fee("fpaid", "e1", { lateJoinDeductManual: true, lateJoinDeduct: 300 });
  pay("fpaid");
  fee("fauto", "e1", { month: 1, year: 2027 });
  fee("fnov", "e1", { month: 11, lateJoinDeductManual: true, lateJoinDeduct: 300 });

  const call = async (id) => {
    const res = await resetRoute.POST(new Request("http://x", { method: "POST" }), { params: { id } });
    return { status: res.status, body: await res.json() };
  };

  assert.deepEqual((await call("fpaid")).status, 409);
  assert.equal((await call("fpaid")).body.error.code, "FEE_LOCKED");
  assert.equal((await call("fauto")).body.error.code, "NOT_MANUAL");
  assert.equal((await call("fnov")).body.error.code, "WAIVER_NOT_ACTIVE_FOR_MONTH");
  assert.equal(feeRow("fnov").lateJoinDeduct, 300);

  sessionTeacherId = "teacher-2";
  try {
    assert.equal((await call("fnov")).status, 404);
  } finally {
    sessionTeacherId = T;
  }
});

test("reset concurrency: a manual edit or a payment landing first wins; nothing is written", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s1");
  enrol("e1", "s1", "2026-12-20T10:00");
  fee("f1", "e1", { lateJoinDeductManual: true, lateJoinDeduct: 300, finalAmount: 1700 });

  db.hooks.beforeUpdateMany = () => db.touch("ClassStudentFee", "f1", { lateJoinDeduct: 450, finalAmount: 1550 });
  await assert.rejects(feeService.resetLateJoinDeductToAutomatic({ teacherId: T, feeId: "f1" }), (e) => e.code === "FEE_CHANGED");
  assert.equal(feeRow("f1").lateJoinDeduct, 450, "the newer manual value is kept");
  assert.equal(feeRow("f1").lateJoinDeductManual, true);

  db.hooks.beforeUpdateMany = () => pay("f1");
  await assert.rejects(feeService.resetLateJoinDeductToAutomatic({ teacherId: T, feeId: "f1" }), (e) => e.code === "FEE_LOCKED");
  assert.equal(feeRow("f1").lateJoinDeduct, 450);
});

// ---- Automatic writes under concurrency ---------------------------------------------

test("automatic recalculation never overwrites a concurrent manual edit or payment", async (t) => {
  seed({ dueWeek: 1 });
  at(t, "2026-12-29T09:00");
  student("s1");
  enrol("e1", "s1", "2026-12-20T10:00");
  fee("f1", "e1");

  db.hooks.beforeUpdateMany = () =>
    db.touch("ClassStudentFee", "f1", { lateJoinDeduct: 250, finalAmount: 1750, lateJoinDeductManual: true });
  await feeService.recalculateJoinWaiversForClassMonth({ classId: C, month: { year: 2026, month: 12 } });
  assert.equal(feeRow("f1").lateJoinDeduct, 250);

  seed({ dueWeek: 1 });
  student("s1");
  enrol("e1", "s1", "2026-12-20T10:00");
  fee("f1", "e1");
  db.hooks.beforeUpdateMany = () => pay("f1");
  await feeService.recalculateJoinWaiversForClassMonth({ classId: C, month: { year: 2026, month: 12 } });
  assert.equal(feeRow("f1").lateJoinDeduct, 0, "paid in between: untouched");
});

test("overlapping automatic passes: identical results, no duplicate invoices", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s1");
  enrol("e1", "s1", "2026-12-20T10:00");
  await Promise.all([
    feeService.getMonthlyFeeSheet({ teacherId: T, classId: C, year: 2026, month: 12 }),
    feeService.getMonthlyFeeSheet({ teacherId: T, classId: C, year: 2026, month: 12 }),
  ]);
  const rows = db.tables.ClassStudentFee.filter((r) => r.classStudentId === "e1" && r.month === 12);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lateJoinDeduct, 800);
});

// ---- Approval / decline -------------------------------------------------------------

test("approval: first approvedAt; recalculated past the due date; decline removes; re-approval keeps the first", async (t) => {
  seed({ dueWeek: 1 }); // due 7 Dec, so these events must bypass the freeze
  // Registered 28 Nov (pending), December invoice exists without a waiver.
  student("p1", { registrationSource: "PUBLIC_CLASS", publicClassId: C, confirmationStatus: "PENDING" });
  enrol("ep", "p1", "2026-11-28T15:00");
  fee("fp", "ep", { dueDate: new Date(Date.UTC(2026, 11, 7, 23, 59, 59, 999)) });

  at(t, "2026-12-13T10:00");
  await studentService.confirmStudent(T, "p1");
  const firstApproval = db.row("Student", "p1").approvedAt.toISOString();
  assert.equal(firstApproval, sl("2026-12-13T10:00").toISOString());
  assert.equal(feeRow("fp").lateJoinDeduct, 400, "lectures 5 and 12 before the 13 Dec approval → rule 2");

  t.mock.timers.setTime(sl("2026-12-20T09:00").getTime());
  await studentService.declineStudent(T, "p1");
  assert.equal(db.row("Student", "p1").approvedAt.toISOString(), firstApproval, "decline keeps approvedAt");
  assert.equal(feeRow("fp").lateJoinDeduct, 0, "rejected: automatic waiver removed");
  assert.equal(feeRow("fp").joinWaiverSequence, null);

  t.mock.timers.setTime(sl("2026-12-22T09:00").getTime());
  await studentService.confirmStudent(T, "p1");
  assert.equal(db.row("Student", "p1").approvedAt.toISOString(), firstApproval, "re-approval keeps the FIRST approvedAt");
  assert.equal(feeRow("fp").lateJoinDeduct, 400, "still rule 2 (not 3): counted from the first approval");
});

test("approval never touches paid or manual invoices", async (t) => {
  seed();
  student("p1", { registrationSource: "PUBLIC_CLASS", publicClassId: C, confirmationStatus: "PENDING" });
  enrol("ep", "p1", "2026-11-28T15:00");
  fee("fp", "ep", { lateJoinDeductManual: true, lateJoinDeduct: 111, finalAmount: 1889 });
  at(t, "2026-12-13T10:00");
  await studentService.confirmStudent(T, "p1");
  assert.equal(feeRow("fp").lateJoinDeduct, 111);

  seed();
  student("p1", { registrationSource: "PUBLIC_CLASS", publicClassId: C, confirmationStatus: "PENDING" });
  enrol("ep", "p1", "2026-11-28T15:00");
  fee("fp", "ep");
  pay("fp");
  await studentService.confirmStudent(T, "p1");
  assert.equal(feeRow("fp").lateJoinDeduct, 0);
});

test("never-approved → rejected → approved: approvedAt set at that (first) approval", async (t) => {
  seed();
  student("p1", { registrationSource: "PUBLIC_CLASS", publicClassId: C, confirmationStatus: "PENDING" });
  enrol("ep", "p1", "2026-12-01T09:00");
  at(t, "2026-12-02T09:00");
  await studentService.declineStudent(T, "p1");
  assert.equal(db.row("Student", "p1").approvedAt, null);
  t.mock.timers.setTime(sl("2026-12-14T09:00").getTime());
  await studentService.confirmStudent(T, "p1");
  assert.equal(db.row("Student", "p1").approvedAt.toISOString(), sl("2026-12-14T09:00").toISOString());
});

test("approve-all fills approvedAt only where empty and recalculates each student", async (t) => {
  seed();
  student("a", { registrationSource: "PUBLIC_CLASS", publicClassId: C, confirmationStatus: "PENDING" });
  student("b", { registrationSource: "PUBLIC_CLASS", publicClassId: C, confirmationStatus: "PENDING", approvedAt: sl("2026-12-03T09:00") });
  enrol("ea", "a", "2026-12-01T09:00");
  enrol("eb", "b", "2026-12-01T09:00");
  fee("fa", "ea");
  fee("fb", "eb");
  at(t, "2026-12-13T10:00");

  const count = await studentService.confirmAllPendingStudents(T);
  assert.equal(count, 2);
  assert.equal(db.row("Student", "a").approvedAt.toISOString(), sl("2026-12-13T10:00").toISOString());
  assert.equal(db.row("Student", "b").approvedAt.toISOString(), sl("2026-12-03T09:00").toISOString());
  assert.equal(feeRow("fa").lateJoinDeduct, 400);
  assert.equal(feeRow("fb").lateJoinDeduct, 0, "no completed lecture before 3 Dec");
});

test("a failing recalculation never fails the approval or the decline", async (t) => {
  seed();
  student("p1", { registrationSource: "PUBLIC_CLASS", publicClassId: C, confirmationStatus: "PENDING" });
  enrol("ep", "p1", "2026-12-01T09:00");
  fee("fp", "ep");
  at(t, "2026-12-13T10:00");
  db.hooks.failOn = (model, method) => model === "ClassFeeWaiverRule" && method === "findMany";
  await studentService.confirmStudent(T, "p1");
  assert.equal(db.row("Student", "p1").confirmationStatus, "APPROVED");
  await studentService.declineStudent(T, "p1");
  assert.equal(db.row("Student", "p1").confirmationStatus, "REJECTED");
});

// ---- Lecture events -------------------------------------------------------------------

function lectureEventFixture(t) {
  seed({ dueWeek: 1 }); // after the due date: events must bypass the freeze
  at(t, "2026-12-29T09:00");
  student("s1");
  enrol("e1", "s1", "2026-12-20T10:00");
  fee("f1", "e1");
  db.row("Lecture", "L19").classStatus = "LIVE"; // held, not yet marked completed
}

test("lecture becomes COMPLETED → class/month recalculated (bypassing the freeze)", async (t) => {
  lectureEventFixture(t);
  await feeService.recalculateJoinWaiversForClassMonth({ classId: C, month: { year: 2026, month: 12 } });
  assert.equal(feeRow("f1").lateJoinDeduct, 400, "two completed lectures so far");

  const lecture = await lectureService.updateLectureClassStatusForTeacher(T, "L19", "COMPLETED");
  assert.equal(lecture.classStatus, "COMPLETED");
  assert.equal(feeRow("f1").lateJoinDeduct, 800, "now rule 3");
});

test("COMPLETED → CANCELLED, soft delete and session restart (LIVE) remove / reduce the waiver", async (t) => {
  lectureEventFixture(t);
  db.row("Lecture", "L19").classStatus = "COMPLETED";
  await feeService.recalculateJoinWaiversForClassMonth({ classId: C, month: { year: 2026, month: 12 } });
  assert.equal(feeRow("f1").lateJoinDeduct, 800);

  await lectureService.updateLectureClassStatusForTeacher(T, "L19", "CANCELLED");
  assert.equal(feeRow("f1").lateJoinDeduct, 400);

  await lectureService.deleteLectureForTeacher(T, "L12");
  assert.equal(feeRow("f1").lateJoinDeduct, 200);

  // The session / YouTube start path: COMPLETED → LIVE (the hook's own call).
  const before = { classId: C, date: sl("2026-12-05T18:00"), classStatus: "COMPLETED", status: 0 };
  db.row("Lecture", "L5").classStatus = "LIVE";
  await events.recalculateAfterLectureChange(before, { ...before, classStatus: "LIVE" });
  assert.equal(feeRow("f1").lateJoinDeduct, 0, "no completed lecture left → waiver removed");
  assert.equal(feeRow("f1").joinWaiverSequence, null);
});

test("a COMPLETED lecture moving to another month recalculates both months", async (t) => {
  lectureEventFixture(t);
  db.row("Lecture", "L19").classStatus = "COMPLETED";
  student("s2");
  enrol("e2", "s2", "2027-01-10T10:00");
  fee("f2", "e2", { year: 2027, month: 1, dueDate: new Date(Date.UTC(2027, 0, 7, 23, 59, 59, 999)) });
  await feeService.recalculateJoinWaiversForClassMonth({ classId: C, month: { year: 2026, month: 12 } });
  assert.equal(feeRow("f1").lateJoinDeduct, 800);
  assert.equal(feeRow("f2").lateJoinDeduct, 0);

  await lectureService.updateLectureForTeacher(T, "L19", { date: sl("2027-01-03T18:00") });

  assert.equal(feeRow("f1").lateJoinDeduct, 400, "December lost a lecture");
  assert.equal(feeRow("f2").lateJoinDeduct, 200, "January gained one (rule 1)");
});

test("changes that never involve COMPLETED do not recalculate", async (t) => {
  lectureEventFixture(t);
  const before = db.writes.length;
  await lectureService.updateLectureClassStatusForTeacher(T, "L8", "CANCELLED"); // LIVE → CANCELLED
  await lectureService.updateLectureForTeacher(T, "L19", { title: "renamed" }); // LIVE, same date
  const feeWrites = db.writes.slice(before).filter((w) => w.model === "ClassStudentFee");
  assert.deepEqual(feeWrites, []);
});

test("a failing recalculation never fails the lecture change", async (t) => {
  lectureEventFixture(t);
  db.hooks.failOn = (model, method) => model === "ClassFeeWaiverRule" && method === "findMany";
  const lecture = await lectureService.updateLectureClassStatusForTeacher(T, "L19", "COMPLETED");
  assert.equal(lecture.classStatus, "COMPLETED");
  assert.equal(db.row("Lecture", "L19").classStatus, "COMPLETED");
});

test("affected months: old and new, deduplicated, none without COMPLETED", () => {
  const s = (wall, classStatus = "COMPLETED", status = 0) => ({ classId: C, date: sl(wall), classStatus, status });
  assert.deepEqual(events.affectedClassMonths(s("2026-12-05T18:00", "LIVE"), s("2026-12-05T18:00")), [{ classId: C, month: { year: 2026, month: 12 } }]);
  assert.deepEqual(events.affectedClassMonths(s("2026-12-05T18:00"), s("2026-12-05T18:00", "CANCELLED")), [{ classId: C, month: { year: 2026, month: 12 } }]);
  assert.deepEqual(events.affectedClassMonths(s("2026-12-31T23:30"), s("2027-01-01T00:15")), [
    { classId: C, month: { year: 2026, month: 12 } },
    { classId: C, month: { year: 2027, month: 1 } },
  ]);
  assert.deepEqual(events.affectedClassMonths(s("2026-12-05T18:00"), s("2026-12-09T18:00")), [{ classId: C, month: { year: 2026, month: 12 } }]);
  assert.deepEqual(events.affectedClassMonths(s("2026-12-05T18:00", "LIVE"), s("2026-12-05T18:00", "CANCELLED")), []);
  assert.deepEqual(events.affectedClassMonths(s("2026-12-05T18:00"), s("2026-12-05T18:00")), []);
  assert.deepEqual(events.affectedClassMonths(s("2026-12-05T18:00"), s("2026-12-05T18:00", "COMPLETED", 1)), [{ classId: C, month: { year: 2026, month: 12 } }]);
});

test("session / YouTube start hooks: only when the lecture WAS COMPLETED, in the background", () => {
  const session = fs.readFileSync(path.join(root, "services", "session-service.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(session, /if \(lecture\.classStatus === "COMPLETED"\) \{[\s\S]{0,300}void recalculateAfterLectureChange\(waiverBefore, \{ \.\.\.waiverBefore, classStatus: "LIVE" \}\)\.catch\(\(\) => \{\}\);/);
  const youtube = fs.readFileSync(path.join(root, "lib", "youtube-lecture.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(youtube, /if \(lecture\.classStatus === "COMPLETED"\) \{[\s\S]{0,300}void recalculateAfterLectureChange\(waiverBefore, \{ \.\.\.waiverBefore, classStatus: "LIVE" \}\)\.catch\(\(\) => \{\}\);/);
});

test("lecture creation needs no hook (new lectures are never COMPLETED)", () => {
  const validation = fs.readFileSync(path.join(root, "lib", "lecture-validation.ts"), "utf8");
  const createBlock = validation.slice(validation.indexOf("export const createLectureSchema"), validation.indexOf("export const updateLectureSchema"));
  assert.doesNotMatch(createBlock, /classStatus/);
});

// ---- Rejoining ---------------------------------------------------------------------------

test("rejoining: left in October and rejoined in December → waiver; two December rows → one waiver", async (t) => {
  seed();
  at(t, "2026-12-29T09:00");
  student("s1");
  enrol("old", "s1", "2026-09-01T10:00", "2026-10-15T10:00");
  enrol("e1", "s1", "2026-12-06T10:00", "2026-12-10T10:00");
  enrol("e2", "s1", "2026-12-20T10:00");
  fee("f1", "e1");
  fee("f2", "e2");
  await feeService.reprocessMonthlyFees({ teacherId: T, classId: C, year: 2026, month: 12 });
  assert.equal(feeRow("f1").lateJoinDeduct, 200, "earliest December enrolment: 1 lecture before 6 Dec");
  assert.equal(feeRow("f2").lateJoinDeduct, 0, "second December enrolment: no second waiver");
  assert.equal(db.tables.ClassStudentFee.filter((r) => r.month === 12).length, 2, "invoice behaviour unchanged");
});

// ---- Rules API ------------------------------------------------------------------------------

async function callRules(method, { ruleId, body, classId = C } = {}) {
  const url = `http://x/api/classes/${classId}/fee-waiver-rules${ruleId ? `/${ruleId}` : ""}`;
  const request = new Request(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const handler = ruleId ? ruleRoute[method] : rulesRoute[method];
  const response = await handler(request, { params: { id: classId, ...(ruleId ? { ruleId } : {}) } });
  return { status: response.status, body: await response.json() };
}

test("rules API: list, add at the next position, validation", async () => {
  seed();
  const listed = await callRules("GET");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data.rules.map((r) => r.sequence), [1, 2, 3]);

  const added = await callRules("POST", { body: { type: "FIXED_AMOUNT", value: 900 } });
  assert.equal(added.status, 201);
  assert.deepEqual(added.body.data.rules.at(-1), { id: added.body.data.rules.at(-1).id, sequence: 4, type: "FIXED_AMOUNT", value: 900 });

  for (const body of [
    { type: "PERCENTAGE", value: 0 },
    { type: "PERCENTAGE", value: 101 },
    { type: "PERCENTAGE", value: 2.5 },
    { type: "FIXED_AMOUNT", value: -5 },
    { type: "OTHER", value: 5 },
    { type: "FIXED_AMOUNT" },
  ]) {
    assert.equal((await callRules("POST", { body })).status, 400, JSON.stringify(body));
  }
});

test("rules API: 20-rule limit, edit, remove renumbers, ownership", async () => {
  seed();
  for (let i = 4; i <= 20; i += 1) {
    assert.equal((await callRules("POST", { body: { type: "PERCENTAGE", value: 5 } })).status, 201);
  }
  const over = await callRules("POST", { body: { type: "PERCENTAGE", value: 5 } });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, "RULE_LIMIT");

  const edited = await callRules("PUT", { ruleId: "r2", body: { type: "FIXED_AMOUNT", value: 350 } });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.data.rules[1], { id: "r2", sequence: 2, type: "FIXED_AMOUNT", value: 350 });

  const removed = await callRules("DELETE", { ruleId: "r2" });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.data.rules.slice(0, 3).map((r) => [r.id, r.sequence]), [["r1", 1], ["r3", 2], [removed.body.data.rules[2].id, 3]]);
  assert.equal(db.row("ClassFeeWaiverRule", "r2").status, 1, "soft delete");
  assert.equal(removed.body.data.rules.length, 19);

  assert.equal((await callRules("DELETE", { ruleId: "r2" })).status, 404, "already removed");

  sessionTeacherId = "teacher-2";
  try {
    assert.equal((await callRules("GET")).status, 404);
    assert.equal((await callRules("POST", { body: { type: "PERCENTAGE", value: 5 } })).status, 404);
    assert.equal((await callRules("PUT", { ruleId: "r1", body: { type: "PERCENTAGE", value: 5 } })).status, 404);
  } finally {
    sessionTeacherId = T;
  }
  assert.equal((await callRules("PUT", { ruleId: "r1", classId: OTHER_CLASS, body: { type: "PERCENTAGE", value: 5 } })).status, 404, "rule of another class");
});

test("rules API: simultaneous additions never share a position (409 on conflict)", async () => {
  seed();
  db.hooks.beforeCreate = (model, args) => {
    if (model !== "ClassFeeWaiverRule") return;
    db.hooks.beforeCreate = null;
    // Another request took this position first.
    db.insert("ClassFeeWaiverRule", { classId: C, sequence: args.data.sequence, type: "PERCENTAGE", value: 7 });
  };
  const conflict = await callRules("POST", { body: { type: "PERCENTAGE", value: 5 } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "RULE_CONFLICT");
  const sequences = db.tables.ClassFeeWaiverRule.filter((r) => r.classId === C && r.status === 0).map((r) => r.sequence);
  assert.equal(new Set(sequences).size, sequences.length);
});

test("invoice snapshots stay correct after the rule is edited, removed or renumbered", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s1");
  enrol("e1", "s1", "2026-12-20T10:00");
  await feeService.ensureCurrentMonthFeeForClassStudent(db.client, "e1");
  const row = feeRowOf("e1");
  db.tables.ClassStudentFee.find((r) => r.id === row.id).payments = undefined;
  pay(row.id); // paid: frozen

  await callRules("PUT", { ruleId: "r3", body: { type: "FIXED_AMOUNT", value: 1 } });
  await callRules("DELETE", { ruleId: "r1" });

  const sheet = await feeService.getMonthlyFeeSheet({ teacherId: T, classId: C, year: 2026, month: 12 });
  const shown = sheet.rows.find((r) => r.feeId === row.id);
  assert.equal(shown.lateJoinDeduct, 800);
  assert.equal(shown.joinWaiver.sequence, 3);
  assert.equal(shown.joinWaiver.type, "PERCENTAGE");
  assert.equal(shown.joinWaiver.value, 40);
});
