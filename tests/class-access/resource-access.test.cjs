/*
 * Monthly payment-based resource access (services/resource-access-service.ts):
 * recordings, notes, papers, bundle files, whiteboards and YouTube recording
 * links are locked per Sri Lankan billing month, with teacher overrides
 * (GRANTED / REVOKED / DEFAULT) from the Payments page.
 *
 *   npm run test:class-access
 *
 * Real services and routes; in-memory database
 * (tests/fee-waiver/helpers/fake-db.cjs); mocked clock. No network, no real
 * database, no files.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { createFakeDb } = require("../fee-waiver/helpers/fake-db.cjs");

const ORIGIN = "https://slclassroom.live";
process.env.NEXT_PUBLIC_APP_URL = ORIGIN;

const db = createFakeDb();

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

// Session: null (visitor) | { role, userId }.
let session = null;
const as = {
  visitor: () => (session = null),
  teacher: (id) => (session = { role: "TEACHER", userId: id }),
  student: (id) => (session = { role: "STUDENT", userId: id }),
  admin: () => (session = { role: "ADMIN", userId: "admin-1" }),
};
class AuthError extends Error {}
function appError(message, status, code) {
  const { AppError } = require(path.join(root, "lib", "error-handler.ts"));
  return new AppError(message, status, code);
}
fake("lib/prisma.ts", { prisma: db.client });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    if (!session || session.role !== "TEACHER") throw appError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { role: "TEACHER", teacherId: session.userId };
  },
  requireTeacherSessionForbiddingOtherRoles: async () => {
    if (!session) throw appError("Authentication required.", 401, "UNAUTHORIZED");
    if (session.role !== "TEACHER") throw appError("Only the teacher who owns this profile can do this.", 403, "FORBIDDEN");
    return { role: "TEACHER", teacherId: session.userId };
  },
  requireStudentSession: async () => {
    if (!session || session.role !== "STUDENT") throw appError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { role: "STUDENT", studentId: session.userId };
  },
  requireAppSession: async () => {
    if (!session) throw appError("Authentication required.", 401, "UNAUTHORIZED");
    return { role: session.role, userId: session.userId };
  },
  getOptionalSession: async () => null,
  requireAdminSession: async () => {
    throw new AuthError("not used");
  },
});
// Playback itself (files, stream slots) is not under test: the gate before it is.
let streamed = 0;
fake("services/recorded-lecture-stream-service.ts", {
  STREAM_LIMIT_CODES: new Set(),
  STREAM_RETRY_AFTER_SECONDS: 5,
  streamStudentRecordedLecture: async () => {
    streamed += 1;
    return new Response("video", { status: 200 });
  },
});
// The paper file itself: "not found" once the gate lets the request through.
fake("services/class-paper-service.ts", { getPaperFileForViewer: async () => null });

const RA = require(path.join(root, "services", "resource-access-service.ts"));
const { buildStudentRecordedLectureDto } = require(path.join(root, "lib", "recorded-lectures", "student-dto.ts"));
const streamRoute = require(path.join(root, "app", "api", "student", "recorded-lectures", "[recordingId]", "stream", "route.ts"));
const paperFileRoute = require(path.join(root, "app", "api", "class-papers", "[paperId]", "file", "route.ts"));
const noteFileRoute = require(path.join(root, "app", "api", "student", "lectures", "[lectureId]", "notes", "[noteId]", "file", "route.ts"));
const bundleFileRoute = require(path.join(root, "app", "api", "students", "me", "material-bundles", "[bundleId]", "items", "[itemId]", "file", "route.ts"));
const lectureRoute = require(path.join(root, "app", "api", "student", "lectures", "[lectureId]", "route.ts"));
const notesRoute = require(path.join(root, "app", "api", "student", "lectures", "[lectureId]", "notes", "route.ts"));
const overrideRoute = require(path.join(root, "app", "api", "classes", "[id]", "resource-access", "route.ts"));

// ---- Clock and dates --------------------------------------------------------------------
// Sri Lankan wall clock "YYYY-MM-DDTHH:mm" -> the real instant (UTC+05:30).
const sl = (wall) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60 * 1000);
const at = (t, wall) => t.mock.timers.enable({ apis: ["Date"], now: sl(wall) });
// Stored due dates: Sri Lankan wall-clock digits, end of the due day.
const dueDigits = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));
const NOV = { year: 2026, month: 11 };
const OCT = { year: 2026, month: 10 };
const SEP = { year: 2026, month: 9 };
const AUG = { year: 2026, month: 8 };

// ---- Data -------------------------------------------------------------------------------
const T = "teacher-1";
const T2 = "teacher-2";
const A = "class-a"; // restriction ON, 5 grace days
const B = "class-b"; // restriction OFF
const C = "class-c"; // restriction ON, 0 grace days
const X = "class-x"; // another teacher's class

function seed() {
  db.reset();
  streamed = 0;
  const cls = (id, teacherId, name, restrict, grace) =>
    db.insert("Class", { id, teacherId, status: 0, name, monthlyFee: 2000, paymentDueWeek: 2, restrictUnpaidStudentAccess: restrict, paymentGracePeriodDays: grace });
  cls(A, T, "Combined Maths", true, 5);
  cls(B, T, "Physics", false, 5);
  cls(C, T, "Chemistry", true, 0);
  cls(X, T2, "Biology", true, 5);
  for (const c of [A, B, C, X]) db.insert("Lecture", { id: `lec-${c}`, classId: c, title: c, status: 0, date: sl("2026-11-05T16:00") });
}

function student(id, over = {}) {
  return db.insert("Student", {
    id,
    name: `Student ${id}`,
    teacherId: T,
    status: 0,
    registrationNumber: id.toUpperCase(),
    registrationSource: "TEACHER",
    publicClassId: null,
    confirmationStatus: "APPROVED",
    approvedAt: null,
    ...over,
  });
}
function enrol(studentId, classId, assignedWall, over = {}) {
  return db.insert("ClassStudent", { id: `cs-${studentId}-${classId}`, studentId, classId, isActive: true, assignedAt: sl(assignedWall), ...over });
}
function fee(classStudentId, { year, month }, over = {}) {
  return db.insert("ClassStudentFee", {
    id: `fee-${classStudentId}-${year}-${month}`,
    classStudentId,
    year,
    month,
    amount: 2000,
    finalAmount: 2000,
    dueDate: dueDigits(year, month, 14),
    ...over,
  });
}
function pay(feeRow, amount, status = "CONFIRMED") {
  const cs = db.row("ClassStudent", feeRow.classStudentId);
  return db.insert("ClassPayment", { classStudentFeeId: feeRow.id, classId: cs.classId, studentId: cs.studentId, amount, status });
}
// Resources, uploaded at a Sri Lankan wall-clock time.
const recording = (id, classId, wall) => db.insert("RecordedLecture", { id, classId, lectureId: `lec-${classId}`, createdAt: sl(wall), status: 0 });
const note = (id, classId, uploadedWall) =>
  db.insert("Note", { id, lectureId: `lec-${classId}`, title: id, kind: "NOTE", mimeType: "application/pdf", sizeBytes: 10, status: 0, uploadedAt: uploadedWall ? sl(uploadedWall) : null, fileUrl: "x", storageKey: null });
const paper = (id, classId, wall) => db.insert("ClassPaper", { id, classId, createdAt: sl(wall), status: 0 });
const bundle = (id, classId, { year, month }) => db.insert("MaterialBundle", { id, classId, year, month, status: 0, bundleStatus: "SENT" });

/** The usual student: s1 in A (since 3 Sep), B and C (since 3 Sep). */
function baseStudent() {
  student("s1");
  const a = enrol("s1", A, "2026-09-03T10:00");
  const b = enrol("s1", B, "2026-09-03T10:00");
  const c = enrol("s1", C, "2026-09-03T10:00");
  return { a, b, c };
}

