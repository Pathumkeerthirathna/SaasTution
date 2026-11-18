/*
 * Partial payments, Stage 1: the shared payment calculation
 * (feePaymentState in services/class-student-fee-service.ts), and proof that
 * Stage 1 changes NO existing behaviour: every existing caller still decides
 * "paid" from "any CONFIRMED payment", fees still freeze after the first
 * confirmed payment, and waivers / Free Cards work as before (real services,
 * in-memory database). Stage 2 moves the callers to feePaymentState.
 *
 *   npm run test:fee-waiver
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
function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
fake("lib/prisma.ts", { prisma: db.client });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => ({ role: "TEACHER", teacherId: "teacher-1" }),
  requireStudentSession: async () => ({ role: "STUDENT", studentId: "s1" }),
  requireAppSession: async () => ({ role: "TEACHER", teacherId: "teacher-1" }),
  getOptionalSession: async () => null,
  requireAdminSession: async () => {
    throw new Error("not used");
  },
});

const fees = require(path.join(root, "services", "class-student-fee-service.ts"));
const { feePaymentState } = fees;

const confirmed = (amount, reversed = false) => ({ amount, status: "CONFIRMED", reversal: reversed ? { amount } : null });
const pending = (amount) => ({ amount, status: "PENDING" });
const clarification = (amount) => ({ amount, status: "NEEDS_CLARIFICATION" });
const FEE = { finalAmount: 2500, freeCard: false };

// ---- The calculation ------------------------------------------------------------------

test("Rs. 2,500 fee: 1,000 + 500 + 1,000 confirmed → outstanding 1,500 → 1,000 → 0 (PARTIAL, PARTIAL, PAID)", () => {
  const steps = [];
  const payments = [];
  for (const amount of [1000, 500, 1000]) {
    payments.push(confirmed(amount));
    const s = feePaymentState(FEE, payments);
    steps.push([s.confirmedTotal, s.outstanding, s.state]);
  }
  assert.deepEqual(steps, [
    [1000, 1500, "PARTIAL"],
    [1500, 1000, "PARTIAL"],
    [2500, 0, "PAID"],
  ]);
  assert.equal(feePaymentState(FEE, payments).overpaidAmount, 0);
});

test("never settled by a first partial payment", () => {
  const s = feePaymentState(FEE, [confirmed(1)]);
  assert.equal(s.state, "PARTIAL");
  assert.equal(s.outstanding, 2499);
});

test("PENDING and NEEDS_CLARIFICATION are reported separately and never received", () => {
  const onlyPending = feePaymentState(FEE, [pending(2500)]);
  assert.deepEqual(
    { state: onlyPending.state, confirmedTotal: onlyPending.confirmedTotal, pendingTotal: onlyPending.pendingTotal, outstanding: onlyPending.outstanding },
    { state: "PENDING", confirmedTotal: 0, pendingTotal: 2500, outstanding: 2500 }
  );
  const clar = feePaymentState(FEE, [clarification(2500)]);
  assert.equal(clar.state, "PENDING");
  assert.equal(clar.clarificationTotal, 2500);
  assert.equal(clar.pendingTotal, 0);
  assert.equal(clar.outstanding, 2500);

  const mixed = feePaymentState(FEE, [confirmed(1000), pending(1500)]);
  assert.deepEqual([mixed.state, mixed.confirmedTotal, mixed.pendingTotal, mixed.outstanding], ["PARTIAL", 1000, 1500, 1500]);
});

test("Free Card: nothing payable", () => {
  const card = feePaymentState({ finalAmount: 0, freeCard: true }, []);
  assert.deepEqual([card.state, card.outstanding, card.confirmedTotal], ["FREE_CARD", 0, 0]);
  // Even with a stale finalAmount, a card means zero payable.
  assert.equal(feePaymentState({ finalAmount: 2500, freeCard: true }, []).outstanding, 0);
});

test("reversed payments are excluded from received money (the original stays in the history)", () => {
  const payments = [confirmed(1000), confirmed(500, true), confirmed(1000)];
  const s = feePaymentState(FEE, payments);
  assert.deepEqual([s.confirmedTotal, s.reversedTotal, s.outstanding, s.state], [2000, 500, 500, "PARTIAL"]);
  assert.equal(payments.length, 3, "nothing removed");

  const allReversed = feePaymentState(FEE, [confirmed(2500, true)]);
  assert.deepEqual([allReversed.state, allReversed.outstanding, allReversed.reversedTotal], ["UNPAID", 2500, 2500]);
});

test("an overpayment is reported, never hidden", () => {
  const s = feePaymentState(FEE, [confirmed(2000), confirmed(1000)]);
  assert.deepEqual([s.state, s.outstanding, s.overpaidAmount], ["PAID", 0, 500]);
});

test("existing single full payment and edge cases match today's meaning", () => {
  assert.equal(feePaymentState(FEE, [confirmed(2500)]).state, "PAID", "a full student slip, confirmed");
  assert.equal(feePaymentState(FEE, []).state, "UNPAID");
  // finalAmount 0 without a card (adjusted to zero), no payment: still UNPAID with nothing outstanding,
  // as the fee sheet shows it today.
  const zero = feePaymentState({ finalAmount: 0, freeCard: false }, []);
  assert.deepEqual([zero.state, zero.outstanding], ["UNPAID", 0]);
  // Invalid amounts are ignored, never counted.
  const odd = feePaymentState(FEE, [confirmed(Number.NaN), { amount: -50, status: "CONFIRMED" }, pending(undefined)]);
  assert.deepEqual([odd.confirmedTotal, odd.pendingTotal, odd.outstanding], [0, 0, 2500]);
});

// ---- Stage 1 changes no existing behaviour --------------------------------------------------

const T = "teacher-1";
const C = "class-1";
const sl = (wall) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60 * 1000);
const at = (t, wall) => t.mock.timers.enable({ apis: ["Date"], now: sl(wall) });
const DUE = new Date(Date.UTC(2026, 11, 28, 23, 59, 59, 999));
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function seed() {
  db.reset();
  db.insert("FeeWaiverSettings", { id: "default", startYear: 2026, startMonth: 12 });
  db.insert("Class", { id: C, teacherId: T, status: 0, name: "Maths", monthlyFee: 2500, paymentDueWeek: 4, schedule: "TBD" });
  db.insert("ClassFeeWaiverRule", { id: "r1", classId: C, sequence: 1, type: "PERCENTAGE", value: 40 });
  db.insert("Lecture", { id: "L5", classId: C, title: "L5", date: sl("2026-12-05T18:00"), classStatus: "COMPLETED", status: 0 });
  for (const id of ["s1", "s2", "s3"]) {
    db.insert("Student", { id, name: id, teacherId: T, status: 0, registrationNumber: id.toUpperCase(), registrationSource: "TEACHER", confirmationStatus: "APPROVED", approvedAt: null, confirmedAt: null });
    db.insert("ClassStudent", { id: `e-${id}`, classId: C, studentId: id, isActive: true, assignedAt: new Date(`2026-12-20T10:00:00.000Z`), removedAt: null });
  }
}
const fee = (id, cs, over = {}) =>
  db.insert("ClassStudentFee", { id, classStudentId: cs, year: 2026, month: 12, amount: 2500, discount: 0, lateJoinDeduct: 0, waiverAmount: 0, finalAmount: 2500, dueDate: DUE, status: 0, ...over });
const pay = (feeId, status, amount) =>
  db.insert("ClassPayment", { classStudentFeeId: feeId, classId: C, studentId: "s1", amount, status, submittedAt: new Date(Date.UTC(2026, 11, 21)) });

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test("Stage 2A: the fee sheet and Reprocess use the shared calculation (a partial payment is PARTIAL, not paid)", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  fee(uid(1), "e-s1"); // full payment confirmed
  fee(uid(2), "e-s2"); // a smaller confirmed amount (what a partial payment would be)
  fee(uid(3), "e-s3"); // pending slip
  pay(uid(1), "CONFIRMED", 2500);
  pay(uid(2), "CONFIRMED", 1000);
  pay(uid(3), "PENDING", 2500);

  const sheet = await fees.getMonthlyFeeSheet({ teacherId: T, classId: C, year: 2026, month: 12 });
  const status = Object.fromEntries(sheet.rows.map((r) => [r.feeId, r.paymentStatus]));
  assert.deepEqual(status, { [uid(1)]: "PAID", [uid(2)]: "PARTIAL", [uid(3)]: "PENDING" }, "the 1,000 of 2,500 is partial (Stage 1 still showed it as paid)");
  const partialRow = sheet.rows.find((r) => r.feeId === uid(2));
  assert.equal(partialRow.paymentSummary.outstanding, 1500);
  assert.equal(partialRow.hasPaid, false);

  await fees.reprocessMonthlyFees({ teacherId: T, classId: C, year: 2026, month: 12 });
  assert.equal(db.row("ClassStudentFee", uid(1)).status, 1, "fully paid: status 1, as before");
  assert.equal(db.row("ClassStudentFee", uid(2)).status, 0, "partly paid: stays 0 (visible and payable), still frozen");
  assert.equal(db.row("ClassStudentFee", uid(2)).finalAmount, 2500, "frozen: the amount is untouched");
  assert.equal(db.row("ClassStudentFee", uid(3)).status, 0);
});

test("Stage 1: the fee still freezes after the first confirmed payment, however small", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  fee(uid(2), "e-s2");
  pay(uid(2), "CONFIRMED", 1000);
  const before = { ...db.row("ClassStudentFee", uid(2)) };

  await rejects(fees.updateStudentFeeAdjustment({ teacherId: T, feeId: uid(2), discount: 100 }), "FEE_LOCKED");
  await rejects(
    fees.setMonthlyFeeAmount({ teacherId: T, classId: C, year: 2026, month: 12, amount: 3000, applyToAll: false, feeId: uid(2) }),
    "FEE_LOCKED"
  );
  await fees.setMonthlyFeeAmount({ teacherId: T, classId: C, year: 2026, month: 12, amount: 3000, applyToAll: true });
  await fees.recalculateJoinWaiversForClassMonth({ classId: C, month: { year: 2026, month: 12 } });
  assert.deepEqual({ ...db.row("ClassStudentFee", uid(2)), updatedAt: null }, { ...before, updatedAt: null }, "untouched by every path");
});

test("Stage 1: normal fees, waivers and Free Cards behave exactly as before", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  fee(uid(1), "e-s1", { discount: 200, waiverAmount: 300, finalAmount: 2000 });
  fee(uid(2), "e-s2");
  fee(uid(3), "e-s3");
  pay(uid(3), "CONFIRMED", 1000); // a partial confirmed payment blocks a Free Card, as any confirmed payment does today

  // Adjustments on an unpaid fee: unchanged formula.
  const adjusted = await fees.updateStudentFeeAdjustment({ teacherId: T, feeId: uid(1), lateJoinDeduct: 500 });
  assert.equal(adjusted.finalAmount, 2500 - 200 - 500 - 300);

  // Automatic joining waiver (40%, one completed lecture before joining) on the untouched fee.
  await fees.reprocessMonthlyFees({ teacherId: T, classId: C, year: 2026, month: 12 });
  assert.equal(db.row("ClassStudentFee", uid(2)).lateJoinDeduct, 1000);
  assert.equal(db.row("ClassStudentFee", uid(2)).finalAmount, 1500);

  // Free Card: issue on the unpaid fee, skip the one with a confirmed payment, revoke restores.
  const issued = await fees.setFreeCards({ teacherId: T, classId: C, year: 2026, month: 12, feeIds: [uid(2), uid(3)], action: "issue" });
  assert.deepEqual(issued.processed.map((p) => p.feeId), [uid(2)]);
  assert.deepEqual(issued.skipped.map((s) => s.reason), ["CONFIRMED_PAYMENT"]);
  assert.equal(db.row("ClassStudentFee", uid(2)).finalAmount, 0);
  await fees.setFreeCards({ teacherId: T, classId: C, year: 2026, month: 12, feeIds: [uid(2)], action: "revoke" });
  assert.equal(db.row("ClassStudentFee", uid(2)).finalAmount, 1500);
});
