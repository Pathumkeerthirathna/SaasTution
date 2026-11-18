/*
 * Partial payments, Stage 2B: the payment APIs.
 *   - POST /api/classes/[id]/fees/[feeId]/payments        teacher-recorded payment
 *   - POST /api/classes/[id]/payments/[paymentId]/reversal teacher reversal
 *   - POST /api/admin/payments/[paymentId]/reversal        admin reversal
 *   - POST /api/classes/[id]/payments/[paymentId]/confirm  never beyond the outstanding balance
 *   - POST /api/student/payments                           slip for the remaining balance
 * Real services and routes, in-memory database (./helpers/fake-db.cjs).
 * No network, no email.
 *
 *   npm run test:fee-waiver
 *
 * Class C (teacher T, fee Rs. 2,500), one student per fee:
 *   FEE(1) s1  unpaid
 *   FEE(2) s2  PENDING slip 2,500
 *   FEE(3) s3  NEEDS_CLARIFICATION slip 2,500
 *   FEE(4) s4  Free Card
 *   FEE(6) s6  unpaid (spare)
 * Class C2 (teacher T2): FEE(5) s5 unpaid.
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
const empty = { count: async () => 0, findMany: async () => [], findFirst: async () => null, findUnique: async () => null };
const client = new Proxy(db.client, { get: (target, prop) => (prop in target ? target[prop] : empty) });

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

const T = "teacher-1";
const T2 = "teacher-2";
const ADMIN = "admin-1";
let sessionTeacherId = T;
let sessionStudentId = "s1";
fake("lib/prisma.ts", { prisma: client });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => ({ role: "TEACHER", teacherId: sessionTeacherId }),
  requireStudentSession: async () => ({ role: "STUDENT", studentId: sessionStudentId }),
  requireAppSession: async () => ({ role: "TEACHER", teacherId: sessionTeacherId }),
  getOptionalSession: async () => null,
  requireAdminSession: async () => ({ adminId: ADMIN, email: "admin@example.test", name: "Admin", role: "ADMIN" }),
});

const fees = require(path.join(root, "services", "class-student-fee-service.ts"));
const recordRoute = require(path.join(root, "app", "api", "classes", "[id]", "fees", "[feeId]", "payments", "route.ts"));
const reversalRoute = require(path.join(root, "app", "api", "classes", "[id]", "payments", "[paymentId]", "reversal", "route.ts"));
const adminReversalRoute = require(path.join(root, "app", "api", "admin", "payments", "[paymentId]", "reversal", "route.ts"));
const confirmRoute = require(path.join(root, "app", "api", "classes", "[id]", "payments", "[paymentId]", "confirm", "route.ts"));
const studentPaymentsRoute = require(path.join(root, "app", "api", "student", "payments", "route.ts"));

const C = "class-1";
const C2 = "class-2";
const sl = (wall) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60 * 1000);
const at = (t, wall) => t.mock.timers.enable({ apis: ["Date"], now: sl(wall) });
const DUE = new Date(Date.UTC(2026, 11, 14, 23, 59, 59, 999));
const FEE = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function seed() {
  db.reset();
  db.insert("FeeWaiverSettings", { id: "default", startYear: 2027, startMonth: 1 });
  db.insert("Class", { id: C, teacherId: T, status: 0, name: "Maths", monthlyFee: 2500, paymentDueWeek: 2, schedule: "TBD", teacher: { name: "Teacher" } });
  db.insert("Class", { id: C2, teacherId: T2, status: 0, name: "Physics", monthlyFee: 2500, paymentDueWeek: 2, schedule: "TBD", teacher: { name: "Other" } });
  const cases = {
    1: { classId: C },
    2: { classId: C, slip: "PENDING" },
    3: { classId: C, slip: "NEEDS_CLARIFICATION" },
    4: { classId: C, fee: { freeCard: true, finalAmount: 0, freeCardIssuedAt: new Date(), freeCardIssuedByTeacherId: T } },
    5: { classId: C2, teacherId: T2 },
    6: { classId: C },
  };
  for (const [n, spec] of Object.entries(cases)) {
    const s = `s${n}`;
    db.insert("Student", { id: s, name: s, teacherId: spec.teacherId ?? T, status: 0, registrationNumber: s.toUpperCase(), registrationSource: "TEACHER", confirmationStatus: "APPROVED", approvedAt: null, confirmedAt: null });
    db.insert("ClassStudent", { id: `e${n}`, classId: spec.classId, studentId: s, isActive: true, assignedAt: new Date("2026-11-01T10:00:00.000Z"), removedAt: null });
    db.insert("ClassStudentFee", {
      id: FEE(n), classStudentId: `e${n}`, year: 2026, month: 12, amount: 2500, discount: 0, lateJoinDeduct: 0, waiverAmount: 0,
      finalAmount: 2500, dueDate: DUE, status: 0, ...(spec.fee ?? {}),
    });
    if (spec.slip) {
      db.insert("ClassPayment", {
        id: `slip-${n}`, classStudentFeeId: FEE(n), classId: spec.classId, studentId: s, amount: 2500, status: spec.slip,
        slipFileUrl: null, submittedAt: new Date(Date.UTC(2026, 11, 10)),
      });
    }
  }
}

let keyCounter = 0;
const key = () => `request-key-${String(++keyCounter).padStart(4, "0")}`;
const body = (over = {}) => ({ amount: 1000, paymentMethod: "CASH", receivedAt: "2026-12-20T09:00:00.000Z", note: "Paid at class", requestKey: key(), ...over });

async function record(feeId, payload, classId = C) {
  const res = await recordRoute.POST(
    new Request(`http://localhost/api/classes/${classId}/fees/${feeId}/payments`, { method: "POST", body: JSON.stringify(payload) }),
    { params: { id: classId, feeId } }
  );
  return { status: res.status, json: await res.json() };
}

async function reverse(paymentId, reason = "Recorded on the wrong student", classId = C) {
  const res = await reversalRoute.POST(
    new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ reason }) }),
    { params: { id: classId, paymentId } }
  );
  return { status: res.status, json: await res.json() };
}

async function adminReverse(paymentId, reason = "Duplicate entry") {
  const res = await adminReversalRoute.POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ reason }) }), { params: { paymentId } });
  return { status: res.status, json: await res.json() };
}

async function confirm(paymentId, payload = { status: "CONFIRMED" }) {
  const res = await confirmRoute.POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(payload) }), { params: { id: C, paymentId } });
  return { status: res.status, json: await res.json() };
}

function slipRequest(feeId) {
  const form = new FormData();
  form.set("feeId", feeId);
  form.set("slip", new File([Buffer.from("%PDF-1.4 test")], "slip.pdf", { type: "application/pdf" }));
  return new Request("http://localhost/api/student/payments", { method: "POST", body: form });
}

function inTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partial-2b-"));
  const previous = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Replaces the fee-row lock SELECT for one test (concurrency / lock timeout). */