async function decide(studentId, classId, month) {
  const access = await RA.loadStudentResourceAccess(studentId);
  return access.decide(classId, month);
}

function jsonRequest(url, method = "GET", body, headers = {}) {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function errorCode(response) {
  return (await response.clone().json().catch(() => ({})))?.error?.code;
}

// Counts every query the services make (prisma delegate calls).
function countQueries() {
  const counts = { total: 0 };
  const restore = [];
  for (const [prop, delegate] of Object.entries(db.client)) {
    if (!delegate || typeof delegate !== "object") continue;
    for (const method of ["findMany", "findFirst", "findUnique", "count", "upsert", "deleteMany", "create", "update", "updateMany"]) {
      const original = delegate[method];
      if (typeof original !== "function") continue;
      delegate[method] = async (...args) => {
        counts.total += 1;
        counts[`${prop}.${method}`] = (counts[`${prop}.${method}`] ?? 0) + 1;
        return original(...args);
      };
      restore.push(() => (delegate[method] = original));
    }
  }
  return { counts, restore: () => restore.forEach((r) => r()) };
}

// ---- 1-11: the automatic (DEFAULT) rule ----------------------------------------------

test("1. first login without payment (public registration): the approval month is locked at once, no grace; earlier months are pre-enrolment", async (t) => {
  seed();
  at(t, "2026-11-03T09:00"); // before the due date (14 Nov): an initial payment still locks
  student("p1", { registrationSource: "PUBLIC_CLASS", publicClassId: A, approvedAt: sl("2026-11-02T10:00") });
  const cs = enrol("p1", A, "2026-11-01T10:00");
  const novFee = fee(cs.id, NOV);

  let d = await decide("p1", A, NOV);
  assert.equal(d.accessible, false);
  assert.equal(d.source, "INITIAL_PAYMENT");
  assert.equal(d.fee.initialPayment, true);
  assert.equal(d.fee.graceActive, false, "no grace period for the first payment");
  assert.equal((await decide("p1", A, OCT)).source, "PRE_ENROLMENT");

  pay(novFee, 2000, "PENDING");
  assert.equal((await decide("p1", A, NOV)).accessible, false, "a slip awaiting the teacher does not unlock");
  db.row("ClassPayment", db.tables.ClassPayment[0].id).status = "CONFIRMED";
  d = await decide("p1", A, NOV);
  assert.equal(d.accessible, true);
  assert.equal(d.source, "PAID");
});

test("2. a paid month is open; 7. a confirmed full payment unlocks a locked month immediately", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  const { a } = baseStudent();
  pay(fee(a.id, SEP), 2000);
  const oct = fee(a.id, OCT);
  assert.equal((await decide("s1", A, SEP)).source, "PAID");
  assert.equal((await decide("s1", A, OCT)).accessible, false);
  pay(oct, 2000);
  const d = await decide("s1", A, OCT);
  assert.equal(d.accessible, true);
  assert.equal(d.fee.paymentStatus, "PAID");
  assert.equal(d.fee.confirmedTotal, 2000);
});

