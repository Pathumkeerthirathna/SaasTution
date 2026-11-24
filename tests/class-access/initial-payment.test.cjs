/*
 * Payment-due access control, initial payment (services/class-access-service.ts):
 * a student registered through a public class page is restricted in that
 * class from their approval on until the initial fee is paid by CONFIRMED
 * money, without waiting for the due date or grace period; a submitted slip
 * does not lift it. Everything else (later months, other classes,
 * teacher-created / imported students, re-enrolments) keeps the existing
 * overdue rule exactly (due date + grace, a submitted slip protects).
 *
 *   npm run test:class-access
 *
 * Real services and routes (approval, fee creation, slip upload, teacher
 * confirmation, recorded payments and reversals, protected content and
 * payment routes), in-memory database (tests/fee-waiver/helpers/fake-db.cjs).
 * No network, no email, no real database.
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

let sessionTeacherId = "teacher-1";
let sessionStudentId = "p1";
fake("lib/prisma.ts", { prisma: db.client });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => ({ role: "TEACHER", teacherId: sessionTeacherId }),
  requireStudentSession: async () => ({ role: "STUDENT", studentId: sessionStudentId }),
  requireAppSession: async () => ({ role: "STUDENT", userId: sessionStudentId }),
  getOptionalSession: async () => null,
  requireAdminSession: async () => {
    throw new Error("not used");
  },
});

const access = require(path.join(root, "services", "class-access-service.ts"));
const studentService = require(path.join(root, "services", "student-service.ts"));
const paymentService = require(path.join(root, "services", "class-payment-service.ts"));
const lectureRoute = require(path.join(root, "app", "api", "student", "lectures", "[lectureId]", "route.ts"));
const studentPaymentsRoute = require(path.join(root, "app", "api", "student", "payments", "route.ts"));
const dashboardPaymentsRoute = require(path.join(root, "app", "api", "student", "dashboard", "payments", "route.ts"));
const confirmRoute = require(path.join(root, "app", "api", "classes", "[id]", "payments", "[paymentId]", "confirm", "route.ts"));

// Sri Lankan wall clock → the real instant (mocked clock) / stored digits.
const sl = (wall) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60 * 1000);
const digits = (wall) => new Date(`${wall}:00.000Z`);
const at = (t, wall) => t.mock.timers.enable({ apis: ["Date"], now: sl(wall) });
const dueDigits = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));

const T = "teacher-1";
const A = "class-a"; // restriction ON, 5 grace days, due week 2 (14th) — the public registration class
const B = "class-b"; // restriction OFF
const C = "class-c"; // restriction ON, 5 grace days — a class the teacher added the student to

// Silence the expected "[CLASS_ACCESS] ..." log of the failure test.
const originalError = console.error;
const logged = [];
test.before(() => {
  console.error = (...args) => {
    if (String(args[0]).startsWith("[CLASS_ACCESS]")) {
      logged.push(String(args[0]));
      return;
    }
    originalError(...args);
  };
});
test.after(() => {
  console.error = originalError;
});

function seed() {
  db.reset();
  logged.length = 0;
  db.insert("FeeWaiverSettings", { id: "default", startYear: 2026, startMonth: 1 }); // no rules: no waivers
  const cls = (id, name, restrict) =>
    db.insert("Class", { id, teacherId: T, status: 0, name, monthlyFee: 2000, paymentDueWeek: 2, schedule: "TBD", restrictUnpaidStudentAccess: restrict, paymentGracePeriodDays: 5, teacher: { name: "Teacher" } });
  cls(A, "Combined Maths", true);
  cls(B, "Physics", false);
  cls(C, "Chemistry", true);
  db.insert("Lecture", { id: "lec-a", classId: A, title: "A1", status: 0 });
  db.insert("Lecture", { id: "lec-c", classId: C, title: "C1", status: 0 });
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

const publicStudent = (id, over = {}) => student(id, { registrationSource: "PUBLIC_CLASS", publicClassId: A, confirmationStatus: "PENDING", ...over });

function enrol(id, studentId, classId, assignedWall, isActive = true) {
  return db.insert("ClassStudent", { id, classId, studentId, isActive, assignedAt: digits(assignedWall), removedAt: isActive ? null : digits(assignedWall) });
}

let feeSeq = 0;
function fee(classStudentId, { year = 2026, month = 11, ...over } = {}) {
  feeSeq += 1;
  const amount = over.amount ?? 2000;
  return db.insert("ClassStudentFee", {
    id: `fee-${feeSeq}`,
    classStudentId,
    year,
    month,
    amount,
    discount: 0,
    lateJoinDeduct: 0,
    waiverAmount: 0,
    finalAmount: amount,
    dueDate: dueDigits(year, month, 14),
    status: 0,
    createdAt: new Date(),
    ...over,
  });
}

function pay(feeId, status, { amount = 2000, classId = A, studentId = "p1" } = {}) {
  return db.insert("ClassPayment", { classStudentFeeId: feeId, classId, studentId, amount, status, source: "STUDENT_SLIP", submittedAt: new Date() });
}

const restrictions = (studentId = "p1") => access.getClassAccessRestrictions(studentId);
const restricted = async (studentId = "p1") => (await restrictions(studentId)).map((r) => [r.classId, r.month, r.reason]);
const feesOf = (classStudentId) => db.tables.ClassStudentFee.filter((r) => r.classStudentId === classStudentId);

/** The usual public registration: pending, enrolled in A with this month's fee (created at registration). */
function registeredOn(wall, id = "p1") {
  publicStudent(id);
  enrol(`e-${id}`, id, A, wall);
  return fee(`e-${id}`);
}