function onFeeLock(t, fn) {
  const original = db.client.$queryRaw;
  db.client.$queryRaw = async (strings, ...values) => {
    const sql = strings.join("?");
    if (/SELECT "id" FROM "ClassStudentFee" WHERE "id" = \? FOR UPDATE/.test(sql)) return fn(values[0]);
    return original(strings, ...values);
  };
  t.after(() => {
    db.client.$queryRaw = original;
  });
}

const paymentsOf = (n) => db.tables.ClassPayment.filter((p) => p.classStudentFeeId === FEE(n));
const feeAmounts = (n) => {
  const r = db.row("ClassStudentFee", FEE(n));
  return { amount: r.amount, discount: r.discount, lateJoinDeduct: r.lateJoinDeduct, waiverAmount: r.waiverAmount, finalAmount: r.finalAmount, freeCard: r.freeCard };
};

// ---- Recording ---------------------------------------------------------------------------

test("record: invalid input is a 400 and writes nothing", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const invalid = [
    { amount: 0 },
    { amount: -500 },
    { amount: 10.5 },
    { amount: "1000" },
    { paymentMethod: "CHEQUE" },
    { paymentMethod: undefined },
    { receivedAt: undefined },
    { receivedAt: "not a date" },
    { receivedAt: "2026-12-30T09:00:00.000Z" }, // in the future
    { note: "x".repeat(501) },
    { requestKey: "short" },
    { requestKey: "has spaces in it" },
    { requestKey: undefined },
  ];
  for (const over of invalid) {
    const res = await record(FEE(1), body(over));
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.equal(res.json.error.code, "VALIDATION_ERROR");
  }
  const bad = await recordRoute.POST(new Request("http://localhost/x", { method: "POST", body: "{not json" }), { params: { id: C, feeId: FEE(1) } });
  assert.equal(bad.status, 400);
  assert.equal(db.tables.ClassPayment.filter((p) => p.source === "TEACHER_RECORDED").length, 0);
});