test("3. unpaid within the grace period is open; 4. after it, locked (due 14 Nov + 5 days: open through 19 Nov)", async (t) => {
  seed();
  const { a } = baseStudent();
  fee(a.id, NOV);
  at(t, "2026-11-19T23:00");
  let d = await decide("s1", A, NOV);
  assert.equal(d.accessible, true);
  assert.equal(d.source, "GRACE");
  assert.equal(d.fee.graceActive, true);
  t.mock.timers.reset();
  at(t, "2026-11-20T00:01");
  d = await decide("s1", A, NOV);
  assert.equal(d.accessible, false);
  assert.equal(d.source, "UNPAID");
  assert.equal(d.fee.graceActive, false);
  assert.equal(d.fee.outstanding, 2000);
});

test("5. a partial payment stays locked after the grace period while a balance remains; 6. a pending slip never unlocks", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  const { a } = baseStudent();
  const oct = fee(a.id, OCT);
  pay(oct, 1500);
  let d = await decide("s1", A, OCT);
  assert.equal(d.accessible, false);
  assert.equal(d.fee.paymentStatus, "PARTIAL");
  assert.equal(d.fee.outstanding, 500);
  pay(oct, 500, "PENDING");
  d = await decide("s1", A, OCT);
  assert.equal(d.accessible, false, "the slip for the balance awaits the teacher");
  assert.equal(d.fee.awaitingTotal, 500);
  pay(oct, 500, "NEEDS_CLARIFICATION");
  assert.equal((await decide("s1", A, OCT)).accessible, false);
});

test("8. a payment reversal locks the month again (the reversed money no longer counts)", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  const { a } = baseStudent();
  const oct = fee(a.id, OCT);
  const payment = pay(oct, 2000);
  assert.equal((await decide("s1", A, OCT)).accessible, true);
  db.insert("ClassPaymentReversal", { paymentId: payment.id, amount: 2000, reason: "bounced", reversedByRole: "TEACHER", reversedById: T });
  const d = await decide("s1", A, OCT);
  assert.equal(d.accessible, false);
  assert.equal(d.source, "UNPAID");
  assert.equal(d.fee.confirmedTotal, 0);
});

test("9. a full fee waiver and 10. a Free Card open the month through the existing fee calculation", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  const { a } = baseStudent();
  fee(a.id, OCT, { waiverAmount: 2000, finalAmount: 0 });
  fee(a.id, SEP, { freeCard: true, finalAmount: 0 });
  assert.equal((await decide("s1", A, OCT)).source, "PAID");
  const d = await decide("s1", A, SEP);
  assert.equal(d.source, "PAID");
  assert.equal(d.fee.paymentStatus, "FREE_CARD");
});

test("11. months before the student's first enrolment are locked (unless granted); an enrolled month with no fee row stays open", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  baseStudent();
  assert.equal((await decide("s1", A, AUG)).source, "PRE_ENROLMENT");
  assert.equal((await decide("s1", A, AUG)).accessible, false);
  const d = await decide("s1", A, SEP);
  assert.equal(d.source, "NO_FEE", "no fee recorded: the existing 'no fee record, no restriction' rule");
  assert.equal(d.accessible, true);
  // A re-enrolment: the first enrolment month still counts; the old enrolment's paid fee still opens its month.
  db.row("ClassStudent", "cs-s1-class-a").isActive = false;
  const again = enrol("s1", A, "2026-11-10T10:00", { id: "cs-s1-a-2" });
  pay(fee("cs-s1-class-a", OCT), 2000);
  assert.equal((await decide("s1", A, OCT)).source, "PAID", "the earlier enrolment's paid month stays open");
  assert.equal((await decide("s1", A, AUG)).source, "PRE_ENROLMENT");
  assert.equal((await decide("s1", A, NOV)).classStudentId, again.id);
});

// ---- 12-16: overrides and the class setting --------------------------------------------

test("12. GRANTED unlocks, 13. REVOKED locks, 14. DEFAULT restores the automatic rule (teacher route, Payments page)", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  const { a } = baseStudent();
  pay(fee(a.id, SEP), 2000);
  fee(a.id, OCT);
  as.teacher(T);
  const put = (body) => overrideRoute.PUT(jsonRequest(`/api/classes/${A}/resource-access`, "PUT", { studentId: "s1", ...body }), { params: { id: A } });

  let res = await put({ year: 2026, month: 10, access: "GRANTED" });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.data.decision.accessible, true);
  assert.equal(body.data.decision.source, "OVERRIDE_GRANTED");
  assert.equal(body.data.decision.fee.outstanding, 2000, "the payment status is still shown");
  assert.equal((await decide("s1", A, OCT)).accessible, true);

  res = await put({ year: 2026, month: 8, access: "GRANTED" });
  assert.equal((await res.json()).data.decision.accessible, true, "a month before enrolment can be granted");

  res = await put({ year: 2026, month: 9, access: "REVOKED" });
  body = await res.json();
  assert.equal(body.data.decision.accessible, false);
  assert.equal(body.data.decision.source, "OVERRIDE_REVOKED");
  assert.equal((await decide("s1", A, SEP)).accessible, false, "a paid month can be revoked");

  res = await put({ year: 2026, month: 9, access: "REVOKED" });
  assert.equal(res.status, 200, "idempotent");
  assert.equal(db.tables.ClassStudentResourceAccess.length, 3, "one row per enrolment and month");

  res = await put({ year: 2026, month: 9, access: "DEFAULT" });
  body = await res.json();
  assert.equal(body.data.decision.source, "PAID");
  assert.equal(body.data.decision.override, null);
  assert.equal(db.tables.ClassStudentResourceAccess.length, 2, "DEFAULT removes the row");

  res = await overrideRoute.GET(jsonRequest(`/api/classes/${A}/resource-access?studentId=s1&year=2026&month=10`), { params: { id: A } });
  body = await res.json();
  assert.equal(body.data.student.name, "Student s1");
  assert.equal(body.data.class.name, "Combined Maths");
  assert.equal(body.data.decision.override, "GRANTED");
  assert.equal(db.tables.ClassStudentResourceAccess[0].setByTeacherId, T);
});