// ---- The rule (pure) -----------------------------------------------------------------------

test("initialFeeRestrictsAccess: any outstanding amount restricts, whatever the due date; Free Card / nothing owed never", () => {
  assert.equal(access.initialFeeRestrictsAccess({ finalAmount: 2000, freeCard: false }), true);
  assert.equal(access.initialFeeRestrictsAccess({ finalAmount: 1, freeCard: false }), true, "a partly paid initial fee");
  assert.equal(access.initialFeeRestrictsAccess({ finalAmount: 0, freeCard: false }), false);
  assert.equal(access.initialFeeRestrictsAccess({ finalAmount: 2000, freeCard: true }), false);
});

// ---- Approval ------------------------------------------------------------------------------

test("approval restricts the public-registration class at once, before the due date; never before approval", async (t) => {
  seed();
  at(t, "2026-11-05T10:00"); // due 14 Nov + 5 grace days: the overdue rule would allow access until 19 Nov
  registeredOn("2026-11-03T09:00");
  assert.deepEqual(await restricted(), [], "pending: the rule does not apply (the student cannot sign in anyway)");

  await studentService.confirmStudent(T, "p1");
  assert.deepEqual(await restricted(), [[A, 11, "INITIAL_PAYMENT"]]);
  const [r] = await restrictions();
  assert.equal(r.outstandingAmount, 2000);
  assert.equal(r.className, "Combined Maths");

  await assert.rejects(access.assertClassAccessForStudent("p1", A), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, "CLASS_ACCESS_RESTRICTED");
    assert.match(error.message, /Access to Combined Maths opens once your first class fee payment is confirmed by your teacher\./);
    assert.equal(error.details.restrictions[0].reason, "INITIAL_PAYMENT");
    return true;
  });
  assert.equal(feesOf("e-p1").length, 1, "the fee created at registration is reused, never duplicated");
});