test("record: a partial payment, then the rest; nothing beyond the outstanding balance", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const before = feeAmounts(1);

  const first = await record(FEE(1), body({ amount: 1000, paymentMethod: "BANK_TRANSFER", note: "  Deposit slip 42  " }));
  assert.equal(first.status, 201);
  assert.equal(first.json.data.replayed, false);
  assert.equal(first.json.data.feePayment.state, "PARTIAL");
  assert.equal(first.json.data.feePayment.confirmedTotal, 1000);
  assert.equal(first.json.data.feePayment.outstanding, 1500);

  const stored = db.row("ClassPayment", first.json.data.payment.id);
  assert.equal(stored.status, "CONFIRMED");
  assert.equal(stored.source, "TEACHER_RECORDED");
  assert.equal(stored.paymentMethod, "BANK_TRANSFER");
  assert.equal(stored.recordedByTeacherId, T);
  assert.equal(stored.confirmedByTeacherId, T);
  assert.equal(stored.note, "Deposit slip 42");
  assert.equal(stored.receivedAt.toISOString(), "2026-12-20T09:00:00.000Z");
  assert.equal(stored.classId, C);
  assert.equal(stored.studentId, "s1");
  assert.equal(stored.slipFileUrl ?? null, null);

  const over = await record(FEE(1), body({ amount: 1501 }));
  assert.equal(over.status, 409);
  assert.equal(over.json.error.code, "AMOUNT_EXCEEDS_OUTSTANDING");
  assert.equal(over.json.error.details.outstanding, 1500);

  const second = await record(FEE(1), body({ amount: 500, paymentMethod: "OTHER" }));
  assert.equal(second.status, 201);
  assert.equal(second.json.data.feePayment.outstanding, 1000);
  const rest = await record(FEE(1), body({ amount: 1000 }));
  assert.equal(rest.status, 201);
  assert.equal(rest.json.data.feePayment.state, "PAID");
  assert.equal(rest.json.data.feePayment.outstanding, 0);

  const settled = await record(FEE(1), body({ amount: 1 }));
  assert.equal(settled.status, 409);
  assert.equal(settled.json.error.code, "FEE_ALREADY_SETTLED");

  assert.equal(paymentsOf(1).length, 3);
  assert.deepEqual(feeAmounts(1), before, "fee amounts, discount, waiver untouched");
  assert.equal(db.row("ClassStudentFee", FEE(1)).status, 0, "recording leaves the fee status to Reprocess, as before");

  const sheet = await fees.getMonthlyFeeSheet({ teacherId: T, classId: C, year: 2026, month: 12 });
  const row = sheet.rows.find((r) => r.feeId === FEE(1));
  assert.equal(row.paymentStatus, "PAID");
  assert.equal(row.paymentSummary.confirmedTotal, 2500);
});

test("record: an overpayment on a fresh fee is refused", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const res = await record(FEE(1), body({ amount: 2600 }));
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "AMOUNT_EXCEEDS_OUTSTANDING");
  assert.equal(res.json.error.details.outstanding, 2500);
  assert.equal(db.tables.ClassPayment.filter((p) => p.source === "TEACHER_RECORDED").length, 0);
});

test("record: wrong teacher, wrong class and unknown fee are 404s", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  sessionTeacherId = T2;
  t.after(() => {
    sessionTeacherId = T;
  });
  const otherTeacher = await record(FEE(1), body());
  assert.equal(otherTeacher.status, 404, "another teacher cannot record in this class");

  sessionTeacherId = T;
  const otherClassFee = await record(FEE(5), body()); // C2's fee through C's route
  assert.equal(otherClassFee.status, 404);
  assert.equal(otherClassFee.json.error.code, "FEE_NOT_FOUND");
  const notMyClass = await record(FEE(5), body(), C2);
  assert.equal(notMyClass.status, 404);
  const unknown = await record(FEE(99), body());
  assert.equal(unknown.status, 404);
  assert.equal(db.tables.ClassPayment.filter((p) => p.source === "TEACHER_RECORDED").length, 0);
});

test("record: a slip awaiting review blocks recording (409) and is left as it was; Free Card refuses", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  for (const [n, slip] of [[2, "slip-2"], [3, "slip-3"]]) {
    const before = { ...db.row("ClassPayment", slip) };
    const res = await record(FEE(n), body());
    assert.equal(res.status, 409, `fee ${n}`);
    assert.equal(res.json.error.code, "SUBMISSION_AWAITING");
    assert.deepEqual(db.row("ClassPayment", slip), before, "the submission is not modified");
    assert.equal(paymentsOf(n).length, 1);
  }
  const card = await record(FEE(4), body());
  assert.equal(card.status, 409);
  assert.equal(card.json.error.code, "FREE_CARD_ACTIVE");
  assert.equal(paymentsOf(4).length, 0);
});

