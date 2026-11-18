/*
 * Teacher-issued Free Cards: fee calculation, the bulk issue / revoke service
 * and route, every fee recalculation path under an active card, the student
 * payment upload and the student / guardian views (real services and routes,
 * in-memory database from ./helpers/fake-db.cjs).
 *
 *   npm run test:fee-waiver
 *
 * Fixtures (class "Maths", fee Rs. 2000, due week 4 = 28 Dec, launch month
 * December 2026): rules 1 → 10%, 2 → 20%, 3 → 40%; December COMPLETED
 * lectures on the 5th, 12th and 19th, so a student who joined on 20 Dec gets
 * rule 3 (40%) automatically.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { createFakeDb } = require("./helpers/fake-db.cjs");

const db = createFakeDb();

// Models the student views read that the fee code does not model: empty.
const emptyDelegate = {
  count: async () => 0,
  findMany: async () => [],
  findFirst: async () => null,
  findUnique: async () => null,
};
const client = new Proxy(db.client, {
  get(target, prop) {
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
const studentService = require(path.join(root, "services", "student-service.ts"));
const countsService = require(path.join(root, "services", "student-dashboard-counts-service.ts"));
const countdownService = require(path.join(root, "services", "student-countdown-service.ts"));
const freeCardsRoute = require(path.join(root, "app", "api", "payments", "fees", "free-cards", "route.ts"));
const studentPaymentsRoute = require(path.join(root, "app", "api", "student", "payments", "route.ts"));
const studentDashboardPaymentsRoute = require(path.join(root, "app", "api", "student", "dashboard", "payments", "route.ts"));
const confirmRoute = require(path.join(root, "app", "api", "classes", "[id]", "payments", "[paymentId]", "confirm", "route.ts"));

const digits = (wall) => new Date(`${wall}:00.000Z`);
const sl = (wall) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60 * 1000);
const at = (t, wall) => t.mock.timers.enable({ apis: ["Date"], now: sl(wall) });
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const T = "teacher-1";
const C = "class-1";
const C2 = "class-2";
const C3 = "class-3"; // another teacher's class
const DEC_DUE = new Date(Date.UTC(2026, 11, 28, 23, 59, 59, 999));

function seed() {
  db.reset();
  db.insert("FeeWaiverSettings", { id: "default", startYear: 2026, startMonth: 12 });
  db.insert("Class", { id: C, teacherId: T, status: 0, name: "Maths", monthlyFee: 2000, paymentDueWeek: 4, schedule: "TBD", teacher: { name: "Teacher One" } });
  db.insert("Class", { id: C2, teacherId: T, status: 0, name: "Physics", monthlyFee: 1500, paymentDueWeek: 4, schedule: "TBD", teacher: { name: "Teacher One" } });
  db.insert("Class", { id: C3, teacherId: "teacher-2", status: 0, name: "Chemistry", monthlyFee: 1800, paymentDueWeek: 4, schedule: "TBD", teacher: { name: "Teacher One" } });
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

function enrol(id, studentId, assignedWall = "2026-12-20T10:00", classId = C) {
  return db.insert("ClassStudent", { id, classId, studentId, isActive: true, assignedAt: digits(assignedWall), removedAt: null });
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

function pay(feeId, status, amount = 2000, studentId = "x", classId = C) {
  return db.insert("ClassPayment", {
    classStudentFeeId: feeId,
    classId,
    studentId,
    amount,
    status,
    submittedAt: new Date(Date.UTC(2026, 11, 21)),
  });
}

const row = (id) => db.row("ClassStudentFee", id);
const snapshot = (model) => JSON.parse(JSON.stringify(db.tables[model]));
const UNDERNEATH = [
  "amount",
  "discount",
  "lateJoinDeduct",
  "waiverAmount",
  "lateJoinDeductManual",
  "joinWaiverRuleId",
  "joinWaiverSequence",
  "joinWaiverType",
  "joinWaiverValue",
  "joinWaiverLecturesBefore",
  "joinWaiverBaseAmount",
];
const pick = (r, keys = UNDERNEATH) => Object.fromEntries(keys.map((k) => [k, r[k]]));

const issue = (feeIds, over = {}) =>
  feeService.setFreeCards({ teacherId: T, classId: C, year: 2026, month: 12, feeIds, action: "issue", ...over });
const revoke = (feeIds, over = {}) =>
  feeService.setFreeCards({ teacherId: T, classId: C, year: 2026, month: 12, feeIds, action: "revoke", ...over });

async function rejects(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.statusCode ?? error.status, status, error.message);
    assert.equal(error.code, code);
    return true;
  });
}

// A student who joined on 20 Dec with an automatic 40% waiver, a discount and
// a manual waiver amount: 2000 − 200 − 800 − 300 = 700.
function adjustedFee(id, classStudentId) {
  return fee(id, classStudentId, {
    discount: 200,
    waiverAmount: 300,
    lateJoinDeduct: 800,
    finalAmount: 700,
    joinWaiverRuleId: "r3",
    joinWaiverSequence: 3,
    joinWaiverType: "PERCENTAGE",
    joinWaiverValue: 40,
    joinWaiverLecturesBefore: 3,
    joinWaiverEnrolledAt: sl("2026-12-20T10:00"),
    joinWaiverBaseAmount: 2000,
  });
}

// ---- Fee calculation -------------------------------------------------------------

test("computeFinalAmount: an active card always gives 0; without one the formula is unchanged", () => {
  const { computeFinalAmount } = feeService;
  const cases = [
    [2000, 0, 0, 0],
    [2000, 200, 800, 300],
    [3000, 0, 1200, 0],
    [1000, 600, 600, 0],
    [0, 0, 0, 0],
  ];
  for (const [amount, discount, late, waiver] of cases) {
    const expected = Math.max(0, amount - discount - late - waiver);
    assert.equal(computeFinalAmount(amount, discount, late, waiver), expected);
    assert.equal(computeFinalAmount(amount, discount, late, waiver, false), expected);
    assert.equal(computeFinalAmount(amount, discount, late, waiver, true), 0);
  }
});

// ---- Bulk issue / revoke -------------------------------------------------------------

test("issue: eligible students get a card; confirmed, pending, clarification and existing cards are skipped", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  for (const id of ["s1", "s2", "s3", "s4", "s5", "s6"]) student(id);
  enrol("e1", "s1");
  enrol("e2", "s2");
  enrol("e3", "s3");
  enrol("e4", "s4");
  enrol("e5", "s5");
  enrol("e6", "s6");
  fee(uid(1), "e1");
  adjustedFee(uid(2), "e2");
  fee(uid(3), "e3");
  fee(uid(4), "e4");
  fee(uid(5), "e5");
  fee(uid(6), "e6", { freeCard: true, finalAmount: 0, freeCardIssuedAt: new Date(Date.UTC(2026, 11, 1)), freeCardIssuedByTeacherId: T });
  pay(uid(3), "CONFIRMED");
  pay(uid(4), "PENDING");
  pay(uid(5), "NEEDS_CLARIFICATION");

  const paymentsBefore = snapshot("ClassPayment");
  const untouched = [uid(3), uid(4), uid(5), uid(6)].map((id) => ({ ...row(id) }));
  const componentsBefore = pick(row(uid(2)));

  const result = await issue([uid(1), uid(2), uid(3), uid(4), uid(5), uid(6)]);

  assert.deepEqual(result.processed.map((p) => p.feeId), [uid(1), uid(2)]);
  assert.deepEqual(
    result.skipped.map((s) => [s.feeId, s.reason]),
    [
      [uid(3), "CONFIRMED_PAYMENT"],
      [uid(4), "PENDING_PAYMENT"],
      [uid(5), "CLARIFICATION_PAYMENT"],
      [uid(6), "ALREADY_FREE_CARD"],
    ]
  );
  assert.equal(result.skipped[0].studentName, "Student s3");
  assert.ok(result.skipped.every((s) => s.message.length > 0));

  for (const id of [uid(1), uid(2)]) {
    assert.equal(row(id).freeCard, true);
    assert.equal(row(id).finalAmount, 0);
    assert.equal(row(id).freeCardIssuedByTeacherId, T);
    assert.ok(row(id).freeCardIssuedAt instanceof Date);
  }
  assert.deepEqual(pick(row(uid(2))), componentsBefore, "discount, waivers and the automatic waiver kept underneath");
  assert.deepEqual(snapshot("ClassPayment"), paymentsBefore, "no payment record touched");
  for (const before of untouched) {
    assert.deepEqual({ ...row(before.id) }, before, `skipped fee ${before.id} untouched`);
  }

  // The refreshed sheet in the response shows the cards.
  const sheetRows = new Map(result.sheet.rows.map((r) => [r.feeId, r]));
  assert.equal(sheetRows.get(uid(1)).paymentStatus, "FREE_CARD");
  assert.equal(sheetRows.get(uid(1)).freeCard, true);
  assert.equal(sheetRows.get(uid(1)).finalAmount, 0);
  assert.equal(sheetRows.get(uid(3)).paymentStatus, "PAID");
  assert.equal(sheetRows.get(uid(4)).paymentStatus, "PENDING");
});

test("revoke restores the current calculation from the preserved components", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s2");
  enrol("e2", "s2");
  adjustedFee(uid(2), "e2");

  await issue([uid(2)]);
  assert.equal(row(uid(2)).finalAmount, 0);

  const result = await revoke([uid(2)]);
  assert.deepEqual(result.processed.map((p) => p.feeId), [uid(2)]);
  assert.equal(row(uid(2)).freeCard, false);
  assert.equal(row(uid(2)).freeCardIssuedAt, null);
  assert.equal(row(uid(2)).freeCardIssuedByTeacherId, null);
  assert.equal(row(uid(2)).finalAmount, 700, "2000 − 200 − 800 − 300");
  assert.equal(row(uid(2)).lateJoinDeduct, 800);
  assert.equal(row(uid(2)).joinWaiverSequence, 3);
});

test("a class fee change keeps the card, updates the components underneath, and revoke uses the new fee", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s2");
  student("s7");
  enrol("e2", "s2");
  enrol("e7", "s7");
  adjustedFee(uid(2), "e2");
  fee(uid(7), "e7", { lateJoinDeduct: 800, finalAmount: 1200, joinWaiverSequence: 3 });
  await issue([uid(2)]);

  await feeService.setMonthlyFeeAmount({ teacherId: T, classId: C, year: 2026, month: 12, amount: 3000, applyToAll: true });

  assert.equal(row(uid(2)).freeCard, true, "apply-to-all never clears a card");
  assert.equal(row(uid(2)).finalAmount, 0);
  assert.equal(row(uid(2)).amount, 3000, "amount maintained underneath");
  assert.equal(row(uid(2)).lateJoinDeduct, 1200, "automatic 40% follows the new fee underneath");
  assert.equal(row(uid(7)).finalAmount, 1800, "a student without a card: unchanged behaviour (3000 − 1200)");

  await revoke([uid(2)]);
  assert.equal(row(uid(2)).finalAmount, 1300, "3000 − 200 − 1200 − 300");
});

test("Reprocess, page loads and automatic waiver recalculation keep the card; other students unchanged", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s1");
  student("s7");
  enrol("e1", "s1");
  enrol("e7", "s7");
  fee(uid(1), "e1"); // automatic waiver not yet calculated
  fee(uid(7), "e7");
  await issue([uid(1)]);

  await feeService.reprocessMonthlyFees({ teacherId: T, classId: C, year: 2026, month: 12 });
  assert.equal(row(uid(1)).freeCard, true);
  assert.equal(row(uid(1)).finalAmount, 0);
  assert.equal(row(uid(1)).lateJoinDeduct, 800, "automatic waiver calculated underneath the card");
  assert.equal(row(uid(1)).joinWaiverSequence, 3);
  assert.equal(row(uid(7)).lateJoinDeduct, 800);
  assert.equal(row(uid(7)).finalAmount, 1200, "no card: exactly the existing Reprocess result");

  const sheet = await feeService.getMonthlyFeeSheet({ teacherId: T, classId: C, year: 2026, month: 12 });
  assert.equal(row(uid(1)).freeCard, true, "page load keeps it");
  assert.equal(row(uid(1)).finalAmount, 0);
  assert.equal(sheet.rows.find((r) => r.feeId === uid(1)).paymentStatus, "FREE_CARD");

  await feeService.recalculateJoinWaiversForClassMonth({ classId: C, month: { year: 2026, month: 12 } });
  assert.equal(row(uid(1)).freeCard, true, "lecture / approval recalculation keeps it");
  assert.equal(row(uid(1)).finalAmount, 0);

  await revoke([uid(1)]);
  assert.equal(row(uid(1)).finalAmount, 1200, "revoke: the latest automatic calculation (2000 − 800)");
});

test("manual edits are refused under an active card and leave every value unchanged", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s2");
  enrol("e2", "s2");
  adjustedFee(uid(2), "e2");
  await issue([uid(2)]);
  row(uid(2)).lateJoinDeductManual = true;
  const before = { ...row(uid(2)) };

  await rejects(feeService.updateStudentFeeAdjustment({ teacherId: T, feeId: uid(2), discount: 0 }), 409, "FREE_CARD_ACTIVE");
  await rejects(
    feeService.setMonthlyFeeAmount({ teacherId: T, classId: C, year: 2026, month: 12, amount: 2500, applyToAll: false, feeId: uid(2) }),
    409,
    "FREE_CARD_ACTIVE"
  );
  await rejects(feeService.resetLateJoinDeductToAutomatic({ teacherId: T, feeId: uid(2) }), 409, "FREE_CARD_ACTIVE");

  assert.deepEqual({ ...row(uid(2)) }, before);
});

test("normal manual adjustments keep working exactly as before", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s1");
  enrol("e1", "s1");
  fee(uid(1), "e1");

  const updated = await feeService.updateStudentFeeAdjustment({ teacherId: T, feeId: uid(1), discount: 250, waiverAmount: 100 });
  assert.equal(updated.finalAmount, 1650);
  assert.equal(row(uid(1)).discount, 250);
  assert.equal(row(uid(1)).waiverAmount, 100);
  assert.equal(row(uid(1)).finalAmount, 1650);
});

test("repeated issue and revoke requests change nothing the second time", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s1");
  enrol("e1", "s1");
  fee(uid(1), "e1");

  await issue([uid(1)]);
  const afterIssue = { ...row(uid(1)) };
  const again = await issue([uid(1)]);
  assert.deepEqual(again.processed, []);
  assert.deepEqual(again.skipped.map((s) => s.reason), ["ALREADY_FREE_CARD"]);
  assert.deepEqual({ ...row(uid(1)) }, afterIssue);

  await revoke([uid(1)]);
  const afterRevoke = { ...row(uid(1)) };
  const againRevoke = await revoke([uid(1)]);
  assert.deepEqual(againRevoke.processed, []);
  assert.deepEqual(againRevoke.skipped.map((s) => s.reason), ["NO_FREE_CARD"]);
  assert.deepEqual({ ...row(uid(1)) }, afterRevoke);
  assert.equal(row(uid(1)).finalAmount, 2000);
});

test("revoke never touches a fee with a confirmed payment", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s1");
  enrol("e1", "s1");
  // Not reachable through the app (issuing skips paid fees); defensive.
  fee(uid(1), "e1", { freeCard: true, finalAmount: 0, freeCardIssuedAt: new Date(), freeCardIssuedByTeacherId: T });
  pay(uid(1), "CONFIRMED", 0);
  const before = { ...row(uid(1)) };

  const result = await revoke([uid(1)]);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["CONFIRMED_PAYMENT"]);
  assert.deepEqual({ ...row(uid(1)) }, before);
});

test("another teacher cannot issue cards; fees of another class or month are skipped untouched", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s1");
  student("s8");
  student("s9");
  enrol("e1", "s1");
  enrol("e8", "s8", "2026-12-20T10:00", C2);
  enrol("e9", "s9", "2026-12-20T10:00", C3);
  fee(uid(1), "e1");
  fee(uid(10), "e1", { month: 11 });
  fee(uid(8), "e8", { amount: 1500 });
  fee(uid(9), "e9", { amount: 1800 });
  const before = snapshot("ClassStudentFee");

  await rejects(
    feeService.setFreeCards({ teacherId: "teacher-2", classId: C, year: 2026, month: 12, feeIds: [uid(1)], action: "issue" }),
    404,
    "CLASS_NOT_FOUND"
  );
  assert.deepEqual(snapshot("ClassStudentFee"), before);

  const result = await issue([uid(10), uid(8), uid(9), uid(99)]);
  assert.deepEqual(result.processed, []);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["NOT_IN_SHEET", "NOT_IN_SHEET", "NOT_IN_SHEET", "NOT_IN_SHEET"]);
  assert.ok(result.skipped.every((s) => s.studentName === null), "nothing about other classes is revealed");
  assert.deepEqual(snapshot("ClassStudentFee"), before);
});

test("rows are locked FOR UPDATE in id order inside one transaction", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s1");
  student("s2");
  enrol("e1", "s1");
  enrol("e2", "s2");
  fee(uid(1), "e1");
  fee(uid(2), "e2");

  const calls = [];
  const original = db.client.$queryRaw;
  db.client.$queryRaw = async (strings, ...values) => {
    calls.push({ sql: strings.join("?"), values });
    return original(strings, ...values);
  };
  t.after(() => {
    db.client.$queryRaw = original;
  });

  await issue([uid(2), uid(1)]);
  assert.deepEqual(
    calls.map((c) => [c.sql.trim(), c.values[0]]),
    [
      ['SELECT "id" FROM "ClassStudentFee" WHERE "id" = ? FOR UPDATE', uid(1)],
      ['SELECT "id" FROM "ClassStudentFee" WHERE "id" = ? FOR UPDATE', uid(2)],
    ]
  );
});

// ---- Concurrency ----------------------------------------------------------------------

test("a payment landing between the read and the write: the card is not issued", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s1");
  enrol("e1", "s1");
  fee(uid(1), "e1");

  db.hooks.beforeUpdateMany = (model) => {
    if (model === "ClassStudentFee") pay(uid(1), "PENDING");
  };
  const result = await issue([uid(1)]);

  assert.deepEqual(result.processed, []);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["PENDING_PAYMENT"]);
  assert.equal(row(uid(1)).freeCard, false);
  assert.equal(row(uid(1)).finalAmount, 2000);
  assert.equal(db.tables.ClassPayment.length, 1, "the payment is kept");
});

test("a card issued between an automatic read and write is never undone", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s7");
  enrol("e7", "s7");
  fee(uid(7), "e7");

  const cardNow = () => {
    db.touch("ClassStudentFee", uid(7), { freeCard: true, finalAmount: 0, freeCardIssuedAt: new Date(), freeCardIssuedByTeacherId: T });
  };

  // Reprocess (automatic waiver write without an updatedAt guard).
  db.hooks.beforeUpdateMany = (model) => model === "ClassStudentFee" && cardNow();
  await feeService.reprocessMonthlyFees({ teacherId: T, classId: C, year: 2026, month: 12 });
  assert.equal(row(uid(7)).freeCard, true);
  assert.equal(row(uid(7)).finalAmount, 0);

  // Class fee change (apply to all).
  row(uid(7)).freeCard = false;
  row(uid(7)).freeCardIssuedAt = null;
  row(uid(7)).freeCardIssuedByTeacherId = null;
  row(uid(7)).finalAmount = 1200;
  db.hooks.beforeUpdateMany = (model) => model === "ClassStudentFee" && cardNow();
  await feeService.setMonthlyFeeAmount({ teacherId: T, classId: C, year: 2026, month: 12, amount: 3000, applyToAll: true });
  assert.equal(row(uid(7)).freeCard, true);
  assert.equal(row(uid(7)).finalAmount, 0);
});

test("a manual adjustment racing a card: refused, the card and the values win", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s1");
  enrol("e1", "s1");
  fee(uid(1), "e1");

  db.hooks.beforeUpdateMany = (model) => {
    if (model === "ClassStudentFee") {
      db.touch("ClassStudentFee", uid(1), { freeCard: true, finalAmount: 0, freeCardIssuedAt: new Date(), freeCardIssuedByTeacherId: T });
    }
  };
  await rejects(feeService.updateStudentFeeAdjustment({ teacherId: T, feeId: uid(1), discount: 500 }), 409, "FREE_CARD_ACTIVE");
  assert.equal(row(uid(1)).freeCard, true);
  assert.equal(row(uid(1)).discount, 0);
  assert.equal(row(uid(1)).finalAmount, 0);
});

// ---- Bulk route ------------------------------------------------------------------------

const postFreeCards = (body, raw) =>
  freeCardsRoute.POST(
    new Request("http://localhost/api/payments/fees/free-cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(body),
    })
  );

test("route: validates the request and returns processed, skipped and the refreshed sheet", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  sessionTeacherId = T;
  student("s1");
  student("s4");
  enrol("e1", "s1");
  enrol("e4", "s4");
  fee(uid(1), "e1");
  fee(uid(4), "e4");
  pay(uid(4), "PENDING");

  const bad = async (body, raw) => {
    const res = await postFreeCards(body, raw);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
  };
  const base = { classId: C, year: 2026, month: 12, action: "issue", feeIds: [uid(1)] };
  await bad(null, "{not json");
  await bad({ ...base, action: "delete" });
  await bad({ ...base, feeIds: [] });
  await bad({ ...base, feeIds: ["fa"] });
  await bad({ ...base, feeIds: Array.from({ length: 501 }, (_, i) => uid(i + 1)) });
  await bad({ ...base, month: 13 });
  await bad({ ...base, classId: "" });
  assert.equal(row(uid(1)).freeCard, false);

  const res = await postFreeCards({ ...base, feeIds: [uid(1), uid(4), uid(1)] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.message, "1 Free Card issued.");
  assert.deepEqual(body.data.processed.map((p) => p.feeId), [uid(1)], "duplicates collapsed");
  assert.deepEqual(body.data.skipped.map((s) => s.reason), ["PENDING_PAYMENT"]);
  assert.equal(body.data.sheet.rows.find((r) => r.feeId === uid(1)).paymentStatus, "FREE_CARD");

  sessionTeacherId = "teacher-2";
  const other = await postFreeCards({ ...base, action: "revoke" });
  assert.equal(other.status, 404);
  assert.equal(row(uid(1)).freeCard, true);
  sessionTeacherId = T;
});

// ---- Student payment upload --------------------------------------------------------------

function slipRequest(feeId) {
  const form = new FormData();
  form.set("feeId", feeId);
  form.set("slip", new File([Buffer.from("%PDF-1.4 test")], "slip.pdf", { type: "application/pdf" }));
  return new Request("http://localhost/api/student/payments", { method: "POST", body: form });
}

function inTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "free-card-"));
  const previous = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const filesUnder = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((p) => fs.statSync(path.join(dir, p)).isFile()) : [];

test("upload: refused with 409 under an active card, before any file is stored", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const dir = inTempDir(t);
  sessionStudentId = "s1";
  student("s1");
  enrol("e1", "s1");
  fee(uid(1), "e1");
  await issue([uid(1)]);

  const res = await studentPaymentsRoute.POST(slipRequest(uid(1)));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "FREE_CARD_ACTIVE");
  assert.equal(db.tables.ClassPayment.length, 0);
  assert.deepEqual(filesUnder(path.join(dir, "storage")), []);
});

test("upload racing a card: the locked re-check refuses it and the stored slip is removed", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const dir = inTempDir(t);
  sessionStudentId = "s1";
  student("s1");
  enrol("e1", "s1");
  fee(uid(1), "e1");

  const original = db.client.$queryRaw;
  db.client.$queryRaw = async (strings, ...values) => {
    const sql = strings.join("?");
    // The upload's fee-row lock (Stage 2B: lock, then re-read the fee under it).
    if (/SELECT "id" FROM "ClassStudentFee" WHERE "id" = \? FOR UPDATE/.test(sql)) {
      // The card was issued while the slip was being uploaded.
      db.touch("ClassStudentFee", values[0], { freeCard: true, finalAmount: 0, freeCardIssuedAt: new Date(), freeCardIssuedByTeacherId: T });
      return [{ id: values[0] }];
    }
    return original(strings, ...values);
  };
  t.after(() => {
    db.client.$queryRaw = original;
  });

  const res = await studentPaymentsRoute.POST(slipRequest(uid(1)));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "FREE_CARD_ACTIVE");
  assert.equal(db.tables.ClassPayment.length, 0);
  assert.deepEqual(filesUnder(path.join(dir, "storage")), [], "the slip written for this request is deleted");
});

test("normal students: submission and teacher confirmation work as before", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  inTempDir(t);
  sessionStudentId = "s1";
  sessionTeacherId = T;
  student("s1");
  enrol("e1", "s1");
  fee(uid(1), "e1", { lateJoinDeduct: 800, finalAmount: 1200 });

  const res = await studentPaymentsRoute.POST(slipRequest(uid(1)));
  assert.equal(res.status, 201);
  const payment = db.tables.ClassPayment[0];
  assert.equal(payment.status, "PENDING");
  assert.equal(payment.amount, 1200);
  assert.equal(payment.classStudentFeeId, uid(1));

  const confirm = await confirmRoute.POST(
    new Request(`http://localhost/api/classes/${C}/payments/${payment.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "CONFIRMED" }),
    }),
    { params: { id: C, paymentId: payment.id } }
  );
  assert.equal(confirm.status, 200);
  assert.equal(db.tables.ClassPayment[0].status, "CONFIRMED");

  // And a card can no longer be issued for it.
  const result = await issue([uid(1)]);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["CONFIRMED_PAYMENT"]);
});

// ---- Student and guardian views --------------------------------------------------------

function viewsFixture() {
  seed();
  sessionStudentId = "s1";
  student("s1");
  enrol("e1", "s1", "2026-12-01T10:00");
  enrol("e2", "s1", "2026-12-01T10:00", C2);
  fee(uid(1), "e1", { freeCard: true, finalAmount: 0, freeCardIssuedAt: new Date(), freeCardIssuedByTeacherId: T });
  fee(uid(2), "e2", { amount: 1500, finalAmount: 1500 });
}

test("student payments list: the card is settled (FREE_CARD, Rs. 0) and never in To pay", async (t) => {
  viewsFixture();
  at(t, "2026-12-21T09:00");

  const res = await studentPaymentsRoute.GET(new Request("http://localhost/api/student/payments"));
  const { data } = await res.json();
  assert.deepEqual(data.toPay.map((i) => i.feeId), [uid(2)]);
  assert.deepEqual(data.paid.map((i) => i.feeId), [uid(1)]);
  assert.equal(data.paid[0].state, "FREE_CARD");
  assert.equal(data.paid[0].finalAmount, 0);
  assert.equal(data.paid[0].freeCard, true);
  assert.equal(data.toPay[0].state, "UNPAID", "a normal fee is unchanged");
});

test("student dashboard: the card is neither due, due soon, counted nor counted down", async (t) => {
  viewsFixture();

  at(t, "2026-12-29T09:00"); // past the 28 Dec due date
  const res = await studentDashboardPaymentsRoute.GET(new Request("http://localhost/api/student/dashboard/payments"));
  const { data } = await res.json();
  assert.deepEqual(data.due.map((f) => f.feeId), [uid(2)]);
  assert.equal(data.dueTotal, 1500);

  const counts = await countsService.getStudentDashboardCounts("s1", "month");
  assert.equal(counts.payments.due, 1, "only the normal overdue fee");
  assert.equal(counts.payments.dueSoon, 0);

  t.mock.timers.reset();
  at(t, "2026-12-29T00:00"); // 28 Dec 23:59 due date within the 8-hour countdown window
  const countsSoon = await countsService.getStudentDashboardCounts("s1", "month");
  assert.equal(countsSoon.payments.dueSoon, 1);
  const countdowns = await countdownService.getStudentUpcomingCountdowns("s1");
  assert.deepEqual(
    countdowns.filter((c) => c.kind === "PAYMENT").map((c) => c.id),
    [`payment-${uid(2)}`],
    "no countdown for the Free Card fee"
  );
});

test("guardian / profile summary: the card counts as settled at Rs. 0", async (t) => {
  viewsFixture();
  at(t, "2026-12-21T09:00");

  const data = await studentService.getStudentPaymentSummary("s1");
  assert.equal(data.summary.paidCount, 1);
  assert.equal(data.summary.unpaidCount, 1);
  assert.equal(data.summary.paidAmount, 0);
  assert.equal(data.summary.unpaidAmount, 1500);
  const fees = data.classes.flatMap((c) => c.fees);
  const card = fees.find((f) => f.id === uid(1));
  assert.equal(card.paid, true);
  assert.equal(card.freeCard, true);
  assert.equal(fees.find((f) => f.id === uid(2)).freeCard, false);
});

// ---- Teacher dashboard: Free Cards by active enrolment ------------------------------------

test("dashboard: a card on a removed enrolment never hides the payable fee of a re-enrolment", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s1"); // re-enrolled: card on the old enrolment, new enrolment payable
  student("s2"); // card on the active enrolment
  student("s3"); // normal student
  student("s9"); // another teacher's class
  db.insert("ClassStudent", {
    id: "e1-old",
    classId: C,
    studentId: "s1",
    isActive: false,
    assignedAt: digits("2026-12-01T10:00"),
    removedAt: digits("2026-12-10T10:00"),
  });
  enrol("e1-new", "s1", "2026-12-15T10:00");
  enrol("e2", "s2");
  enrol("e3", "s3");
  enrol("e9", "s9", "2026-12-20T10:00", C3);
  const card = { freeCard: true, finalAmount: 0, freeCardIssuedAt: new Date(), freeCardIssuedByTeacherId: T };
  fee(uid(1), "e1-old", card);
  fee(uid(11), "e1-new");
  fee(uid(2), "e2", card);
  fee(uid(3), "e3");
  fee(uid(9), "e9", { ...card, freeCardIssuedByTeacherId: "teacher-2" });
  fee(uid(20), "e2", { ...card, month: 11 }); // another month

  const ids = await feeService.getFreeCardEnrolmentIds({ teacherId: T, year: 2026, month: 12 });
  assert.deepEqual([...ids].sort(), ["e2"], "only the active enrolment whose own fee has a card");
  assert.ok(!ids.has("e1-new"), "the re-enrolled student stays due");
  assert.ok(!ids.has("e3"), "a normal student stays due");

  const other = await feeService.getFreeCardEnrolmentIds({ teacherId: "teacher-2", year: 2026, month: 12 });
  assert.deepEqual([...other], ["e9"]);

  // The dashboard filters its due list by the enrolment id with this helper.
  const page = fs.readFileSync(path.join(root, "app", "dashboard", "page.tsx"), "utf8");
  assert.match(page, /await getFreeCardEnrolmentIds\(\{ teacherId: teacher\.id, year: currentYearNum, month: currentMonthNum \}\)/);
  assert.match(page, /\.filter\(\(e\) => !freeCardEnrolmentIds\.has\(e\.id\)\)/);
  assert.match(page, /where: \{ isActive: true, student: \{ status: 0 \} \},\s*select: \{\s*\/\/[^\n]*\n\s*id: true,/);
  assert.doesNotMatch(page, /freeCardKeys/);
});

test("student classes (teacher / guardian view): each enrolment lists its own Free Card months", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  student("s1");
  db.insert("ClassStudent", {
    id: "e1-old",
    classId: C,
    studentId: "s1",
    isActive: false,
    assignedAt: digits("2026-11-01T10:00"),
    removedAt: digits("2026-12-10T10:00"),
  });
  enrol("e1-new", "s1", "2026-12-15T10:00");
  const card = { freeCard: true, finalAmount: 0, freeCardIssuedAt: new Date(), freeCardIssuedByTeacherId: T };
  fee(uid(1), "e1-old", { ...card, month: 11 });
  fee(uid(2), "e1-old", card);
  fee(uid(3), "e1-new");

  const rows = await studentService.getStudentClassesForTeacher("s1");
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.deepEqual(
    byId.get("e1-old").fees.map((f) => [f.id, f.year, f.month]),
    [
      [uid(2), 2026, 12],
      [uid(1), 2026, 11],
    ],
    "newest first"
  );
  assert.deepEqual(byId.get("e1-new").fees, [], "a payable fee is not listed as a Free Card");
});

// ---- Legacy class payment summary (GET /api/classes/[id]/payments) -----------------------

const legacyPaymentsRoute = require(path.join(root, "app", "api", "classes", "[id]", "payments", "route.ts"));

test("studentsSettledByFreeCards: settled only when every overlapping enrolment carries a card", () => {
  const { studentsSettledByFreeCards } = feeService;
  const enrolments = [
    { id: "a", studentId: "s1" }, // card
    { id: "b-old", studentId: "s2" }, // card on the old enrolment
    { id: "b-new", studentId: "s2" }, // payable re-enrolment
    { id: "c1", studentId: "s3" }, // card on both enrolments
    { id: "c2", studentId: "s3" },
    { id: "d", studentId: "s4" }, // no card
  ];
  const settled = studentsSettledByFreeCards(enrolments, new Set(["a", "b-old", "c1", "c2", "zz"]));
  assert.deepEqual([...settled].sort(), ["s1", "s3"]);
  assert.deepEqual([...studentsSettledByFreeCards([], new Set(["a"]))], []);
  assert.deepEqual([...studentsSettledByFreeCards(enrolments, new Set())], []);
});

test("legacy summary: Free Card rows are not defaulters; unpaid, pending, clarification and re-enrolments unchanged", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  sessionTeacherId = T;
  for (const id of ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]) student(id);
  const card = { freeCard: true, finalAmount: 0, freeCardIssuedAt: new Date(), freeCardIssuedByTeacherId: T };

  enrol("e1", "s1", "2026-12-01T10:00");
  fee(uid(1), "e1", card); // Free Card: settled
  enrol("e2", "s2", "2026-12-01T10:00");
  fee(uid(2), "e2"); // normal unpaid: defaulter
  fee(uid(20), "e2", { ...card, month: 11 }); // a card in another month changes nothing
  enrol("e3", "s3", "2026-12-01T10:00");
  fee(uid(3), "e3");
  pay(uid(3), "PENDING", 2000, "s3");
  enrol("e4", "s4", "2026-12-01T10:00");
  fee(uid(4), "e4");
  pay(uid(4), "NEEDS_CLARIFICATION", 2000, "s4");
  enrol("e5", "s5", "2026-12-01T10:00");
  fee(uid(5), "e5");
  pay(uid(5), "CONFIRMED", 2000, "s5"); // paid in full (a partial payment is not settled: see partial-payment-2a.test.cjs)
  // Re-enrolled: card on the removed enrolment, the new one is payable.
  db.insert("ClassStudent", {
    id: "e6-old",
    classId: C,
    studentId: "s6",
    isActive: false,
    assignedAt: digits("2026-12-01T10:00"),
    removedAt: digits("2026-12-10T10:00"),
  });
  fee(uid(6), "e6-old", card);
  enrol("e6-new", "s6", "2026-12-15T10:00");
  fee(uid(16), "e6-new");
  // Another class of the same teacher: its card and its unpaid student never appear here.
  enrol("e7", "s7", "2026-12-01T10:00", C2);
  fee(uid(7), "e7", { ...card, amount: 1500 });
  enrol("e8", "s8", "2026-12-01T10:00", C2);
  fee(uid(8), "e8", { amount: 1500, finalAmount: 1500 });

  const get = async (classId, month) => {
    const res = await legacyPaymentsRoute.GET(
      new Request(`http://localhost/api/classes/${classId}/payments?month=${month}`),
      { params: { id: classId } }
    );
    assert.equal(res.status, 200);
    return (await res.json()).data;
  };

  const data = await get(C, "2026-12");
  assert.deepEqual(data.defaulters.map((s) => s.id).sort(), ["s2", "s6"]);
  assert.equal(data.summary.defaulterCount, 2);
  assert.equal(data.summary.freeCardCount, 1);
  // Unchanged payment handling.
  assert.equal(data.summary.enrolledCount, 6);
  assert.equal(data.summary.submittedCount, 3);
  assert.equal(data.summary.pendingCount, 1);
  assert.equal(data.summary.clarificationCount, 1);
  assert.equal(data.summary.confirmedCount, 1);
  assert.equal(data.summary.submittedAmount, 6000);
  assert.equal(data.summary.confirmedAmount, 2000);
  assert.equal(data.summary.expectedAmount, 6 * 2000, "legacy expected amount unchanged");
  assert.deepEqual(data.payments.map((p) => p.student.id).sort(), ["s3", "s4", "s5"]);

  const other = await get(C2, "2026-12");
  assert.deepEqual(other.defaulters.map((s) => s.id), ["s8"]);
  assert.equal(other.summary.freeCardCount, 1);
  assert.equal(other.summary.submittedCount, 0);

  // November: only s2 has a (carded) November fee row; others were not enrolled yet.
  const november = await get(C, "2026-11");
  assert.deepEqual(november.defaulters, []);
  assert.equal(november.summary.enrolledCount, 0);
});

test("legacy summary: a student with no Free Card anywhere is listed exactly as before", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  sessionTeacherId = T;
  student("s1");
  enrol("e1", "s1", "2026-12-01T10:00");
  fee(uid(1), "e1");

  const res = await legacyPaymentsRoute.GET(new Request(`http://localhost/api/classes/${C}/payments?month=2026-12`), {
    params: { id: C },
  });
  const { data } = await res.json();
  assert.deepEqual(data.defaulters.map((s) => s.id), ["s1"]);
  assert.equal(data.summary.freeCardCount, 0);

  // Once the card is issued through the real service, the student is settled.
  await issue([uid(1)]);
  const after = await (
    await legacyPaymentsRoute.GET(new Request(`http://localhost/api/classes/${C}/payments?month=2026-12`), { params: { id: C } })
  ).json();
  assert.deepEqual(after.data.defaulters, []);
  assert.equal(after.data.summary.freeCardCount, 1);
});