test("approval creates the missing current-month fee of the public enrolment only, once (re-approval, approve-all)", async (t) => {
  seed();
  // Registered 30 Oct (October fee created then); approved 2 Nov: no November row yet.
  publicStudent("p1");
  enrol("e-p1", "p1", A, "2026-10-30T09:00");
  fee("e-p1", { month: 10 });
  enrol("e-p1c", "p1", C, "2026-10-30T09:05"); // the teacher also added the student to C (no fee yet)

  at(t, "2026-11-02T10:00");
  await studentService.confirmStudent(T, "p1");
  assert.deepEqual(feesOf("e-p1").map((f) => f.month).sort(), [10, 11], "November row created by the approval");
  const november = feesOf("e-p1").find((f) => f.month === 11);
  assert.equal(november.finalAmount, 2000, "the existing calculation (class fee, no waiver)");
  assert.equal(november.dueDate.toISOString(), dueDigits(2026, 11, 14).toISOString(), "the existing due date");
  assert.equal(feesOf("e-p1c").length, 0, "other enrolments get nothing from the approval");
  assert.deepEqual(await restricted(), [[A, 10, "INITIAL_PAYMENT"], [A, 11, "INITIAL_PAYMENT"]], "every month up to the approval month");

  await studentService.declineStudent(T, "p1");
  await studentService.confirmStudent(T, "p1");
  assert.equal(feesOf("e-p1").length, 2, "re-approval creates nothing");

  publicStudent("p2");
  enrol("e-p2", "p2", A, "2026-10-31T09:00");
  publicStudent("p3", { status: 0 });
  enrol("e-p3", "p3", A, "2026-10-31T10:00", false); // enrolment no longer active
  assert.equal(await studentService.confirmAllPendingStudents(T), 2);
  assert.equal(feesOf("e-p2").length, 1, "approve-all: one row");
  assert.equal(feesOf("e-p3").length, 0, "an inactive enrolment gets no row");
  assert.deepEqual(await restricted("p2"), [[A, 11, "INITIAL_PAYMENT"]]);
  assert.deepEqual(await restricted("p3"), [], "no active enrolment: nothing restricted");
});

test("teacher-created / imported students: the approval path creates nothing for them", async (t) => {
  seed();
  at(t, "2026-11-02T10:00");
  student("t1", { confirmationStatus: "REJECTED" });
  enrol("e-t1", "t1", A, "2026-10-30T09:00");
  await studentService.confirmStudent(T, "t1");
  assert.equal(feesOf("e-t1").length, 0);
});

test("a failed fee-row creation never fails or undoes the approval (logged; the Payments page still creates it)", async (t) => {
  seed();
  publicStudent("p1");
  enrol("e-p1", "p1", A, "2026-10-30T09:00");
  at(t, "2026-11-02T10:00");
  const create = db.client.classStudentFee.create;
  db.client.classStudentFee.create = async () => {
    throw new Error("database unavailable");
  };
  try {
    const result = await studentService.confirmStudent(T, "p1");
    assert.equal(result.toStatus, "APPROVED");
  } finally {
    db.client.classStudentFee.create = create;
  }
  assert.equal(db.row("Student", "p1").confirmationStatus, "APPROVED");
  assert.equal(feesOf("e-p1").length, 0);
  assert.match(logged.join("\n"), /\[CLASS_ACCESS\] initial fee row after approval failed \(student p1\)/);

  // The existing Payments-page fallback creates the row; the restriction then applies.
  sessionStudentId = "p1";
  const list = await studentPaymentsRoute.GET(new Request("http://localhost/api/student/payments"));
  assert.equal(list.status, 200);
  assert.equal(feesOf("e-p1").length, 1);
  assert.deepEqual(await restricted(), [[A, 11, "INITIAL_PAYMENT"]]);
});

// ---- What lifts it --------------------------------------------------------------------------

test("a submitted slip does NOT lift the initial restriction; the teacher's confirmation does", async (t) => {
  seed();
  at(t, "2026-11-05T10:00");
  const f = registeredOn("2026-11-03T09:00");
  await studentService.confirmStudent(T, "p1");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "initial-payment-"));
  const previous = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  sessionStudentId = "p1";
  const form = new FormData();
  form.set("feeId", f.id);
  form.set("slip", new File([Buffer.from("%PDF-1.4")], "slip.pdf", { type: "application/pdf" }));
  const uploaded = await studentPaymentsRoute.POST(new Request("http://localhost/api/student/payments", { method: "POST", body: form }));
  assert.equal(uploaded.status, 201, "payments stay available while restricted");
  const slip = db.tables.ClassPayment.find((p) => p.classStudentFeeId === f.id);
  assert.equal(slip.status, "PENDING");
  assert.deepEqual(await restricted(), [[A, 11, "INITIAL_PAYMENT"]], "PENDING slip: still restricted");

  slip.status = "NEEDS_CLARIFICATION";
  assert.deepEqual(await restricted(), [[A, 11, "INITIAL_PAYMENT"]], "NEEDS_CLARIFICATION: still restricted");
  slip.status = "PENDING";

  sessionTeacherId = T;
  const confirmed = await confirmRoute.POST(
    new Request(`http://localhost/api/classes/${A}/payments/${slip.id}/confirm`, { method: "POST", body: JSON.stringify({ status: "CONFIRMED" }) }),
    { params: { id: A, paymentId: slip.id } }
  );
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await restricted(), [], "confirmed by the teacher: access restored");
  await access.assertContentAccessForStudent("p1", { lectureId: "lec-a" });
});