test("record: a repeated request key returns the original payment; a reused key for another payment is a 409", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const payload = body({ amount: 700 });
  const first = await record(FEE(1), payload);
  assert.equal(first.status, 201);
  const again = await record(FEE(1), payload);
  assert.equal(again.status, 200);
  assert.equal(again.json.data.replayed, true);
  assert.equal(again.json.data.payment.id, first.json.data.payment.id);
  assert.equal(again.json.data.feePayment.outstanding, 1800);
  assert.equal(paymentsOf(1).length, 1, "recorded once");

  const differentAmount = await record(FEE(1), { ...payload, amount: 800 });
  assert.equal(differentAmount.status, 409);
  assert.equal(differentAmount.json.error.code, "REQUEST_KEY_CONFLICT");
  const differentFee = await record(FEE(6), payload);
  assert.equal(differentFee.status, 409);
  assert.equal(differentFee.json.error.code, "REQUEST_KEY_CONFLICT");
  assert.equal(paymentsOf(6).length, 0);
});

test("record: a concurrent request with the same key (unique violation) answers with the winner's payment", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const payload = body({ amount: 900 });
  let winner = null;
  db.hooks.beforeCreate = (model) => {
    if (model !== "ClassPayment") return;
    db.hooks.beforeCreate = null;
    // The other request committed first, between our pre-check and our insert.
    winner = db.insert("ClassPayment", {
      classStudentFeeId: FEE(1), classId: C, studentId: "s1", amount: 900, status: "CONFIRMED", source: "TEACHER_RECORDED",
      paymentMethod: "CASH", receivedAt: new Date(payload.receivedAt), recordedByTeacherId: T, requestKey: payload.requestKey,
      confirmedAt: new Date(), confirmedByTeacherId: T, submittedAt: new Date(),
    });
  };
  const res = await record(FEE(1), payload);
  assert.equal(res.status, 200);
  assert.equal(res.json.data.replayed, true);
  assert.equal(res.json.data.payment.id, winner.id);
  assert.equal(paymentsOf(1).length, 1, "no second payment");
});

test("record: the balance is decided under the fee-row lock (a payment that committed first is counted)", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  onFeeLock(t, (feeId) => {
    if (!paymentsOf(1).length) {
      // Another teacher session recorded Rs. 2,000 while this request waited for the lock.
      db.insert("ClassPayment", {
        classStudentFeeId: feeId, classId: C, studentId: "s1", amount: 2000, status: "CONFIRMED", source: "TEACHER_RECORDED",
        paymentMethod: "CASH", receivedAt: new Date(), recordedByTeacherId: T, requestKey: "concurrent-0001",
        confirmedAt: new Date(), confirmedByTeacherId: T, submittedAt: new Date(),
      });
    }
    return [{ id: feeId }];
  });
  const res = await record(FEE(1), body({ amount: 1000 }));
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "AMOUNT_EXCEEDS_OUTSTANDING");
  assert.equal(res.json.error.details.outstanding, 500);
  assert.equal(paymentsOf(1).length, 1);
});

test("record: lock contention is a 409 PAYMENT_BUSY, nothing written", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  onFeeLock(t, () => {
    throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "P2010" });
  });
  const res = await record(FEE(1), body());
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "PAYMENT_BUSY");
  assert.equal(db.tables.ClassPayment.filter((p) => p.source === "TEACHER_RECORDED").length, 0);
});

// ---- Student upload after a partial payment ------------------------------------------------

test("student upload: after a partial payment the slip is for the remaining balance; never once settled", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  inTempDir(t);
  const partial = await record(FEE(1), body({ amount: 1000 }));
  assert.equal(partial.status, 201);

  sessionStudentId = "s1";
  const upload = await studentPaymentsRoute.POST(slipRequest(FEE(1)));
  assert.equal(upload.status, 201);
  const slip = paymentsOf(1).find((p) => p.source === "STUDENT_SLIP");
  assert.equal(slip.status, "PENDING");
  assert.equal(slip.amount, 1500, "the outstanding balance, not the full fee");

  // Re-upload reuses the awaiting slip (as before).
  const again = await studentPaymentsRoute.POST(slipRequest(FEE(1)));
  assert.equal(again.status, 201);
  assert.equal(paymentsOf(1).filter((p) => p.source === "STUDENT_SLIP").length, 1);

  const confirmed = await confirm(slip.id);
  assert.equal(confirmed.status, 200);
  const sheet = await fees.getMonthlyFeeSheet({ teacherId: T, classId: C, year: 2026, month: 12 });
  assert.equal(sheet.rows.find((r) => r.feeId === FEE(1)).paymentStatus, "PAID");

  const after = await studentPaymentsRoute.POST(slipRequest(FEE(1)));
  assert.equal(after.status, 409);
  assert.equal((await after.json()).error.code, "ALREADY_CONFIRMED");
  assert.equal(paymentsOf(1).length, 2);
});