test("15. class setting off: every month open, pre-enrolment too; a REVOKED month stays locked", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  const { b } = baseStudent();
  fee(b.id, OCT);
  assert.equal((await decide("s1", B, OCT)).source, "SETTING_OFF");
  assert.equal((await decide("s1", B, AUG)).accessible, true);
  db.insert("ClassStudentResourceAccess", { classStudentId: b.id, year: 2026, month: 10, access: "REVOKED", setByTeacherId: T });
  assert.equal((await decide("s1", B, OCT)).accessible, false);
});

test("16. classes keep their own settings; 17. different classes lock different months, and the notice lists only those (paid months never)", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  const { a, b, c } = baseStudent();
  pay(fee(a.id, SEP), 2000);
  fee(a.id, OCT); // A: Oct locked (grace ended 19 Oct)
  fee(a.id, NOV, { dueDate: dueDigits(2026, 11, 21) }); // A: Nov in grace (due 21 Nov, +5)
  fee(b.id, OCT); // B: restriction off
  pay(fee(c.id, OCT), 2000); // C: Oct paid
  fee(c.id, SEP); // C: Sep locked (0 grace)

  const access = await RA.loadStudentResourceAccess("s1");
  assert.equal(access.decide(A, OCT).accessible, false);
  assert.equal(access.decide(C, OCT).accessible, true, "same month, other class: independent");
  assert.equal(access.decide(C, SEP).accessible, false);
  assert.equal(access.decide(B, OCT).accessible, true);

  const items = access.noticeItems();
  const keys = items.map((i) => `${i.className}:${i.year}-${i.month}:${i.locked ? "locked" : "open"}`);
  assert.deepEqual(keys, ["Chemistry:2026-9:locked", "Combined Maths:2026-10:locked", "Combined Maths:2026-11:open"]);
  const graceItem = items.find((i) => i.month === 11);
  assert.equal(graceItem.graceActive, true);
  assert.equal(graceItem.outstandingAmount, 2000);
  assert.ok(!items.some((i) => i.className === "Physics"), "no notice for a class with the setting off");
  assert.ok(!items.some((i) => i.className === "Combined Maths" && i.month === 9), "a paid month never appears");
});

// ---- 18-22: delivery routes, authorization and months ------------------------------------

test("18. direct recording playback: a locked month is refused (403) before the stream; an open month streams", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  const { a } = baseStudent();
  fee(a.id, OCT);
  pay(fee(a.id, SEP), 2000);
  recording("rec-oct", A, "2026-10-10T10:00");
  recording("rec-sep", A, "2026-09-10T10:00");
  as.student("s1");
  let res = await streamRoute.GET(jsonRequest("/api/student/recorded-lectures/rec-oct/stream"), { params: { recordingId: "rec-oct" } });
  assert.equal(res.status, 403);
  assert.equal(await errorCode(res), "RESOURCE_MONTH_LOCKED");
  assert.match((await res.json()).error.message, /Combined Maths resources from October 2026/);
  assert.equal(streamed, 0);
  res = await streamRoute.HEAD(jsonRequest("/api/student/recorded-lectures/rec-oct/stream", "HEAD"), { params: { recordingId: "rec-oct" } });
  assert.equal(res.status, 403);
  res = await streamRoute.GET(jsonRequest("/api/student/recorded-lectures/rec-sep/stream"), { params: { recordingId: "rec-sep" } });
  assert.equal(res.status, 200, "the paid month plays although October is unpaid");
  assert.equal(streamed, 1);
  // The listing DTO carries no stream path for a locked month.
  const row = { id: "rec-oct", title: "t", partNumber: 1, sizeBytes: BigInt(1), durationSeconds: 1, width: null, height: null, readyAt: null, lecture: { id: "l", title: "L", date: new Date(), endDate: null }, class: { id: A, name: "Combined Maths" } };
  const lockedDto = buildStudentRecordedLectureDto(row, { now: new Date(), dashboardDays: 7, lock: { locked: true, ...OCT } });
  assert.equal(lockedDto.streamUrl, null);
  assert.deepEqual(lockedDto.resourceAccess, { locked: true, year: 2026, month: 10 });
  assert.match(buildStudentRecordedLectureDto(row, { now: new Date(), dashboardDays: 7, lock: { locked: false, ...SEP } }).streamUrl, /\/stream$/);
});