test("teacher-recorded payments: partial stays restricted, full restores, a reversal restricts again", async (t) => {
  seed();
  at(t, "2026-11-05T10:00");
  const f = registeredOn("2026-11-03T09:00");
  await studentService.confirmStudent(T, "p1");
  const record = (amount, key) =>
    paymentService.recordTeacherPayment({
      teacherId: T,
      classId: A,
      feeId: f.id,
      input: { amount, paymentMethod: "CASH", receivedAt: new Date(), note: null, requestKey: key },
    });

  await record(1200, "k1");
  const [partial] = await restrictions();
  assert.equal(partial.reason, "INITIAL_PAYMENT");
  assert.equal(partial.outstandingAmount, 800, "partial payment: the rest is still owed");

  const second = await record(800, "k2");
  assert.deepEqual(await restricted(), [], "paid in full: access restored");

  await paymentService.reverseTeacherPayment({ actor: { role: "TEACHER", teacherId: T }, paymentId: second.payment.id, classId: A, reason: "Recorded twice" });
  const [again] = await restrictions();
  assert.equal(again.reason, "INITIAL_PAYMENT");
  assert.equal(again.outstandingAmount, 800, "reversed: owed again, restricted again");
});

test("a Free Card, waivers / adjustments down to 0, or switching the class setting off allow access", async (t) => {
  seed();
  at(t, "2026-11-05T10:00");
  const f = registeredOn("2026-11-03T09:00");
  await studentService.confirmStudent(T, "p1");
  assert.equal((await restricted()).length, 1);

  db.touch("ClassStudentFee", f.id, { freeCard: true, finalAmount: 0, freeCardIssuedAt: new Date(), freeCardIssuedByTeacherId: T });
  assert.deepEqual(await restricted(), [], "Free Card");
  db.touch("ClassStudentFee", f.id, { freeCard: false, freeCardIssuedAt: null, freeCardIssuedByTeacherId: null, finalAmount: 2000 });
  assert.equal((await restricted()).length, 1);

  db.touch("ClassStudentFee", f.id, { lateJoinDeduct: 1500, waiverAmount: 500, finalAmount: 0 });
  assert.deepEqual(await restricted(), [], "joining waiver + adjustment to 0");
  db.touch("ClassStudentFee", f.id, { lateJoinDeduct: 0, waiverAmount: 0, finalAmount: 2000 });

  db.row("Class", A).restrictUnpaidStudentAccess = false;
  assert.deepEqual(await restricted(), [], "the class restriction is off");
});

// ---- Unchanged: later months, other classes, other students ------------------------------------

test("months after the approval month keep the existing grace rule and the submitted-slip protection", async (t) => {
  seed();
  at(t, "2026-11-05T10:00");
  const nov = registeredOn("2026-11-03T09:00");
  await studentService.confirmStudent(T, "p1");
  pay(nov.id, "CONFIRMED");
  assert.deepEqual(await restricted(), []);

  const dec = fee("e-p1", { month: 12 });
  t.mock.timers.setTime(sl("2026-12-05T10:00").getTime());
  assert.deepEqual(await restricted(), [], "December: before its due date");
  t.mock.timers.setTime(sl("2026-12-19T23:00").getTime());
  assert.deepEqual(await restricted(), [], "December: within the 5 grace days");
  t.mock.timers.setTime(sl("2026-12-20T08:00").getTime());
  assert.deepEqual(await restricted(), [[A, 12, "OVERDUE"]], "December: overdue after the grace period");
  await assert.rejects(access.assertClassAccessForStudent("p1", A), (error) => {
    assert.match(error.message, /^Access to Combined Maths is paused because a class fee is overdue\./, "the existing message");
    return true;
  });
  pay(dec.id, "PENDING");
  assert.deepEqual(await restricted(), [], "a submitted slip protects later months, as before");
});