test("student upload: a teacher-recorded full payment settles the fee; the upload is refused", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  inTempDir(t);
  assert.equal((await record(FEE(1), body({ amount: 2500 }))).status, 201);
  sessionStudentId = "s1";
  const res = await studentPaymentsRoute.POST(slipRequest(FEE(1)));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "ALREADY_CONFIRMED");
  assert.equal(paymentsOf(1).length, 1);
});

test("student upload racing a teacher recording: the locked re-read uses the new balance", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  inTempDir(t);
  sessionStudentId = "s1";
  onFeeLock(t, (feeId) => {
    if (!paymentsOf(1).length) {
      db.insert("ClassPayment", {
        classStudentFeeId: feeId, classId: C, studentId: "s1", amount: 2000, status: "CONFIRMED", source: "TEACHER_RECORDED",
        paymentMethod: "CASH", receivedAt: new Date(), recordedByTeacherId: T, requestKey: "concurrent-0002",
        confirmedAt: new Date(), confirmedByTeacherId: T, submittedAt: new Date(),
      });
    }
    return [{ id: feeId }];
  });
  const res = await studentPaymentsRoute.POST(slipRequest(FEE(1)));
  assert.equal(res.status, 201);
  assert.equal(paymentsOf(1).find((p) => p.source === "STUDENT_SLIP").amount, 500);
});

// ---- Confirmation protection -----------------------------------------------------------------

test("confirm: a slip larger than the outstanding balance is refused and stays PENDING; clarification still works", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  // Money recorded while the slip (2,500) was pending (e.g. historical data).
  db.insert("ClassPayment", {
    classStudentFeeId: FEE(2), classId: C, studentId: "s2", amount: 1000, status: "CONFIRMED", source: "TEACHER_RECORDED",
    paymentMethod: "CASH", receivedAt: new Date(), recordedByTeacherId: T, requestKey: "historical-0001",
    confirmedAt: new Date(), confirmedByTeacherId: T, submittedAt: new Date(Date.UTC(2026, 11, 1)),
  });
  const res = await confirm("slip-2");
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "AMOUNT_EXCEEDS_OUTSTANDING");
  assert.equal(res.json.error.details.outstanding, 1500);
  assert.equal(db.row("ClassPayment", "slip-2").status, "PENDING");

  const clarify = await confirm("slip-2", { status: "NEEDS_CLARIFICATION", feedback: "Please upload a slip for Rs. 1,500" });
  assert.equal(clarify.status, 200);
  assert.equal(db.row("ClassPayment", "slip-2").status, "NEEDS_CLARIFICATION");
});

test("confirm: a normal slip confirms as before; re-confirming changes no money; teacher-recorded payments are refused", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const ok = await confirm("slip-2");
  assert.equal(ok.status, 200);
  assert.equal(db.row("ClassPayment", "slip-2").status, "CONFIRMED");
  assert.equal(db.row("ClassPayment", "slip-2").confirmedByTeacherId, T);
  const again = await confirm("slip-2");
  assert.equal(again.status, 200, "re-confirming an already confirmed slip is unchanged behaviour");

  const recorded = await record(FEE(1), body({ amount: 500 }));
  const id = recorded.json.data.payment.id;
  for (const payload of [{ status: "CONFIRMED" }, { status: "NEEDS_CLARIFICATION", feedback: "check" }]) {
    const res = await confirm(id, payload);
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, "PAYMENT_NOT_A_SLIP");
  }
  assert.equal(db.row("ClassPayment", id).status, "CONFIRMED");
  assert.equal(db.tables.PaymentMessage.filter((m) => m.paymentId === id).length, 0);
});

// ---- Reversal -----------------------------------------------------------------------------