test("19. direct document downloads (paper, note, bundle file): a locked month is 403; an open month reaches the file lookup", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  const { a } = baseStudent();
  fee(a.id, OCT);
  paper("paper-oct", A, "2026-10-02T10:00");
  paper("paper-nov", A, "2026-11-02T10:00");
  note("note-oct", A, "2026-10-02T10:00");
  bundle("bundle-oct", A, OCT);
  bundle("bundle-nov", A, NOV);
  as.student("s1");

  let res = await paperFileRoute.GET(jsonRequest("/api/class-papers/paper-oct/file"), { params: { paperId: "paper-oct" } });
  assert.equal(res.status, 403);
  assert.equal(await errorCode(res), "RESOURCE_MONTH_LOCKED");
  res = await paperFileRoute.GET(jsonRequest("/api/class-papers/paper-nov/file"), { params: { paperId: "paper-nov" } });
  assert.equal(await errorCode(res), "PAPER_NOT_FOUND", "November (no fee yet) passes the gate");

  res = await noteFileRoute.GET(jsonRequest(`/api/student/lectures/lec-${A}/notes/note-oct/file`), { params: { lectureId: `lec-${A}`, noteId: "note-oct" } });
  assert.equal(res.status, 403);
  assert.equal(await errorCode(res), "RESOURCE_MONTH_LOCKED");

  res = await bundleFileRoute.GET(jsonRequest("/api/students/me/material-bundles/bundle-oct/items/i1/file"), { params: { bundleId: "bundle-oct", itemId: "i1" } });
  assert.equal(res.status, 403);
  db.client.materialBundleItem = { findFirst: async () => null }; // the item lookup after the gate
  res = await bundleFileRoute.GET(jsonRequest("/api/students/me/material-bundles/bundle-nov/items/i1/file"), { params: { bundleId: "bundle-nov", itemId: "i1" } });
  assert.equal(await errorCode(res), "FILE_NOT_FOUND", "November passes the gate");
  delete db.client.materialBundleItem;

  // A teacher's own paper preview is never gated.
  as.teacher(T);
  res = await paperFileRoute.GET(jsonRequest("/api/class-papers/paper-oct/file"), { params: { paperId: "paper-oct" } });
  assert.notEqual(await errorCode(res), "RESOURCE_MONTH_LOCKED");

  // Unknown resource / another class: the route's own 404, nothing revealed.
  as.student("s1");
  paper("paper-x", X, "2026-10-02T10:00");
  res = await paperFileRoute.GET(jsonRequest("/api/class-papers/paper-x/file"), { params: { paperId: "paper-x" } });
  assert.equal(await errorCode(res), "PAPER_NOT_FOUND");
});

test("listings: lecture detail marks locked notes and whiteboards and never sends a locked month's YouTube link", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  const { a } = baseStudent();
  fee(a.id, OCT);
  pay(fee(a.id, NOV), 2000);
  note("n-oct", A, "2026-10-20T10:00");
  note("n-nov", A, "2026-11-04T10:00");
  note("n-legacy", A, null); // uploaded before uploadedAt existed: the lecture's date (Nov)
  db.insert("LectureWhiteboard", { id: "wb-oct", lectureId: `lec-${A}`, title: "wb", status: 0, createdAt: sl("2026-10-21T10:00") });
  db.insert("YouTubeRecording", { id: "yt-oct", lectureId: `lec-${A}`, videoId: "SECRETVIDEO", youtubeUrl: "https://youtu.be/SECRETVIDEO", visibility: "PUBLIC", status: "COMPLETED", access: "FREE", startedAt: null, endedAt: null, createdAt: sl("2026-10-22T10:00") });
  db.insert("YouTubeRecording", { id: "yt-nov", lectureId: `lec-${A}`, videoId: "OPENVIDEO", youtubeUrl: "https://youtu.be/OPENVIDEO", visibility: "PUBLIC", status: "COMPLETED", access: "FREE", startedAt: null, endedAt: null, createdAt: sl("2026-11-06T10:00") });
  as.student("s1");

  const res = await notesRoute.GET(jsonRequest(`/api/student/lectures/lec-${A}/notes`), { params: { lectureId: `lec-${A}` } });
  assert.equal(res.status, 200);
  const notes = (await res.json()).data.lecture.notes;
  const byId = Object.fromEntries(notes.map((n) => [n.id, n.resourceAccess]));
  assert.deepEqual(byId["n-oct"], { locked: true, year: 2026, month: 10 });
  assert.deepEqual(byId["n-nov"], { locked: false, year: 2026, month: 11 });
  assert.deepEqual(byId["n-legacy"], { locked: false, year: 2026, month: 11 });

  const detail = await lectureRoute.GET(jsonRequest(`/api/student/lectures/lec-${A}`), { params: { lectureId: `lec-${A}` } });
  assert.equal(detail.status, 200);
  const text = await detail.clone().text();
  assert.ok(!text.includes("SECRETVIDEO"), "a locked month's YouTube link is never sent");
  assert.ok(text.includes("OPENVIDEO"));
  const lecture = (await detail.json()).data.lecture;
  assert.equal(lecture.whiteboards[0].resourceAccess.locked, true);
  assert.equal(lecture.recordings.find((r) => r.id === "yt-oct").videoId, null);
  assert.equal(lecture.recordings.find((r) => r.id === "yt-oct").access, "FREE", "the YouTube access field is unchanged");
});

