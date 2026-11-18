/*
 * QR attendance payment warning, Stage 1: GET /api/classes/[id]/outstanding-students
 * and getOutstandingStudentIdsForClass (services/class-access-service.ts).
 * The unique ids of the class's students who still owe money on any fee
 * month of an active enrolment (non-deleted students), by the shared payment
 * calculation (lib/fee-payment-state.ts); awaiting slips never make a student
 * outstanding by themselves. Real service and route, in-memory database
 * (tests/fee-waiver/helpers/fake-db.cjs). No network, no email.
 *
 *   npm run test:class-access
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { createFakeDb } = require("../fee-waiver/helpers/fake-db.cjs");

const db = createFakeDb();

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

const { AppError } = require(path.join(root, "lib", "error-handler.ts"));

/** null: no signed-in teacher (requireTeacherSession throws its 401). */
let sessionTeacherId = "teacher-1";
fake("lib/prisma.ts", { prisma: db.client });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    if (sessionTeacherId === null) throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    return { role: "TEACHER", teacherId: sessionTeacherId };
  },
  requireStudentSession: async () => {
    throw new Error("not used");
  },
  requireAppSession: async () => {
    throw new Error("not used");
  },
  getOptionalSession: async () => null,
  requireAdminSession: async () => {
    throw new Error("not used");
  },
});

const access = require(path.join(root, "services", "class-access-service.ts"));
const route = require(path.join(root, "app", "api", "classes", "[id]", "outstanding-students", "route.ts"));

const T = "teacher-1";
const A = "class-a";
const B = "class-b";

function seed() {
  db.reset();
  sessionTeacherId = T;
  const cls = (id, teacherId = T, status = 0) =>
    db.insert("Class", { id, teacherId, status, name: id, monthlyFee: 2000, paymentDueWeek: 2, schedule: "TBD", restrictUnpaidStudentAccess: false, paymentGracePeriodDays: 5 });
  cls(A);
  cls(B);
  cls("class-other", "teacher-2");
  cls("class-deleted", T, 1);
}

let seq = 0;
function student(id, status = 0) {
  db.insert("Student", { id, name: `Name of ${id}`, teacherId: T, status });
}
function enrol(id, studentId, classId = A, isActive = true) {
  db.insert("ClassStudent", { id, classId, studentId, isActive, assignedAt: new Date(Date.UTC(2026, 0, 1)), removedAt: isActive ? null : new Date(Date.UTC(2026, 5, 1)) });
}
function fee(classStudentId, over = {}) {
  seq += 1;
  const amount = over.amount ?? 2000;
  const freeCard = over.freeCard ?? false;
  return db.insert("ClassStudentFee", {
    id: `fee-${seq}`,
    classStudentId,
    year: 2026,
    month: 11,
    amount,
    discount: 0,
    lateJoinDeduct: 0,
    waiverAmount: 0,
    finalAmount: freeCard ? 0 : amount,
    freeCard,
    dueDate: new Date(Date.UTC(2026, 10, 10, 23, 59, 59, 999)),
    status: 0,
    ...over,
  });
}
function pay(feeRow, amount, status = "CONFIRMED") {
  seq += 1;
  const classStudent = db.row("ClassStudent", feeRow.classStudentId);
  return db.insert("ClassPayment", {
    id: `pay-${seq}`,
    classStudentFeeId: feeRow.id,
    classId: classStudent.classId,
    studentId: classStudent.studentId,
    amount,
    status,
    submittedAt: new Date(),
  });
}
function reverse(payment) {
  seq += 1;
  return db.insert("ClassPaymentReversal", { id: `rev-${seq}`, paymentId: payment.id, amount: payment.amount, reason: "Bounced", reversedAt: new Date() });
}
/** One student, one active enrolment in class A. */
function one(id) {
  student(id);
  enrol(`e-${id}`, id);
  return `e-${id}`;
}

const req = () => new Request(`http://localhost/api/classes/${A}/outstanding-students`, { method: "GET" });
async function call(classId = A) {
  const res = await route.GET(req(), { params: { id: classId } });
  return { res, body: await res.json() };
}
const outstanding = (classId = A) => access.getOutstandingStudentIdsForClass(T, classId);