test("reversal: the recording teacher reverses once; the payment is kept, the balance is owed again, the fee stays frozen", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const recorded = await record(FEE(1), body({ amount: 1000 }));
  const id = recorded.json.data.payment.id;
  const paymentBefore = { ...db.row("ClassPayment", id) };

  const res = await reverse(id, "  Recorded on the wrong student  ");
  assert.equal(res.status, 201);
  assert.equal(res.json.data.feePayment.outstanding, 2500);
  assert.equal(res.json.data.feePayment.reversedTotal, 1000);
  assert.equal(res.json.data.feePayment.state, "UNPAID");
  const reversal = db.tables.ClassPaymentReversal.find((r) => r.paymentId === id);
  assert.equal(reversal.amount, 1000);
  assert.equal(reversal.reason, "Recorded on the wrong student");
  assert.equal(reversal.reversedByRole, "TEACHER");
  assert.equal(reversal.reversedById, T);
  assert.ok(reversal.createdAt instanceof Date);
  assert.deepEqual(db.row("ClassPayment", id), paymentBefore, "the original payment is neither changed nor deleted");

  const duplicate = await reverse(id);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.code, "ALREADY_REVERSED");
  assert.equal(db.tables.ClassPaymentReversal.length, 1);

  await assert.rejects(fees.updateStudentFeeAdjustment({ teacherId: T, feeId: FEE(1), discount: 100 }), (e) => e.code === "FEE_LOCKED");

  // The balance can be paid again, by recording or by a slip.
  const again = await record(FEE(1), body({ amount: 2500 }));
  assert.equal(again.status, 201);
  assert.equal(again.json.data.feePayment.state, "PAID");
});

test("reversal: a fully paid fee marked status 1 becomes payable again (status 0), amounts untouched", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const recorded = await record(FEE(1), body({ amount: 2500 }));
  await fees.reprocessMonthlyFees({ teacherId: T, classId: C, year: 2026, month: 12 });
  assert.equal(db.row("ClassStudentFee", FEE(1)).status, 1);
  const before = feeAmounts(1);

  assert.equal((await reverse(recorded.json.data.payment.id)).status, 201);
  assert.equal(db.row("ClassStudentFee", FEE(1)).status, 0);
  assert.deepEqual(feeAmounts(1), before);

  inTempDir(t);
  sessionStudentId = "s1";
  const upload = await studentPaymentsRoute.POST(slipRequest(FEE(1)));
  assert.equal(upload.status, 201);
  assert.equal(paymentsOf(1).find((p) => p.source === "STUDENT_SLIP").amount, 2500);
});

test("reversal: the class owner may reverse another teacher's recording; others get a 404", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const byAssistant = db.insert("ClassPayment", {
    classStudentFeeId: FEE(1), classId: C, studentId: "s1", amount: 800, status: "CONFIRMED", source: "TEACHER_RECORDED",
    paymentMethod: "CASH", receivedAt: new Date(), recordedByTeacherId: "teacher-3", requestKey: "assistant-0001",
    confirmedAt: new Date(), confirmedByTeacherId: "teacher-3", submittedAt: new Date(),
  });
  const mine = (await record(FEE(6), body({ amount: 600 }))).json.data.payment.id;

  sessionTeacherId = T2;
  t.after(() => {
    sessionTeacherId = T;
  });
  const stranger = await reverse(mine);
  assert.equal(stranger.status, 404);
  assert.equal(stranger.json.error.code, "PAYMENT_NOT_FOUND");
  const strangerOtherRoute = await reverse(mine, "Wrong class", C2);
  assert.equal(strangerOtherRoute.status, 404);

  sessionTeacherId = T;
  const wrongClass = await reverse(mine, "Wrong class", C2);
  assert.equal(wrongClass.status, 404, "the route's class must be the payment's class");
  assert.equal(db.tables.ClassPaymentReversal.length, 0);

  const owner = await reverse(byAssistant.id);
  assert.equal(owner.status, 201);
  assert.equal(db.tables.ClassPaymentReversal[0].reversedById, T);
});

test("reversal: admin may reverse any teacher-recorded payment; recorded as ADMIN", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const id = (await record(FEE(1), body({ amount: 1200 }))).json.data.payment.id;
  const res = await adminReverse(id);
  assert.equal(res.status, 201);
  const reversal = db.tables.ClassPaymentReversal[0];
  assert.equal(reversal.reversedByRole, "ADMIN");
  assert.equal(reversal.reversedById, ADMIN);
  assert.equal(res.json.data.feePayment.outstanding, 2500);
  assert.equal((await adminReverse(id)).status, 409);
  assert.equal((await adminReverse("missing-payment")).status, 404);
});

test("reversal: student slips are never reversed here; a reason is required", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  assert.equal((await confirm("slip-2")).status, 200);
  for (const res of [await reverse("slip-2"), await adminReverse("slip-2"), await reverse("slip-3")]) {
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, "NOT_TEACHER_RECORDED");
  }
  const id = (await record(FEE(1), body())).json.data.payment.id;
  for (const reason of ["", "  ", "no", "x".repeat(501)]) {
    const res = await reverse(id, reason);
    assert.equal(res.status, 400, JSON.stringify(reason));
  }
  assert.equal(db.tables.ClassPaymentReversal.length, 0);
});