test("teacher-created, imported and re-enrolled students and other classes keep the overdue rule unchanged", async (t) => {
  seed();
  student("t1", { approvedAt: sl("2026-11-01T09:00") }); // teacher-created
  student("i1", { registrationSource: "IMPORT", approvedAt: sl("2026-11-01T09:00") });
  student("legacy", { registrationSource: "PUBLIC_CLASS", publicClassId: A, approvedAt: null }); // approved before approvedAt existed
  enrol("e-t1", "t1", A, "2026-11-01T09:00");
  enrol("e-i1", "i1", A, "2026-11-01T09:00");
  enrol("e-legacy", "legacy", A, "2026-11-01T09:00");
  const tf = fee("e-t1");
  fee("e-i1");
  fee("e-legacy");
  // A public student removed from A and added again: the new enrolment is not the registration one.
  publicStudent("p1", { confirmationStatus: "APPROVED", approvedAt: sl("2026-11-01T09:00") });
  enrol("e-p1-old", "p1", A, "2026-10-01T09:00", false);
  enrol("e-p1", "p1", A, "2026-11-02T09:00");
  fee("e-p1");
  // The public student's other class (added by the teacher).
  enrol("e-p1c", "p1", C, "2026-11-01T09:00");
  fee("e-p1c");

  at(t, "2026-11-05T10:00");
  for (const id of ["t1", "i1", "legacy", "p1"]) assert.deepEqual(await restricted(id), [], `${id}: before the due date`);

  t.mock.timers.setTime(sl("2026-11-20T08:00").getTime());
  assert.deepEqual(await restricted("t1"), [[A, 11, "OVERDUE"]]);
  assert.deepEqual(await restricted("i1"), [[A, 11, "OVERDUE"]]);
  assert.deepEqual(await restricted("legacy"), [[A, 11, "OVERDUE"]]);
  assert.deepEqual(await restricted("p1"), [[A, 11, "OVERDUE"], [C, 11, "OVERDUE"]]);
  pay(tf.id, "PENDING", { studentId: "t1" });
  assert.deepEqual(await restricted("t1"), [], "a submitted slip still protects them");
});

test("an approved public student's other class is unaffected by the initial payment of the registration class", async (t) => {
  seed();
  at(t, "2026-11-05T10:00");
  registeredOn("2026-11-03T09:00");
  enrol("e-p1c", "p1", C, "2026-11-03T09:05");
  fee("e-p1c");
  await studentService.confirmStudent(T, "p1");
  assert.deepEqual(await restricted(), [[A, 11, "INITIAL_PAYMENT"]], "only the registration class");
  await access.assertClassAccessForStudent("p1", C);
  await access.assertContentAccessForStudent("p1", { lectureId: "lec-c" });
  assert.deepEqual([...(await access.filterAccessibleClassIds("p1", [A, B, C]))].sort(), [B, C]);
});

// ---- Direct requests ----------------------------------------------------------------------------

test("direct API requests: protected content is 403 with the initial-payment reason; payment routes stay open", async (t) => {
  seed();
  at(t, "2026-11-05T10:00");
  registeredOn("2026-11-03T09:00");
  await studentService.confirmStudent(T, "p1");
  sessionStudentId = "p1";

  // Activities: the class-level initial-payment restriction, unchanged.
  await assert.rejects(access.assertContentAccessForStudent("p1", { lectureId: "lec-a" }), (error) => {
    assert.equal(error.code, "CLASS_ACCESS_RESTRICTED");
    assert.equal(error.details.restrictions[0].reason, "INITIAL_PAYMENT");
    assert.match(error.message, /first class fee payment is confirmed/);
    return true;
  });
  // The lecture page opens with its assignments held back; its resources of
  // the unpaid initial month are locked per month (tests/class-access/resource-access.test.cjs).
  const res = await lectureRoute.GET(new Request("http://localhost/api/student/lectures/lec-a"), { params: { lectureId: "lec-a" } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.lecture.assignmentsRestricted, true);

  const list = await studentPaymentsRoute.GET(new Request("http://localhost/api/student/payments"));
  assert.equal(list.status, 200);
  const dashboard = await dashboardPaymentsRoute.GET(new Request("http://localhost/api/student/dashboard/payments"));
  assert.equal(dashboard.status, 200);
});