// ---- The rule -----------------------------------------------------------------------------------

test("unpaid fee: outstanding; fully paid fee: not", async () => {
  seed();
  fee(one("unpaid"));
  pay(fee(one("paid")), 2000);
  assert.deepEqual(await outstanding(), ["unpaid"]);
});

test("partial payment: outstanding only while a balance remains", async () => {
  seed();
  pay(fee(one("partial")), 500);
  const settled = fee(one("settled"));
  pay(settled, 500);
  pay(settled, 1500);
  assert.deepEqual(await outstanding(), ["partial"]);
});

test("a pending slip covering the whole balance does not make the student outstanding", async () => {
  seed();
  pay(fee(one("pending")), 2000, "PENDING");
  assert.deepEqual(await outstanding(), []);
});

test("partial payment plus a pending slip for the rest: not outstanding; a pending slip short of the balance: still outstanding", async () => {
  seed();
  const covered = fee(one("covered"));
  pay(covered, 500);
  pay(covered, 1500, "PENDING");
  // The fee rose after the slip (e.g. a discount removed): 500 is still unpaid and uncovered.
  const short = fee(one("short"), { amount: 2500 });
  pay(short, 500);
  pay(short, 1500, "PENDING");
  assert.deepEqual(await outstanding(), ["short"]);
});

test("NEEDS_CLARIFICATION slip: covers its amount, is never received money", async () => {
  seed();
  pay(fee(one("clarify")), 2000, "NEEDS_CLARIFICATION");
  const shortFee = fee(one("clarify-short"));
  pay(shortFee, 1000, "NEEDS_CLARIFICATION");
  assert.deepEqual(await outstanding(), ["clarify-short"]);
});

test("a slip on one month never covers another unpaid month of the same student", async () => {
  seed();
  const e = one("two-months");
  pay(fee(e, { month: 11 }), 2000, "PENDING");
  fee(e, { month: 10 });
  assert.deepEqual(await outstanding(), ["two-months"]);
});

test("a reversed payment restores the balance (fully or partly)", async () => {
  seed();
  reverse(pay(fee(one("reversed")), 2000));
  const partly = fee(one("partly-reversed"));
  pay(partly, 1500);
  reverse(pay(partly, 500));
  const replaced = fee(one("reversed-then-paid"));
  reverse(pay(replaced, 2000));
  pay(replaced, 2000);
  assert.deepEqual(await outstanding(), ["partly-reversed", "reversed"]);
});

test("Free Card fee: never outstanding", async () => {
  seed();
  fee(one("free"), { freeCard: true, freeCardIssuedAt: new Date(), freeCardIssuedByTeacherId: T });
  fee(one("zero"), { amount: 2000, finalAmount: 0 });
  assert.deepEqual(await outstanding(), []);
});

test("all existing fee months count, not only the current month; any balance regardless of due date", async () => {
  seed();
  const e = one("history");
  pay(fee(e, { month: 11 }), 2000);
  fee(e, { year: 2026, month: 3, dueDate: new Date(Date.UTC(2026, 2, 10, 23, 59, 59, 999)) });
  const notDue = one("not-due");
  fee(notDue, { month: 12, dueDate: new Date(Date.UTC(2099, 0, 1)) });
  const noDue = one("no-due-date");
  fee(noDue, { dueDate: null });
  assert.deepEqual(await outstanding(), ["history", "no-due-date", "not-due"]);
});

test("multiple fee rows of the same student: one id; another class's fees are ignored", async () => {
  seed();
  const e = one("many");
  fee(e, { month: 9 });
  fee(e, { month: 10 });
  pay(fee(e, { month: 11 }), 300);
  student("b-only");
  enrol("e-b-only", "b-only", B);
  fee("e-b-only");
  assert.deepEqual(await outstanding(), ["many"]);
  assert.deepEqual(await outstanding(B), ["b-only"]);
});