test("reversal: a concurrent duplicate (unique violation) is a 409 ALREADY_REVERSED", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const id = (await record(FEE(1), body())).json.data.payment.id;
  db.hooks.beforeCreate = (model) => {
    if (model !== "ClassPaymentReversal") return;
    db.hooks.beforeCreate = null;
    db.insert("ClassPaymentReversal", { paymentId: id, amount: 1000, reason: "Other request", reversedByRole: "ADMIN", reversedById: ADMIN });
  };
  const res = await reverse(id);
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "ALREADY_REVERSED");
  assert.equal(db.tables.ClassPaymentReversal.length, 1);
});

// ---- Regressions ------------------------------------------------------------------------------

test("Free Card and adjustments are unchanged by teacher-recorded payments", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  assert.equal((await record(FEE(1), body({ amount: 500 }))).status, 201);
  const free = await fees.setFreeCards({ teacherId: T, classId: C, year: 2026, month: 12, feeIds: [FEE(1), FEE(6)], action: "issue" });
  assert.deepEqual(free.processed.map((p) => p.feeId), [FEE(6)]);
  assert.deepEqual(free.skipped.map((s) => s.reason), ["CONFIRMED_PAYMENT"]);
  await assert.rejects(fees.updateStudentFeeAdjustment({ teacherId: T, feeId: FEE(1), discount: 100 }), (e) => e.code === "FEE_LOCKED");
  const card = await record(FEE(6), body());
  assert.equal(card.status, 409);
  assert.equal(card.json.error.code, "FREE_CARD_ACTIVE");
});

// ---- Stage 2B.1: lock timeouts on confirmation and upload ------------------------------------

const lockTimeout = () => {
  throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "P2010" });
};
const filesUnder = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((p) => fs.statSync(path.join(dir, p)).isFile()) : [];

/** Records every raw statement the route runs, in order. */
function traceRaw(t) {
  const trace = [];
  const exec = db.client.$executeRawUnsafe;
  const query = db.client.$queryRaw;
  db.client.$executeRawUnsafe = async (sql) => {
    trace.push(sql);
    return exec(sql);
  };
  db.client.$queryRaw = async (strings, ...values) => {
    trace.push(strings.join("?"));
    return query(strings, ...values);
  };
  t.after(() => {
    db.client.$executeRawUnsafe = exec;
    db.client.$queryRaw = query;
  });
  return trace;
}

test("confirm: a fee-row lock timeout is a 409 PAYMENT_BUSY and changes nothing", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const before = { ...db.row("ClassPayment", "slip-2") };
  onFeeLock(t, lockTimeout);
  const res = await confirm("slip-2");
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "PAYMENT_BUSY");
  assert.deepEqual(db.row("ClassPayment", "slip-2"), before, "status, amount and confirmation fields unchanged");
  assert.equal(db.tables.PaymentMessage.length, 0);
});

test("confirm: a transaction timeout (P2028) is also a 409 PAYMENT_BUSY", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const before = { ...db.row("ClassPayment", "slip-2") };
  onFeeLock(t, () => {
    throw Object.assign(new Error("Transaction already closed"), { code: "P2028" });
  });
  const res = await confirm("slip-2");
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "PAYMENT_BUSY");
  assert.deepEqual(db.row("ClassPayment", "slip-2"), before);
});

test("confirm: the success path still sets the 3-second lock timeout before locking the fee row", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const trace = traceRaw(t);
  const res = await confirm("slip-2");
  assert.equal(res.status, 200);
  assert.equal(db.row("ClassPayment", "slip-2").status, "CONFIRMED");
  assert.deepEqual(trace, ["SET LOCAL lock_timeout = '3000ms'", 'SELECT "id" FROM "ClassStudentFee" WHERE "id" = ? FOR UPDATE']);
});

test("upload: sets the 3-second lock timeout before locking the fee row; success path unchanged", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const dir = inTempDir(t);
  sessionStudentId = "s1";
  const trace = traceRaw(t);
  const res = await studentPaymentsRoute.POST(slipRequest(FEE(1)));
  assert.equal(res.status, 201);
  assert.deepEqual(trace, ["SET LOCAL lock_timeout = '3000ms'", 'SELECT "id" FROM "ClassStudentFee" WHERE "id" = ? FOR UPDATE']);
  const slip = paymentsOf(1)[0];
  assert.equal(slip.status, "PENDING");
  assert.equal(slip.amount, 2500);
  assert.equal(filesUnder(path.join(dir, "storage")).length, 1);
});