test("20. override attempts: visitor 401, student and admin 403, another teacher's class 404, unenrolled student 404, cross-site 403, bad input 400; nothing written", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  baseStudent();
  student("s9");
  enrol("s9", X, "2026-09-01T10:00");
  enrol("s9", A, "2026-09-01T10:00", { id: "cs-s9-a-old", isActive: false });
  const put = (classId, body, headers) => overrideRoute.PUT(jsonRequest(`/api/classes/${classId}/resource-access`, "PUT", body, headers), { params: { id: classId } });
  const body = { studentId: "s1", year: 2026, month: 10, access: "GRANTED" };

  as.visitor();
  assert.equal((await put(A, body)).status, 401);
  as.student("s1");
  let res = await put(A, body);
  assert.equal(res.status, 403);
  assert.equal(await errorCode(res), "FORBIDDEN");
  assert.equal((await overrideRoute.GET(jsonRequest(`/api/classes/${A}/resource-access?studentId=s1&year=2026&month=10`), { params: { id: A } })).status, 403);
  as.admin();
  assert.equal((await put(A, body)).status, 403);

  as.teacher(T2);
  res = await put(A, body);
  assert.equal(res.status, 404);
  assert.equal(await errorCode(res), "CLASS_NOT_FOUND");
  as.teacher(T);
  res = await put(X, { ...body, studentId: "s9" });
  assert.equal(await errorCode(res), "CLASS_NOT_FOUND", "the teacher cannot touch another teacher's class");
  res = await put(A, { ...body, studentId: "s9" });
  assert.equal(await errorCode(res), "STUDENT_NOT_ENROLLED", "an inactive enrolment cannot get overrides");
  res = await put(A, body, { "sec-fetch-site": "cross-site", origin: "https://evil.example" });
  assert.equal(res.status, 403);
  assert.equal(await errorCode(res), "CROSS_ORIGIN_REQUEST_REJECTED");
  for (const bad of [{ ...body, access: "OPEN" }, { ...body, month: 13 }, { ...body, year: 1999 }, { ...body, studentId: "" }]) {
    assert.equal((await put(A, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(db.tables.ClassStudentResourceAccess.length, 0, "nothing written");
});

test("21. Sri Lankan month boundaries: 23:59 on the last day is that month, 00:00 on the 1st is the next (UTC+05:30)", () => {
  assert.deepEqual(RA.billingMonthOf(new Date("2026-10-31T18:29:59.999Z")), OCT, "31 Oct 23:59:59.999 in Colombo");
  assert.deepEqual(RA.billingMonthOf(new Date("2026-10-31T18:30:00.000Z")), NOV, "1 Nov 00:00 in Colombo, still 31 Oct in UTC");
  assert.deepEqual(RA.billingMonthOf(new Date("2026-12-31T18:30:00.000Z")), { year: 2027, month: 1 }, "year boundary");
});

test("21b. a resource uploaded just after midnight on 1 Nov (Colombo) belongs to November, not the locked October", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  const { a } = baseStudent();
  fee(a.id, OCT);
  pay(fee(a.id, NOV), 2000);
  recording("rec-edge-oct", A, "2026-10-31T23:59");
  recording("rec-edge-nov", A, "2026-11-01T00:00");
  as.student("s1");
  assert.equal((await streamRoute.GET(jsonRequest("/x"), { params: { recordingId: "rec-edge-oct" } })).status, 403);
  assert.equal((await streamRoute.GET(jsonRequest("/x"), { params: { recordingId: "rec-edge-nov" } })).status, 200);
});

test("22. edits never move a resource's month: title / updatedAt changes are ignored; a note keeps its upload month even if its lecture moves", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  const { a } = baseStudent();
  fee(a.id, OCT);
  pay(fee(a.id, NOV), 2000);
  const n = note("n-edit", A, "2026-10-15T10:00");
  const r = recording("rec-edit", A, "2026-10-15T10:00");
  n.title = "renamed";
  n.updatedAt = sl("2026-11-20T10:00");
  r.title = "renamed";
  r.updatedAt = sl("2026-11-20T10:00");
  db.row("Lecture", `lec-${A}`).date = sl("2026-11-25T10:00");
  assert.deepEqual(await RA.resourceClassMonth({ noteId: "n-edit" }), { classId: A, month: OCT });
  assert.deepEqual(await RA.resourceClassMonth({ recordingId: "rec-edit" }), { classId: A, month: OCT });
  as.student("s1");
  assert.equal((await streamRoute.GET(jsonRequest("/x"), { params: { recordingId: "rec-edit" } })).status, 403);
  // A legacy note (no upload time) follows its lecture's date.
  note("n-legacy", A, null);
  assert.deepEqual(await RA.resourceClassMonth({ noteId: "n-legacy" }), { classId: A, month: NOV });
});

// ---- Performance ---------------------------------------------------------------------------

test("performance: one resolver = 3 batched queries however many resources and months; decisions are memoised", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  const { a, c } = baseStudent();
  for (const m of [SEP, OCT, NOV]) {
    pay(fee(a.id, m), m.month === 10 ? 0 : 2000);
    fee(c.id, m);
  }
  const counter = countQueries();
  try {
    const access = await RA.loadStudentResourceAccess("s1");
    assert.equal(counter.counts.total, 3, JSON.stringify(counter.counts));
    // 300 resources over 3 classes x 3 months: no further query.
    for (let i = 0; i < 300; i += 1) {
      const classId = [A, B, C][i % 3];
      const month = [SEP, OCT, NOV][Math.floor(i / 3) % 3];
      RA.resourceLockFor(access, classId, month);
    }
    access.noticeItems();
    assert.equal(counter.counts.total, 3, "no N+1 query");
    assert.equal(access.decide(A, OCT), access.decide(A, OCT), "memoised: the same decision object");
  } finally {
    counter.restore();
  }
});

test("performance: a delivery check is 4 queries (the resource row + the 3 batched loads, narrowed to its class and month)", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  const { a } = baseStudent();
  for (let m = 1; m <= 11; m += 1) fee(a.id, { year: 2026, month: m });
  recording("rec-q", A, "2026-10-10T10:00");
  const counter = countQueries();
  try {
    await assert.rejects(RA.assertResourceAccessForStudent("s1", { recordingId: "rec-q" }), /October 2026/);
    assert.equal(counter.counts.total, 4, JSON.stringify(counter.counts));
  } finally {
    counter.restore();
  }
  const started = process.hrtime.bigint();
  for (let i = 0; i < 200; i += 1) {
    const access = await RA.loadStudentResourceAccess("s1", { classIds: [A], months: [OCT] });
    access.decide(A, OCT);
  }
  const perCheckMs = Number(process.hrtime.bigint() - started) / 1e6 / 200;
  assert.ok(perCheckMs < 25, `in-memory resolver cost ${perCheckMs.toFixed(3)} ms per check`);
});