test("inactive enrolment: its fees never count (an active re-enrolment's fees do)", async () => {
  seed();
  student("left");
  enrol("e-left-old", "left", A, false);
  fee("e-left-old");
  student("back");
  enrol("e-back-old", "back", A, false);
  fee("e-back-old", { month: 6 });
  enrol("e-back-new", "back", A, true);
  fee("e-back-new", { month: 11 });
  student("back-paid");
  enrol("e-bp-old", "back-paid", A, false);
  fee("e-bp-old", { month: 6 });
  enrol("e-bp-new", "back-paid", A, true);
  pay(fee("e-bp-new", { month: 11 }), 2000);
  assert.deepEqual(await outstanding(), ["back"]);
});

test("deleted students (status 1 and 2) are excluded", async () => {
  seed();
  for (const [id, status] of [["deleted", 1], ["purged", 2]]) {
    student(id, status);
    enrol(`e-${id}`, id);
    fee(`e-${id}`);
  }
  fee(one("kept"));
  assert.deepEqual(await outstanding(), ["kept"]);
});

// ---- The API -----------------------------------------------------------------------------------

test("GET: 200 with only unique student ids, no-store, nothing written", async () => {
  seed();
  const e = one("s1");
  fee(e, { month: 10 });
  fee(e, { month: 11 });
  pay(fee(one("s2")), 100);
  pay(fee(one("s3")), 2000);
  const before = db.writes.length;

  const { res, body } = await call();
  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(Object.keys(body.data), ["studentIds"], "ids only: no amounts, names or history");
  assert.deepEqual(body.data.studentIds, ["s1", "s2"]);
  assert.equal(new Set(body.data.studentIds).size, body.data.studentIds.length, "unique");
  assert.ok(body.data.studentIds.every((id) => typeof id === "string"));
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(db.writes.length, before, "read-only");
  assert.equal(db.tables.ClassStudentFee.length, 4, "no fee rows created");
});

test("GET: an empty class answers an empty list", async () => {
  seed();
  const { res, body } = await call(B);
  assert.equal(res.status, 200);
  assert.deepEqual(body.data, { studentIds: [] });
});

test("GET: another teacher's class, a deleted class or an unknown id: 404 CLASS_NOT_FOUND, no ids", async () => {
  seed();
  student("x");
  enrol("e-x", "x", "class-other");
  fee("e-x");
  for (const id of ["class-other", "class-deleted", "missing", ""]) {
    const { res, body } = await call(id);
    assert.equal(res.status, 404, id);
    assert.equal(body.code ?? body.error?.code, "CLASS_NOT_FOUND", id);
    assert.ok(!JSON.stringify(body).includes("\"x\""), "no ids leaked");
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  }
  sessionTeacherId = "teacher-2";
  const { res } = await call(A);
  assert.equal(res.status, 404, "class A is not teacher-2's");
});

test("GET: no teacher session: 401, no ids", async () => {
  seed();
  fee(one("s1"));
  sessionTeacherId = null;
  const { res, body } = await call();
  assert.equal(res.status, 401);
  assert.equal(body.code ?? body.error?.code, "UNAUTHORIZED");
  assert.ok(!JSON.stringify(body).includes("s1"));
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  sessionTeacherId = T;
});

test("feeOwesBeyondAwaitingSlips: only an uncovered positive balance counts", () => {
  const f = access.feeOwesBeyondAwaitingSlips;
  assert.equal(f({ outstanding: 0, pendingTotal: 0, clarificationTotal: 0 }), false);
  assert.equal(f({ outstanding: 1, pendingTotal: 0, clarificationTotal: 0 }), true);
  assert.equal(f({ outstanding: 2000, pendingTotal: 2000, clarificationTotal: 0 }), false);
  assert.equal(f({ outstanding: 2000, pendingTotal: 0, clarificationTotal: 2000 }), false);
  assert.equal(f({ outstanding: 2500, pendingTotal: 2000, clarificationTotal: 0 }), true);
  assert.equal(f({ outstanding: 0, pendingTotal: 2000, clarificationTotal: 0 }), false);
});