test("upload: a fee-row lock timeout is a 409 PAYMENT_BUSY; no payment and no stored file", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const dir = inTempDir(t);
  sessionStudentId = "s1";
  onFeeLock(t, lockTimeout);
  const res = await studentPaymentsRoute.POST(slipRequest(FEE(1)));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "PAYMENT_BUSY");
  assert.equal(paymentsOf(1).length, 0);
  assert.deepEqual(filesUnder(path.join(dir, "storage")), [], "the slip written for this request is deleted");
});

test("upload: a lock timeout while replacing a pending slip leaves that slip and its file as they were", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const dir = inTempDir(t);
  sessionStudentId = "s1";
  assert.equal((await studentPaymentsRoute.POST(slipRequest(FEE(1)))).status, 201);
  const before = { ...paymentsOf(1)[0] };
  const filesBefore = filesUnder(path.join(dir, "storage"));
  assert.equal(filesBefore.length, 1);

  onFeeLock(t, lockTimeout);
  const res = await studentPaymentsRoute.POST(slipRequest(FEE(1)));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "PAYMENT_BUSY");
  assert.equal(paymentsOf(1).length, 1);
  assert.deepEqual(paymentsOf(1)[0], before, "the pending slip is not modified");
  assert.deepEqual(filesUnder(path.join(dir, "storage")), filesBefore, "the old slip file is kept, the new one removed");
});

test("upload: other transaction errors are not turned into PAYMENT_BUSY (and the file is still removed)", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const dir = inTempDir(t);
  sessionStudentId = "s1";
  db.hooks.failOn = (model, method) => model === "ClassPayment" && method === "create";
  const res = await studentPaymentsRoute.POST(slipRequest(FEE(1)));
  assert.equal(res.status, 500);
  assert.equal(paymentsOf(1).length, 0);
  assert.deepEqual(filesUnder(path.join(dir, "storage")), []);
});

// ---- Stage 2C: the fee sheet's payment history details ----------------------------------------

test("fee sheet: payment history carries method, received date, recorder and the reversal record", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  db.insert("Teacher", { id: T, name: "Teacher One" });
  const kept = (await record(FEE(1), body({ amount: 1000, paymentMethod: "BANK_TRANSFER", note: "Ref 42" }))).json.data.payment.id;
  const undone = (await record(FEE(1), body({ amount: 500 }))).json.data.payment.id;
  assert.equal((await reverse(undone, "Entered twice")).status, 201);
  const byAdmin = (await record(FEE(6), body({ amount: 700 }))).json.data.payment.id;
  assert.equal((await adminReverse(byAdmin, "Bank returned it")).status, 201);

  const sheet = await fees.getMonthlyFeeSheet({ teacherId: T, classId: C, year: 2026, month: 12 });
  const rowOf = (n) => sheet.rows.find((r) => r.feeId === FEE(n));
  const p1 = rowOf(1).payments.find((p) => p.id === kept);
  assert.equal(p1.source, "TEACHER_RECORDED");
  assert.equal(p1.paymentMethod, "BANK_TRANSFER");
  assert.equal(p1.receivedAt, "2026-12-20T09:00:00.000Z");
  assert.equal(p1.recordedByName, "Teacher One");
  assert.equal(p1.note, "Ref 42");
  assert.equal(p1.reversed, false);
  assert.equal(p1.reversal, null);

  const p2 = rowOf(1).payments.find((p) => p.id === undone);
  assert.equal(p2.reversed, true, "the reversed payment stays in the history");
  assert.equal(p2.amount, 500);
  assert.deepEqual({ ...p2.reversal, createdAt: typeof p2.reversal.createdAt }, {
    amount: 500, reason: "Entered twice", reversedByRole: "TEACHER", reversedByName: "Teacher One", createdAt: "string",
  });
  assert.deepEqual(rowOf(1).paymentSummary.outstanding, 1500, "the sheet's figures: 2,500 - 1,000");
  assert.equal(rowOf(1).paymentStatus, "PARTIAL");

  const p3 = rowOf(6).payments.find((p) => p.id === byAdmin);
  assert.equal(p3.reversal.reversedByRole, "ADMIN");
  assert.equal(p3.reversal.reversedByName, null, "no administrator name is exposed");

  // Student slips: the new fields are empty, the existing ones unchanged.
  const s = rowOf(2).payments[0];
  assert.equal(s.source, "STUDENT_SLIP");
  assert.equal(s.paymentMethod, null);
  assert.equal(s.receivedAt, null);
  assert.equal(s.recordedByName, null);
  assert.equal(s.reversal, null);
  assert.equal(s.status, "PENDING");
});