test("authorization sweep: visitors (401) and teachers / admins on student routes never get a resource; GET and HEAD", async (t) => {
  seed();
  at(t, "2026-11-23T09:00");
  const { a } = baseStudent();
  pay(fee(a.id, NOV), 2000);
  recording("rec-nov", A, "2026-11-10T10:00");
  note("note-nov", A, "2026-11-10T10:00");
  bundle("bundle-nov", A, NOV);
  const calls = () => [
    ["stream GET", () => streamRoute.GET(jsonRequest("/x"), { params: { recordingId: "rec-nov" } })],
    ["stream HEAD", () => streamRoute.HEAD(jsonRequest("/x", "HEAD"), { params: { recordingId: "rec-nov" } })],
    ["note file", () => noteFileRoute.GET(jsonRequest("/x"), { params: { lectureId: `lec-${A}`, noteId: "note-nov" } })],
    ["bundle file", () => bundleFileRoute.GET(jsonRequest("/x"), { params: { bundleId: "bundle-nov", itemId: "i1" } })],
    ["lecture detail", () => lectureRoute.GET(jsonRequest("/x"), { params: { lectureId: `lec-${A}` } })],
    ["notes list", () => notesRoute.GET(jsonRequest("/x"), { params: { lectureId: `lec-${A}` } })],
  ];
  for (const who of [() => as.visitor(), () => as.teacher(T), () => as.admin()]) {
    who();
    for (const [label, call] of calls()) {
      const res = await call();
      assert.equal(res.status, 401, `${label} as ${session?.role ?? "visitor"}`);
    }
  }
  assert.equal(streamed, 0, "nothing streamed");
  as.visitor();
  assert.equal((await paperFileRoute.GET(jsonRequest("/x"), { params: { paperId: "p" } })).status, 401, "paper file: visitor");
  as.admin();
  assert.equal((await paperFileRoute.GET(jsonRequest("/x"), { params: { paperId: "p" } })).status, 403, "paper file: admin");
  // The month is never taken from the client: query parameters are ignored.
  fee(a.id, OCT);
  recording("rec-oct", A, "2026-10-10T10:00");
  as.student("s1");
  const forged = new Request(`${ORIGIN}/api/student/recorded-lectures/rec-oct/stream?year=2026&month=11&paid=1`, { headers: { "x-billing-month": "2026-11" } });
  assert.equal((await streamRoute.GET(forged, { params: { recordingId: "rec-oct" } })).status, 403);
});

// ---- Performance: whole pages ------------------------------------------------------------

const classAccess = require(path.join(root, "services", "class-access-service.ts"));
const recordingService = require(path.join(root, "services", "recorded-lecture-student-service.ts"));
const recordingPages = require(path.join(root, "services", "recorded-lecture-student-pages.ts"));

/** s1 in A, B and C, with a fee for each of the 12 months of 2026 in every class (every other one paid). */
function busyStudent() {
  const { a, b, c } = baseStudent();
  for (const cs of [a, b, c]) {
    cs.assignedAt = sl("2026-01-02T10:00");
    for (let m = 1; m <= 12; m += 1) {
      const f = fee(cs.id, { year: 2026, month: m });
      if (m % 2 === 0) pay(f, 2000);
    }
  }
  return { a, b, c };
}
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function readyRecording(n, classId, lectureId, wall, partNumber = 1) {
  return db.insert("RecordedLecture", {
    id: uuid(n), classId, lectureId, teacherId: T, title: `Part ${partNumber}`, partNumber, sizeBytes: BigInt(1000),
    durationSeconds: 60, width: null, height: null, readyAt: sl(wall), createdAt: sl(wall), status: 0, state: "READY", storedFileName: "x.mp4",
  });
}

test("performance: student layout notices (3 classes x 12 months) = class-level rule 1 query + resource resolver 3 queries", async (t) => {
  seed();
  at(t, "2026-12-20T09:00");
  busyStudent();
  const counter = countQueries();
  try {
    await classAccess.getClassAccessRestrictions("s1");
    const classLevel = counter.counts.total;
    const items = (await RA.loadStudentResourceAccess("s1")).noticeItems();
    assert.equal(classLevel, 1, JSON.stringify(counter.counts));
    assert.equal(counter.counts.total - classLevel, 3, JSON.stringify(counter.counts));
    // A and C (B is off): their 6 unpaid (odd) months each; every grace period has ended by 20 Dec.
    assert.equal(items.filter((i) => i.locked).length, 12);
    assert.ok(!items.some((i) => i.month % 2 === 0), "paid months never appear");
  } finally {
    counter.restore();
  }
});

