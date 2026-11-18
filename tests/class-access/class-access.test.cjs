/*
 * Payment-due LMS access control (services/class-access-service.ts): the
 * eligibility rule, per-class isolation, automatic restoration, the teacher
 * settings API, direct API requests to protected routes, and that payments
 * stay reachable. Real services and routes, in-memory database
 * (tests/fee-waiver/helpers/fake-db.cjs) plus small fakes for the content
 * models it does not model. No network, no email.
 *
 *   npm run test:class-access
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

// Content models the fake database does not model: id → class (by lecture).
const content = { quiz: new Map(), assignment: new Map(), recordedLecture: new Map(), classPaper: new Map(), materialBundle: new Map(), classSession: new Map() };
const byLecture = (lectureId) => ({ lecture: { classId: db.row("Lecture", lectureId)?.classId } });
const contentDelegates = {
  quiz: { findUnique: async ({ where }) => (content.quiz.has(where.id) ? byLecture(content.quiz.get(where.id)) : null) },
  assignment: { findUnique: async ({ where }) => (content.assignment.has(where.id) ? byLecture(content.assignment.get(where.id)) : null) },
  recordedLecture: { findUnique: async ({ where }) => (content.recordedLecture.has(where.id) ? { classId: content.recordedLecture.get(where.id) } : null) },
  classPaper: { findUnique: async ({ where }) => (content.classPaper.has(where.id) ? { classId: content.classPaper.get(where.id) } : null) },
  materialBundle: { findUnique: async ({ where }) => (content.materialBundle.has(where.id) ? { classId: content.materialBundle.get(where.id) } : null) },
  classSession: { findUnique: async ({ where }) => (content.classSession.has(where.id) ? { classId: content.classSession.get(where.id) } : null) },
};
const client = new Proxy(db.client, {
  get(target, prop) {
    if (prop in contentDelegates) return contentDelegates[prop];
    return target[prop];
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
  requireAppSession: async () => ({ role: "STUDENT", userId: sessionStudentId }),
  getOptionalSession: async () => null,
  requireAdminSession: async () => {
    throw new Error("not used");
  },
});

const access = require(path.join(root, "services", "class-access-service.ts"));
const settingsRoute = require(path.join(root, "app", "api", "classes", "[id]", "payment-access", "route.ts"));
const lectureRoute = require(path.join(root, "app", "api", "student", "lectures", "[lectureId]", "route.ts"));
const quizRoute = require(path.join(root, "app", "api", "student", "quizzes", "[quizId]", "route.ts"));
const recordingStreamRoute = require(path.join(root, "app", "api", "student", "recorded-lectures", "[recordingId]", "stream", "route.ts"));
const assignmentSubmitRoute = require(path.join(root, "app", "api", "assignments", "[assignmentId]", "submit", "route.ts"));
const paperFileRoute = require(path.join(root, "app", "api", "class-papers", "[paperId]", "file", "route.ts"));
const bundleFileRoute = require(path.join(root, "app", "api", "students", "me", "material-bundles", "[bundleId]", "items", "[itemId]", "file", "route.ts"));
const studentPaymentsRoute = require(path.join(root, "app", "api", "student", "payments", "route.ts"));

// Sri Lankan wall clock → the real instant (for the mocked clock).
const sl = (wall) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60 * 1000);
const at = (t, wall) => t.mock.timers.enable({ apis: ["Date"], now: sl(wall) });
// Stored due dates: Sri Lankan digits, end of the due day (computeDueDate).
const dueDigits = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));

const T = "teacher-1";
const A = "class-a"; // restricted, 5 grace days
const B = "class-b"; // restriction off
const C = "class-c"; // restricted, 0 grace days

function seed() {
  db.reset();
  for (const map of Object.values(content)) map.clear();
  const cls = (id, name, restrict, grace) =>
    db.insert("Class", { id, teacherId: T, status: 0, name, monthlyFee: 2000, paymentDueWeek: 2, schedule: "TBD", restrictUnpaidStudentAccess: restrict, paymentGracePeriodDays: grace, teacher: { name: "Teacher" } });
  cls(A, "Combined Maths", true, 5);
  cls(B, "Physics", false, 5);
  cls(C, "Chemistry", true, 0);
  db.insert("Student", { id: "s1", name: "Nimal", teacherId: T, status: 0 });
  db.insert("Student", { id: "s2", name: "Kavindi", teacherId: T, status: 0 });
  for (const [id, classId, studentId] of [["e-a1", A, "s1"], ["e-b1", B, "s1"], ["e-c1", C, "s1"], ["e-a2", A, "s2"]]) {
    db.insert("ClassStudent", { id, classId, studentId, isActive: true, assignedAt: dueDigits(2026, 10, 1), removedAt: null });
  }
  db.insert("Lecture", { id: "lec-a", classId: A, title: "A1", status: 0 });
  db.insert("Lecture", { id: "lec-b", classId: B, title: "B1", status: 0 });
}

let feeSeq = 0;
function fee(classStudentId, over = {}) {
  feeSeq += 1;
  const amount = over.amount ?? 2000;
  return db.insert("ClassStudentFee", {
    id: `fee-${feeSeq}`,
    classStudentId,
    year: 2026,
    month: 11,
    amount,
    discount: 0,
    lateJoinDeduct: 0,
    waiverAmount: 0,
    finalAmount: amount,
    dueDate: dueDigits(2026, 11, 10),
    status: 0,
    ...over,
  });
}
const pay = (feeId, status) =>
  db.insert("ClassPayment", { classStudentFeeId: feeId, classId: A, studentId: "s1", amount: 2000, status, submittedAt: new Date() });

const restrictedClasses = async (studentId = "s1") => [...new Set((await access.getClassAccessRestrictions(studentId)).map((r) => r.classId))].sort();

async function rejectsRestricted(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "CLASS_ACCESS_RESTRICTED");
    assert.equal(error.statusCode, 403);
    return true;
  });
}

// ---- The rule ------------------------------------------------------------------------------

test("grace period example: due 10 Nov + 5 days → open through 15 Nov, restricted from 16 Nov (Sri Lanka time)", () => {
  const due = dueDigits(2026, 11, 10);
  const unpaid = { finalAmount: 2000, freeCard: false, dueDate: due, paymentCount: 0 };
  const nowDigits = (wall) => new Date(`${wall}:00.000Z`); // nowInSriLanka() digits
  assert.equal(access.feeRestrictsAccess(unpaid, 5, nowDigits("2026-11-10T12:00")), false, "before the due date ends");
  assert.equal(access.feeRestrictsAccess(unpaid, 5, nowDigits("2026-11-13T09:00")), false, "within grace");
  assert.equal(access.feeRestrictsAccess(unpaid, 5, nowDigits("2026-11-15T23:59")), false, "last minute of grace");
  assert.equal(access.feeRestrictsAccess(unpaid, 5, nowDigits("2026-11-16T00:00")), true, "16 Nov");
  assert.equal(access.feeRestrictsAccess(unpaid, 0, nowDigits("2026-11-11T00:00")), true, "0 grace days: the day after");
  // Never restricting: paid / submitted, Free Card, zero payable, no due date.
  const late = nowDigits("2026-12-31T00:00");
  assert.equal(access.feeRestrictsAccess({ ...unpaid, paymentCount: 1 }, 5, late), false);
  assert.equal(access.feeRestrictsAccess({ ...unpaid, freeCard: true }, 5, late), false);
  assert.equal(access.feeRestrictsAccess({ ...unpaid, finalAmount: 0 }, 5, late), false);
  assert.equal(access.feeRestrictsAccess({ ...unpaid, dueDate: null }, 5, late), false);
});

test("disabled / before due / within grace: not restricted; grace expired with no payment: restricted", async (t) => {
  seed();
  fee("e-a1"); // class A (on, 5 days)
  fee("e-b1"); // class B (off)

  at(t, "2026-11-08T10:00");
  assert.deepEqual(await restrictedClasses(), [], "before the due date");
  t.mock.timers.reset();
  at(t, "2026-11-14T10:00");
  assert.deepEqual(await restrictedClasses(), [], "within the grace period");
  t.mock.timers.reset();
  at(t, "2026-11-16T08:00");
  assert.deepEqual(await restrictedClasses(), [A], "grace expired: A only; B has the restriction off");

  const [r] = await access.getClassAccessRestrictions("s1");
  assert.equal(r.className, "Combined Maths");
  assert.equal(r.year, 2026);
  assert.equal(r.month, 11);
  assert.equal(r.outstandingAmount, 2000);
  assert.equal(r.dueDate, "2026-11-10T23:59:59.999Z");
  assert.equal(r.graceEndsAt, "2026-11-15T23:59:59.999Z");
  assert.equal(r.gracePeriodDays, 5);
});

test("PENDING, NEEDS_CLARIFICATION, CONFIRMED, Free Card, zero payable and no fee never restrict", async (t) => {
  seed();
  at(t, "2026-12-20T10:00");
  const cases = [
    ["PENDING", (f) => pay(f.id, "PENDING")],
    ["NEEDS_CLARIFICATION", (f) => pay(f.id, "NEEDS_CLARIFICATION")],
    ["CONFIRMED", (f) => pay(f.id, "CONFIRMED")],
  ];
  for (const [label, act] of cases) {
    db.tables.ClassStudentFee.length = 0;
    db.tables.ClassPayment.length = 0;
    act(fee("e-a1"));
    assert.deepEqual(await restrictedClasses(), [], label);
  }
  db.tables.ClassStudentFee.length = 0;
  fee("e-a1", { freeCard: true, finalAmount: 0, freeCardIssuedAt: new Date(), freeCardIssuedByTeacherId: T });
  assert.deepEqual(await restrictedClasses(), [], "Free Card");
  db.tables.ClassStudentFee.length = 0;
  fee("e-a1", { discount: 2000, finalAmount: 0 });
  assert.deepEqual(await restrictedClasses(), [], "zero payable");
  db.tables.ClassStudentFee.length = 0;
  assert.deepEqual(await restrictedClasses(), [], "no fee record");
});

test("any overdue month of the ACTIVE enrolment counts; a removed enrolment's fee does not", async (t) => {
  seed();
  at(t, "2026-12-20T10:00");
  fee("e-a1", { month: 10, dueDate: dueDigits(2026, 10, 14) }); // October, overdue
  fee("e-a1", { month: 12, dueDate: dueDigits(2026, 12, 14) }); // December, overdue since 20 Dec 00:00
  const restrictions = await access.getClassAccessRestrictions("s1");
  assert.deepEqual(restrictions.map((r) => [r.classId, r.month]), [[A, 10], [A, 12]], "oldest month first");

  db.row("ClassStudent", "e-a1").isActive = false;
  assert.deepEqual(await restrictedClasses(), [], "inactive enrolment never restricts");
});

test("each class decides alone: one restricted class never blocks another or another student", async (t) => {
  seed();
  at(t, "2026-11-12T10:00");
  fee("e-a1"); // A: 5 grace days, still within grace on 12 Nov
  fee("e-c1"); // C: 0 grace days, restricted from 11 Nov
  fee("e-b1"); // B: off
  fee("e-a2", { dueDate: dueDigits(2026, 11, 10) }); // s2 in A, within grace
  assert.deepEqual(await restrictedClasses(), [C]);
  await rejectsRestricted(access.assertClassAccessForStudent("s1", C));
  await access.assertClassAccessForStudent("s1", A);
  await access.assertClassAccessForStudent("s1", B);
  assert.deepEqual(await restrictedClasses("s2"), []);
  assert.deepEqual([...(await access.filterAccessibleClassIds("s1", [A, B, C]))].sort(), [A, B]);
});

test("access returns automatically: a slip, a Free Card, a zero adjustment or switching the setting off", async (t) => {
  seed();
  at(t, "2026-11-20T10:00");
  const reset = () => {
    db.tables.ClassStudentFee.length = 0;
    db.tables.ClassPayment.length = 0;
    return fee("e-a1");
  };

  let f = reset();
  assert.deepEqual(await restrictedClasses(), [A]);
  pay(f.id, "PENDING");
  assert.deepEqual(await restrictedClasses(), [], "slip submitted");

  f = reset();
  db.touch("ClassStudentFee", f.id, { freeCard: true, finalAmount: 0, freeCardIssuedAt: new Date(), freeCardIssuedByTeacherId: T });
  assert.deepEqual(await restrictedClasses(), [], "Free Card issued");

  f = reset();
  db.touch("ClassStudentFee", f.id, { waiverAmount: 2000, finalAmount: 0 });
  assert.deepEqual(await restrictedClasses(), [], "adjusted to zero");

  reset();
  db.row("Class", A).restrictUnpaidStudentAccess = false;
  assert.deepEqual(await restrictedClasses(), [], "teacher disabled the restriction");
});

// ---- Teacher settings API -------------------------------------------------------------------

test("settings API: defaults, validation, ownership and saving", async () => {
  seed();
  sessionTeacherId = T;
  const req = (method, body, raw) =>
    new Request(`http://localhost/api/classes/${A}/payment-access`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(method === "GET" ? {} : { body: raw ?? JSON.stringify(body) }),
    });

  const got = await (await settingsRoute.GET(req("GET"), { params: { id: B } })).json();
  assert.deepEqual(got.data, { restrictUnpaidStudentAccess: false, paymentGracePeriodDays: 5 });

  for (const body of [
    { restrictUnpaidStudentAccess: "yes", paymentGracePeriodDays: 5 },
    { restrictUnpaidStudentAccess: true, paymentGracePeriodDays: 31 },
    { restrictUnpaidStudentAccess: true, paymentGracePeriodDays: -1 },
    { restrictUnpaidStudentAccess: true, paymentGracePeriodDays: 2.5 },
    { restrictUnpaidStudentAccess: true },
  ]) {
    const res = await settingsRoute.PUT(req("PUT", body), { params: { id: B } });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await settingsRoute.PUT(req("PUT", null, "{bad"), { params: { id: B } })).status, 400);
  assert.equal(db.row("Class", B).restrictUnpaidStudentAccess, false, "nothing saved");

  const saved = await settingsRoute.PUT(req("PUT", { restrictUnpaidStudentAccess: true, paymentGracePeriodDays: 0 }), { params: { id: B } });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).data, { restrictUnpaidStudentAccess: true, paymentGracePeriodDays: 0 });
  assert.equal(db.row("Class", B).paymentGracePeriodDays, 0);
  assert.equal(db.row("Class", A).paymentGracePeriodDays, 5, "other classes untouched");

  sessionTeacherId = "teacher-2";
  assert.equal((await settingsRoute.GET(req("GET"), { params: { id: B } })).status, 404);
  assert.equal(
    (await settingsRoute.PUT(req("PUT", { restrictUnpaidStudentAccess: false, paymentGracePeriodDays: 5 }), { params: { id: B } })).status,
    404
  );
  assert.equal(db.row("Class", B).restrictUnpaidStudentAccess, true, "another teacher cannot change it");
  sessionTeacherId = T;
});

// ---- Direct API requests ----------------------------------------------------------------------

test("direct API requests to protected content of a restricted class get 403 with the explanation", async (t) => {
  seed();
  at(t, "2026-11-20T10:00");
  sessionStudentId = "s1";
  fee("e-a1");
  content.quiz.set("quiz-a", "lec-a");
  content.recordedLecture.set("rec-a", A);
  content.assignment.set("asg-a", "lec-a");
  content.classPaper.set("paper-a", A);
  content.materialBundle.set("bundle-a", A);

  const expect403 = async (promise, label) => {
    const res = await promise;
    assert.equal(res.status, 403, label);
    const body = await res.json();
    assert.equal(body.error.code, "CLASS_ACCESS_RESTRICTED", label);
    assert.equal(body.error.details.restrictions[0].classId, A, label);
    assert.match(body.error.message, /Combined Maths/, label);
  };
  const get = (url) => new Request(`http://localhost${url}`);

  await expect403(lectureRoute.GET(get("/api/student/lectures/lec-a"), { params: { lectureId: "lec-a" } }), "lecture");
  await expect403(quizRoute.GET(get("/api/student/quizzes/quiz-a"), { params: { quizId: "quiz-a" } }), "quiz");
  await expect403(recordingStreamRoute.GET(get("/api/student/recorded-lectures/rec-a/stream"), { params: { recordingId: "rec-a" } }), "recording stream");
  await expect403(assignmentSubmitRoute.GET(get("/api/assignments/asg-a/submit"), { params: { assignmentId: "asg-a" } }), "assignment");
  await expect403(paperFileRoute.GET(get("/api/class-papers/paper-a/file"), { params: { paperId: "paper-a" } }), "paper file");
  await expect403(
    bundleFileRoute.GET(get("/api/students/me/material-bundles/bundle-a/items/i1/file"), { params: { bundleId: "bundle-a", itemId: "i1" } }),
    "material file"
  );

  // The same student's other class, and every content type resolving to it, is not restricted.
  content.quiz.set("quiz-b", "lec-b");
  await access.assertContentAccessForStudent("s1", { lectureId: "lec-b" });
  await access.assertContentAccessForStudent("s1", { quizId: "quiz-b" });
  await access.assertContentAccessForStudent("s1", { classId: B });
  // A live session resolves to its class (join, attendance): restricted in A, open in B.
  content.classSession.set("sess-a", A);
  content.classSession.set("sess-b", B);
  await rejectsRestricted(access.assertContentAccessForStudent("s1", { sessionId: "sess-a" }));
  await access.assertContentAccessForStudent("s1", { sessionId: "sess-b" });
  // Unknown content is left to the route's own 404.
  await access.assertContentAccessForStudent("s1", { quizId: "missing" });
  // Another student of the restricted class (nothing overdue) is not affected.
  await access.assertContentAccessForStudent("s2", { lectureId: "lec-a" });
});

test("payments stay available to a restricted student: list and slip submission", async (t) => {
  seed();
  at(t, "2026-11-20T10:00");
  sessionStudentId = "s1";
  const f = fee("e-a1");
  assert.deepEqual(await restrictedClasses(), [A]);

  const list = await studentPaymentsRoute.GET(new Request("http://localhost/api/student/payments"));
  assert.equal(list.status, 200);
  assert.ok((await list.json()).data.toPay.some((item) => item.feeId === f.id));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "class-access-"));
  const previous = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const form = new FormData();
  form.set("feeId", f.id);
  form.set("slip", new File([Buffer.from("%PDF-1.4")], "slip.pdf", { type: "application/pdf" }));
  const res = await studentPaymentsRoute.POST(new Request("http://localhost/api/student/payments", { method: "POST", body: form }));
  assert.equal(res.status, 201);

  // (Listing payments generated class C's November fee: C, 0 grace days, is restricted on its own.)
  assert.ok(!(await restrictedClasses()).includes(A), "the submitted slip restores access to A immediately");
});

// ---- Enforcement wiring (paths without a runnable fake) ------------------------------------------

test("classroom, breakout and whiteboard entry points check access after their enrolment check", () => {
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const session = read("services/session-service.ts");
  assert.match(session, /requireApproved: true,\s*\}\);\s*\/\/[^\n]*\n[^\n]*\n\s*await assertClassAccessForStudent\(student\.id, session\.classId\);\s*const jitsiToken/);
  assert.match(
    session,
    /export async function markStudentJoinedSession[\s\S]{0,500}await assertContentAccessForStudent\(student\.studentId, \{ sessionId \}\);\s*\/\/[^\n]*\n\s*return markAttendanceOnJoin/
  );
  const breakout = read("lib/breakout-activities/student-access.ts");
  assert.match(breakout, /if \(!\(await isEnrolled\(db, studentId, session\.classId\)\)\) throw notFound\(\);\s*(\/\/[^\n]*\n\s*)+await assertClassAccessForStudent\(studentId, session\.classId\);\s*return \{ sessionId/);
  const whiteboard = read("services/lecture-whiteboard-service.ts");
  assert.match(whiteboard, /Active lecture session not found[\s\S]{0,200}await assertClassAccessForStudent\(studentId, session\.classId\);/);
  // Every protected student content / action route makes the check.
  const routes = [
    "app/api/student/lectures/[lectureId]/route.ts",
    "app/api/student/lectures/[lectureId]/notes/route.ts",
    "app/api/student/lectures/[lectureId]/notes/[noteId]/file/route.ts",
    "app/api/student/lectures/[lectureId]/whiteboards/route.ts",
    "app/api/student/lectures/[lectureId]/whiteboards/[whiteboardId]/route.ts",
    "app/api/student/recorded-lectures/[recordingId]/route.ts",
    "app/api/student/recorded-lectures/[recordingId]/stream/route.ts",
    "app/api/student/quizzes/[quizId]/route.ts",
    "app/api/student/quizzes/[quizId]/review/route.ts",
    "app/api/student/quizzes/[quizId]/submit/route.ts",
    "app/api/student/papers/[paperId]/submit/route.ts",
    "app/api/class-papers/[paperId]/file/route.ts",
    "app/api/assignments/[assignmentId]/submit/route.ts",
    "app/api/assignments/[assignmentId]/submit/file/route.ts",
    "app/api/material-bundles/[bundleId]/items/[itemId]/submit/route.ts",
    "app/api/students/me/material-bundles/[bundleId]/confirm/route.ts",
    "app/api/attendance/route.ts",
    "app/api/students/me/material-bundles/[bundleId]/items/[itemId]/file/route.ts",
    "app/api/students/me/material-bundles/[bundleId]/items/[itemId]/late-message/route.ts",
  ];
  for (const rel of routes) assert.match(read(rel), /await assertContentAccessForStudent\(/, rel);
  assert.equal((read("app/api/assignments/[assignmentId]/submit/route.ts").match(/await assertContentAccessForStudent\(/g) ?? []).length, 2, "GET and POST");
  // Payment routes are never restricted.
  for (const rel of ["app/api/student/payments/route.ts", "app/api/payments/[paymentId]/slip/route.ts", "app/api/student/dashboard/payments/route.ts"]) {
    assert.doesNotMatch(read(rel), /assertContentAccessForStudent|assertClassAccessForStudent/, rel);
  }
});
