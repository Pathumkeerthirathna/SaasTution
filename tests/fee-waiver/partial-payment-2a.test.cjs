/*
 * Partial payments, Stage 2A: every migrated calculation uses the shared
 * payment calculation (lib/fee-payment-state.ts). Real services and routes,
 * in-memory database (./helpers/fake-db.cjs). No network, no email.
 *
 *   npm run test:fee-waiver
 *
 * One class (fee Rs. 2,500, due week 2 = 14 Dec, 5 grace days), one student
 * per case:
 *   s1 full      confirmed 2,500
 *   s2 partial   confirmed 1,000 + 500 (outstanding 1,000)
 *   s3 pending   PENDING slip 2,500
 *   s4 clarif.   NEEDS_CLARIFICATION 2,500
 *   s5 reversed  confirmed 2,500, reversed (outstanding 2,500)
 *   s6 card      Free Card (finalAmount 0)
 *   s7 zero      adjusted to 0 (discount 2,500)
 *   s8 overpaid  confirmed 2,000 + 1,000 (overpaid 500)
 *   s9 unpaid    nothing
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { createFakeDb } = require("./helpers/fake-db.cjs");

const db = createFakeDb();
// Models the student views read that the fee code does not model: empty.
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
let sessionStudentId = "s1";
fake("lib/prisma.ts", { prisma: client });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => ({ role: "TEACHER", teacherId: T }),
  requireStudentSession: async () => ({ role: "STUDENT", studentId: sessionStudentId }),
  requireAppSession: async () => ({ role: "TEACHER", teacherId: T }),
  getOptionalSession: async () => null,
  requireAdminSession: async () => {
    throw new Error("not used");
  },
});

const fees = require(path.join(root, "services", "class-student-fee-service.ts"));
const studentService = require(path.join(root, "services", "student-service.ts"));
const countsService = require(path.join(root, "services", "student-dashboard-counts-service.ts"));
const countdownService = require(path.join(root, "services", "student-countdown-service.ts"));
const access = require(path.join(root, "services", "class-access-service.ts"));
const studentPaymentsRoute = require(path.join(root, "app", "api", "student", "payments", "route.ts"));
const dashboardPaymentsRoute = require(path.join(root, "app", "api", "student", "dashboard", "payments", "route.ts"));
const legacyRoute = require(path.join(root, "app", "api", "classes", "[id]", "payments", "route.ts"));
const teacherMessagesRoute = require(path.join(root, "app", "api", "classes", "[id]", "payments", "[paymentId]", "messages", "route.ts"));
const studentMessagesRoute = require(path.join(root, "app", "api", "student", "payments", "[paymentId]", "messages", "route.ts"));

const T = "teacher-1";
const C = "class-1";
const sl = (wall) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60 * 1000);
const at = (t, wall) => t.mock.timers.enable({ apis: ["Date"], now: sl(wall) });
const DUE = new Date(Date.UTC(2026, 11, 14, 23, 59, 59, 999)); // week 2, Sri Lankan digits
const FEE = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function seed() {
  db.reset();
  db.insert("FeeWaiverSettings", { id: "default", startYear: 2027, startMonth: 1 }); // no automatic waivers in December
  db.insert("Class", {
    id: C, teacherId: T, status: 0, name: "Maths", monthlyFee: 2500, paymentDueWeek: 2, schedule: "TBD",
    restrictUnpaidStudentAccess: true, paymentGracePeriodDays: 5, teacher: { name: "Teacher" },
  });
  const cases = {
    1: { payments: [["CONFIRMED", 2500]] },
    2: { payments: [["CONFIRMED", 500], ["CONFIRMED", 1000]] },
    3: { payments: [["PENDING", 2500]] },
    4: { payments: [["NEEDS_CLARIFICATION", 2500]] },
    5: { payments: [["CONFIRMED", 2500, "reversed"]] },
    6: { fee: { freeCard: true, finalAmount: 0, freeCardIssuedAt: new Date(), freeCardIssuedByTeacherId: T } },
    7: { fee: { discount: 2500, finalAmount: 0 } },
    8: { payments: [["CONFIRMED", 1000], ["CONFIRMED", 2000]] },
    9: {},
  };
  for (const [n, spec] of Object.entries(cases)) {
    const s = `s${n}`;
    db.insert("Student", { id: s, name: s, teacherId: T, status: 0, registrationNumber: s.toUpperCase(), registrationSource: "TEACHER", confirmationStatus: "APPROVED", approvedAt: null, confirmedAt: null });
    db.insert("ClassStudent", { id: `e${n}`, classId: C, studentId: s, isActive: true, assignedAt: new Date("2026-11-01T10:00:00.000Z"), removedAt: null });
    db.insert("ClassStudentFee", {
      id: FEE(n), classStudentId: `e${n}`, year: 2026, month: 12, amount: 2500, discount: 0, lateJoinDeduct: 0, waiverAmount: 0,
      finalAmount: 2500, dueDate: DUE, status: 0, ...(spec.fee ?? {}),
    });
    (spec.payments ?? []).forEach(([status, amount, reversed], i) => {
      const payment = db.insert("ClassPayment", {
        classStudentFeeId: FEE(n), classId: C, studentId: s, amount, status,
        // Newest first by submittedAt: later entries are older.
        submittedAt: new Date(Date.UTC(2026, 11, 10 - i)),
      });
      if (reversed) db.insert("ClassPaymentReversal", { paymentId: payment.id, amount, reason: "Bank returned it", reversedByRole: "TEACHER", reversedById: T });
    });
  }
}

const EXPECT = {
  s1: { status: "PAID", confirmed: 2500, outstanding: 0 },
  s2: { status: "PARTIAL", confirmed: 1500, outstanding: 1000 },
  s3: { status: "PENDING", confirmed: 0, outstanding: 2500 },
  s4: { status: "PENDING", confirmed: 0, outstanding: 2500 },
  s5: { status: "UNPAID", confirmed: 0, outstanding: 2500 },
  s6: { status: "FREE_CARD", confirmed: 0, outstanding: 0 },
  s7: { status: "UNPAID", confirmed: 0, outstanding: 0 },
  s8: { status: "PAID", confirmed: 3000, outstanding: 0 },
  s9: { status: "UNPAID", confirmed: 0, outstanding: 2500 },
};
const OWING = ["s2", "s3", "s4", "s5", "s9"]; // outstanding > 0
const ids = (list) => [...list].sort();

test("teacher fee sheet: status and amounts per case from the shared calculation", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const sheet = await fees.getMonthlyFeeSheet({ teacherId: T, classId: C, year: 2026, month: 12 });
  for (const row of sheet.rows) {
    const e = EXPECT[row.studentId];
    assert.equal(row.paymentStatus, e.status, row.studentId);
    assert.equal(row.paymentSummary.confirmedTotal, e.confirmed, row.studentId);
    assert.equal(row.paymentSummary.outstanding, e.outstanding, row.studentId);
    assert.equal(row.hasPaid, e.status === "PAID", row.studentId);
  }
  const byStudent = Object.fromEntries(sheet.rows.map((r) => [r.studentId, r]));
  assert.equal(byStudent.s8.paymentSummary.overpaidAmount, 500, "an overpaid fee is identifiable");
  assert.equal(byStudent.s5.paymentSummary.reversedTotal, 2500);
  assert.equal(byStudent.s5.payments[0].reversed, true, "the reversed payment stays in the history");
  assert.equal(byStudent.s3.paymentSummary.pendingTotal, 2500);
  assert.equal(byStudent.s4.paymentSummary.clarificationTotal, 2500);
  assert.equal(byStudent.s1.payments[0].source, "STUDENT_SLIP");
});

test("Reprocess: status 1 only when fully paid; every row with a confirmed payment stays frozen (also reversed)", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const before = Object.fromEntries(db.tables.ClassStudentFee.map((r) => [r.id, r.finalAmount]));
  await fees.reprocessMonthlyFees({ teacherId: T, classId: C, year: 2026, month: 12 });
  const status = (n) => db.row("ClassStudentFee", FEE(n)).status;
  assert.equal(status(1), 1, "full");
  assert.equal(status(8), 1, "overpaid");
  assert.equal(status(2), 0, "partial stays visible and payable");
  assert.equal(status(5), 0, "reversed is not paid");
  for (const n of [1, 2, 5, 8]) assert.equal(db.row("ClassStudentFee", FEE(n)).finalAmount, before[FEE(n)], `frozen ${n}`);
});

test("fee freeze unchanged: a partial and a reversed payment both freeze adjustments", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  for (const n of [2, 5]) {
    await assert.rejects(fees.updateStudentFeeAdjustment({ teacherId: T, feeId: FEE(n), discount: 100 }), (e) => e.code === "FEE_LOCKED");
  }
  const free = await fees.setFreeCards({ teacherId: T, classId: C, year: 2026, month: 12, feeIds: [FEE(2), FEE(9)], action: "issue" });
  assert.deepEqual(free.processed.map((p) => p.feeId), [FEE(9)]);
  assert.deepEqual(free.skipped.map((s) => s.reason), ["CONFIRMED_PAYMENT"], "a partly paid fee cannot get a Free Card (unchanged)");
});

test("student payment list: partial stays to pay with paid / outstanding; reversed and unpaid to pay; full, overpaid, card paid", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const expected = {
    s1: ["paid", "PAID"], s2: ["toPay", "PARTIAL"], s3: ["inReview", "IN_REVIEW"], s4: ["toPay", "ACTION_NEEDED"],
    s5: ["toPay", "UNPAID"], s6: ["paid", "FREE_CARD"], s7: ["toPay", "UNPAID"], s8: ["paid", "PAID"], s9: ["toPay", "UNPAID"],
  };
  for (const [s, [group, state]] of Object.entries(expected)) {
    sessionStudentId = s;
    const { data } = await (await studentPaymentsRoute.GET(new Request("http://localhost/api/student/payments"))).json();
    const item = data[group].find((i) => i.feeId === FEE(Number(s.slice(1))));
    assert.ok(item, `${s} in ${group}`);
    assert.equal(item.state, state, s);
    assert.equal(item.paidAmount, EXPECT[s].confirmed, s);
    assert.equal(item.outstanding, EXPECT[s].outstanding, s);
  }
});

test("student dashboard: due list, totals, counts and countdowns use the outstanding amount", async (t) => {
  seed();
  at(t, "2026-12-21T09:00"); // past the 14 Dec due date
  const dueStudents = [];
  let dueTotal = 0;
  for (const s of Object.keys(EXPECT)) {
    sessionStudentId = s;
    const { data } = await (await dashboardPaymentsRoute.GET(new Request("http://localhost/x"))).json();
    if (data.due.length) dueStudents.push(s);
    dueTotal += data.dueTotal;
    for (const item of data.due) assert.equal(item.outstanding, EXPECT[s].outstanding, s);
    const counts = await countsService.getStudentDashboardCounts(s, "month");
    assert.equal(counts.payments.due, OWING.includes(s) ? 1 : 0, `count ${s}`);
  }
  assert.deepEqual(ids(dueStudents), OWING);
  assert.equal(dueTotal, 1000 + 2500 * 4, "the partial student owes the rest only");

  t.mock.timers.reset();
  at(t, "2026-12-15T00:00"); // the 14 Dec due date is inside the 8-hour countdown window
  const countdownStudents = [];
  for (const s of Object.keys(EXPECT)) {
    const items = (await countdownService.getStudentUpcomingCountdowns(s)).filter((c) => c.kind === "PAYMENT");
    if (items.length) countdownStudents.push(s);
    if (s === "s2") assert.equal(items[0].subtitle, "Rs 1,000", "the remaining balance");
  }
  assert.deepEqual(ids(countdownStudents), OWING);
});

test("guardian / profile summary: paid amount is the confirmed total, unpaid the outstanding balance", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  for (const s of Object.keys(EXPECT)) {
    const data = await studentService.getStudentPaymentSummary(s);
    const fee = data.classes[0].fees[0];
    assert.equal(fee.paidAmount, EXPECT[s].confirmed, s);
    assert.equal(fee.outstanding, EXPECT[s].outstanding, s);
    assert.equal(fee.paid, ["PAID", "FREE_CARD"].includes(EXPECT[s].status), s);
    assert.equal(data.summary.paidAmount, EXPECT[s].confirmed, s);
    assert.equal(data.summary.unpaidAmount, EXPECT[s].outstanding, s);
  }
  const partial = await studentService.getStudentPaymentSummary("s2");
  assert.equal(partial.classes[0].fees[0].state, "PARTIAL");
  assert.equal(partial.summary.unpaidCount, 1);
});

test("teacher, student and guardian agree on every fee's outstanding balance", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const sheet = await fees.getMonthlyFeeSheet({ teacherId: T, classId: C, year: 2026, month: 12 });
  const states = await fees.getEnrolmentPaymentStates({ teacherId: T, year: 2026, month: 12 });
  for (const row of sheet.rows) {
    sessionStudentId = row.studentId;
    const { data } = await (await studentPaymentsRoute.GET(new Request("http://localhost/x"))).json();
    const studentItem = [...data.toPay, ...data.inReview, ...data.paid].find((i) => i.feeId === row.feeId);
    const guardian = (await studentService.getStudentPaymentSummary(row.studentId)).classes[0].fees[0];
    assert.equal(studentItem.outstanding, row.paymentSummary.outstanding, row.studentId);
    assert.equal(guardian.outstanding, row.paymentSummary.outstanding, row.studentId);
    assert.equal(states.get(row.classStudentId).outstanding, row.paymentSummary.outstanding, row.studentId);
  }
});

test("teacher dashboard: due = outstanding with no slip awaiting; the partial student is due for the rest", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const states = await fees.getEnrolmentPaymentStates({ teacherId: T, year: 2026, month: 12 });
  const due = [...states].filter(([, p]) => p.outstanding > 0 && !p.awaiting).map(([e]) => e);
  assert.deepEqual(ids(due), ["e2", "e5", "e9"]);
  assert.equal(states.get("e2").state, "PARTIAL");
  assert.equal(states.get("e3").awaiting, true);
  const page = fs.readFileSync(path.join(root, "app", "dashboard", "page.tsx"), "utf8");
  assert.match(page, /return !position \|\| \(position\.outstanding > 0 && !position\.awaiting\);/);
  assert.match(page, /amount: position\?\.state === "PARTIAL" \? position\.outstanding : cls\.monthlyFee,/);
  assert.match(page, /reversal: \{ is: null \},/, "reversed payments are not counted as confirmed revenue");
});

test("legacy summary: partial, reversed and unpaid students are defaulters; confirmed totals exclude reversals", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const res = await legacyRoute.GET(new Request(`http://localhost/api/classes/${C}/payments?month=2026-12`), { params: { id: C } });
  const { data } = await res.json();
  assert.deepEqual(ids(data.defaulters.map((s) => s.id)), ["s2", "s5", "s9"]);
  assert.equal(data.summary.confirmedAmount, 2500 + 1500 + 3000, "s1 + s2 + s8; s5's reversed 2,500 excluded");
  assert.equal(data.summary.confirmedCount, 5);
  assert.equal(data.summary.freeCardCount, 1);
});

test("LMS restriction: an overdue remaining balance restricts; pending, full, overpaid, card and zero never do", async (t) => {
  seed();
  at(t, "2026-12-21T09:00"); // due 14 Dec + 5 days → restricted from 20 Dec
  const restricted = [];
  for (const s of Object.keys(EXPECT)) {
    const r = await access.getClassAccessRestrictions(s);
    if (r.length) restricted.push(s);
    if (s === "s2") assert.equal(r[0].outstandingAmount, 1000, "the remaining balance is what is owed");
  }
  assert.deepEqual(ids(restricted), ["s2", "s5", "s9"]);

  t.mock.timers.reset();
  at(t, "2026-12-18T09:00"); // within the grace period
  assert.deepEqual(await access.getClassAccessRestrictions("s2"), []);
});

test("payment-message routes: the slip conversation never changes a teacher-recorded payment", async (t) => {
  seed();
  at(t, "2026-12-21T09:00");
  const recorded = db.insert("ClassPayment", {
    classStudentFeeId: FEE(9), classId: C, studentId: "s9", amount: 1000, status: "CONFIRMED", source: "TEACHER_RECORDED",
    paymentMethod: "CASH", receivedAt: new Date(), recordedByTeacherId: T, submittedAt: new Date(),
  });
  const form = () => {
    const f = new FormData();
    f.set("message", "Please check this payment");
    return f;
  };
  const teacher = await teacherMessagesRoute.POST(
    new Request("http://localhost/x", { method: "POST", body: form() }),
    { params: { id: C, paymentId: recorded.id } }
  );
  assert.equal(teacher.status, 409);
  assert.equal((await teacher.json()).error.code, "PAYMENT_NOT_A_SLIP");

  sessionStudentId = "s9";
  const student = await studentMessagesRoute.POST(new Request("http://localhost/x", { method: "POST", body: form() }), { params: { paymentId: recorded.id } });
  assert.equal(student.status, 409);
  assert.equal(db.row("ClassPayment", recorded.id).status, "CONFIRMED", "unchanged");
  assert.equal(db.tables.PaymentMessage.length, 0);

  // A student slip still takes part in the clarification conversation, as before.
  const slip = db.tables.ClassPayment.find((p) => p.studentId === "s3");
  const ok = await teacherMessagesRoute.POST(new Request("http://localhost/x", { method: "POST", body: form() }), { params: { id: C, paymentId: slip.id } });
  assert.equal(ok.status, 201);
  assert.equal(db.row("ClassPayment", slip.id).status, "NEEDS_CLARIFICATION");
});