test("performance: recordings list, 50 recordings over 12 months and 3 classes = 1 list query + 3 access queries; each locked correctly", async (t) => {
  seed();
  at(t, "2026-12-20T09:00");
  busyStudent();
  for (const c of [A, B, C]) db.row("Lecture", `lec-${c}`).date = sl("2026-12-01T10:00");
  for (let n = 1; n <= 50; n += 1) {
    const classId = [A, B, C][n % 3];
    const month = ((n - 1) % 12) + 1;
    readyRecording(n, classId, `lec-${classId}`, `2026-${String(month).padStart(2, "0")}-10T10:00`, n);
  }
  const counter = countQueries();
  try {
    const list = await recordingService.listStudentRecordedLectures({ studentId: "s1", query: { limit: "50" } });
    assert.equal(list.recordedLectures.length, 50);
    assert.equal(counter.counts.total, 4, JSON.stringify(counter.counts));
    for (const dto of list.recordedLectures) {
      const row = db.row("RecordedLecture", dto.id);
      const month = ((Number(dto.id.slice(-12)) - 1) % 12) + 1;
      const expectLocked = row.classId !== B && month % 2 === 1;
      assert.equal(dto.resourceAccess.locked, expectLocked, `${row.classId} ${month}`);
      assert.equal(dto.streamUrl === null, expectLocked);
    }
  } finally {
    counter.restore();
  }
});

test("performance: every range request of a playback re-checks with 4 queries (no growth with fees or resources)", async (t) => {
  seed();
  at(t, "2026-12-20T09:00");
  busyStudent();
  recording("rec-feb", A, "2026-02-10T10:00"); // February: paid
  as.student("s1");
  const counter = countQueries();
  try {
    for (const range of ["bytes=0-", "bytes=1000-1999", "bytes=2000-"]) {
      const before = counter.counts.total;
      const res = await streamRoute.GET(jsonRequest("/x", "GET", undefined, { range }), { params: { recordingId: "rec-feb" } });
      assert.equal(res.status, 200);
      assert.equal(counter.counts.total - before, 4, range);
    }
    const before = counter.counts.total;
    assert.equal((await streamRoute.HEAD(jsonRequest("/x", "HEAD"), { params: { recordingId: "rec-feb" } })).status, 200);
    assert.equal(counter.counts.total - before, 4, "HEAD");
  } finally {
    counter.restore();
  }
});

test("performance: the player page loads the resolver ONCE for all its part pages (200 parts, 4 pages)", async (t) => {
  seed();
  at(t, "2026-12-20T09:00");
  busyStudent();
  const lectureId = uuid(9999);
  db.insert("Lecture", { id: lectureId, classId: A, title: "Long lecture", status: 0, date: sl("2026-12-01T10:00"), endDate: null });
  for (let n = 1; n <= 205; n += 1) readyRecording(n, A, lectureId, n <= 100 ? "2026-11-10T10:00" : "2026-12-02T10:00", n);
  const counter = countQueries();
  try {
    const page = await recordingPages.loadLecturePlayer("s1", lectureId);
    assert.equal(page.ok, true);
    assert.equal(page.parts.length, 200);
    assert.ok(page.nextCursor, "more parts exist");
    assert.equal(counter.counts["classStudentResourceAccess.findMany"], 1, JSON.stringify(counter.counts));
    assert.equal(counter.counts["recordedLecture.findMany"], 4);
    assert.equal(counter.counts.total, 3 + 4);
    // November (unpaid, grace ended) is locked; the page explains it from this same resolver.
    assert.equal(page.access.decide(A, { year: 2026, month: 11 }).accessible, false);
    assert.equal(page.parts.filter((p) => p.resourceAccess.locked).length, 100);
  } finally {
    counter.restore();
  }
});

test("pure rule: override first, then the setting, the fee, and enrolment; the whole decision table", () => {
  const now = dueDigits(2026, 11, 23);
  const base = {
    classId: A,
    className: "A",
    classStudentId: "cs",
    restrictionEnabled: true,
    gracePeriodDays: 5,
    month: OCT,
    firstEnrolmentMonth: SEP,
    override: null,
    fee: null,
    nowSriLanka: now,
  };
  const unpaid = { id: "f", finalAmount: 2000, freeCard: false, dueDate: dueDigits(2026, 10, 14), payments: [], initialPayment: false };
  const cases = [
    [{}, true, "NO_FEE"],
    [{ month: AUG }, false, "PRE_ENROLMENT"],
    [{ month: AUG, override: "GRANTED" }, true, "OVERRIDE_GRANTED"],
    [{ fee: unpaid }, false, "UNPAID"],
    [{ fee: { ...unpaid, dueDate: null } }, true, "NO_DUE_DATE"],
    [{ fee: { ...unpaid, dueDate: dueDigits(2026, 11, 20) } }, true, "GRACE"],
    [{ fee: { ...unpaid, initialPayment: true, dueDate: dueDigits(2026, 12, 1) } }, false, "INITIAL_PAYMENT"],
    [{ fee: { ...unpaid, payments: [{ amount: 2000, status: "CONFIRMED" }] } }, true, "PAID"],
    [{ fee: { ...unpaid, payments: [{ amount: 2000, status: "CONFIRMED", reversal: { amount: 2000 } }] } }, false, "UNPAID"],
    [{ fee: unpaid, restrictionEnabled: false }, true, "SETTING_OFF"],
    [{ fee: unpaid, restrictionEnabled: false, override: "REVOKED" }, false, "OVERRIDE_REVOKED"],
    [{ fee: { ...unpaid, payments: [{ amount: 2000, status: "CONFIRMED" }] }, override: "REVOKED" }, false, "OVERRIDE_REVOKED"],
  ];
  for (const [over, accessible, source] of cases) {
    const d = RA.decideResourceMonth({ ...base, ...over });
    assert.equal(d.accessible, accessible, JSON.stringify(over));
    assert.equal(d.source, source, JSON.stringify(over));
  }
});
