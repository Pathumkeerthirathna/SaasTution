/*
 * Stage 5.4f-1: online attendance reconciliation
 * (services/lecture-attendance-reconcile-service.ts).
 *
 *   npm run test:attendance-reconcile
 *
 * No database: the real services run through tsx against the in-memory
 * PostgreSQL model (tests/attendance/helpers/attendance-pg-model.cjs). This is
 * NOT a real-PostgreSQL concurrency validation (postponed).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const { createPgModel } = require("./helpers/attendance-pg-model.cjs");

const root = path.resolve(__dirname, "..", "..");

let currentPrisma = null;
const fakeModule = (relativePath, exports) => {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
};
fakeModule("lib/prisma.ts", { prisma: new Proxy({}, { get: (_, key) => currentPrisma[key] }) });
fakeModule("services/fee-waiver-events.ts", {
  readLectureWaiverState: async () => null,
  recalculateAfterLectureChange: async () => {},
});
fakeModule("lib/session-events.ts", { emitStudentDataChange: () => {}, emitLiveChange: () => {} });

const reconcile = require(path.join(root, "services", "lecture-attendance-reconcile-service.ts"));
const evidence = require(path.join(root, "services", "lecture-attendance-evidence-service.ts"));
const qr = require(path.join(root, "services", "lecture-attendance-qr-service.ts"));
const decisions = require(path.join(root, "services", "lecture-attendance-decision-service.ts"));
const lectures = require(path.join(root, "services", "lecture-service.ts"));
const qrToken = require(path.join(root, "lib", "student-qr-token.ts"));

// ---- Clock and fixtures ----------------------------------------------------------------

const START = new Date("2026-09-01T12:30:00.000Z");
const at = (minutes, ms = 0) => new Date(START.getTime() + minutes * 60_000 + ms);
test.mock.timers.enable({ apis: ["Date"], now: at(200) });
const setNow = (date) => test.mock.timers.setTime(date.getTime());

const T1 = "teacher-1";
const T2 = "teacher-2";
const C1 = "class-1";
const L1 = "lecture-1";
const APPROVED_AT = new Date("2026-08-01T00:00:00.000Z");
const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
const ENV = {
  APPROVAL_FEATURE_STARTED_AT: "2026-07-28T00:00:00Z",
  ATTENDANCE_EVIDENCE_STARTED_AT: "2026-08-15T00:00:00Z",
  STUDENT_QR_SECRET: SECRET.toString("base64"),
};

let model;
let pg;
let visitSeq = 0;

function student(id, { teacherId = T1, status = 0, confirmationStatus = "APPROVED", broken = false, enrolledAt = new Date("2026-08-05T00:00:00Z") } = {}) {
  pg.committed.students[id] = {
    id, name: `Name of ${id}`, registrationNumber: null, teacherId, status, confirmationStatus,
    confirmedAt: confirmationStatus === "PENDING" ? null : broken ? new Date("2026-08-02T00:00:00Z") : APPROVED_AT,
    approvedAt: confirmationStatus === "PENDING" ? null : APPROVED_AT,
  };
  if (confirmationStatus !== "PENDING") {
    pg.committed.history.push({ id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: confirmationStatus, decidedAt: APPROVED_AT, previousConfirmedAt: null });
  }
  if (enrolledAt) {
    pg.committed.enrolments.push({
      id: `e-${id}`, studentId: id, classId: C1, assignedAt: new Date(enrolledAt.getTime() + (5 * 60 + 30) * 60_000), removedAt: null, isActive: true,
    });
  }
}

function visit(studentId, joinedAt, sessionId = "session-a") {
  const id = `visit-${String(++visitSeq).padStart(4, "0")}`;
  pg.committed.visits[id] = { id, studentId, joinedAt, classSessionId: sessionId };
  return id;
}

function reset() {
  model = createPgModel();
  pg = model.pg;
  currentPrisma = model.prisma;
  visitSeq = 0;
  pg.committed.classes[C1] = { id: C1, teacherId: T1, status: 0, attendanceGraceMinutes: 10 };
  pg.committed.lectures[L1] = { id: L1, classId: C1, title: "Kinematics", status: 0, classStatus: "COMPLETED", date: START, endDate: at(120), createdAt: at(-1000) };
  pg.committed.sessions["session-a"] = { id: "session-a", lectureId: L1 };
  pg.committed.sessions["session-b"] = { id: "session-b", lectureId: L1 }; // a restart of the same lecture
  pg.committed.sessions["session-free"] = { id: "session-free", lectureId: null };
  setNow(at(200));
}

const run = (extra = {}, env = ENV) => reconcile.reconcileLectureOnlineEvidence({ teacherId: T1, lectureId: L1, ...extra }, { env });
const record = (studentId) => pg.committed.records[`${L1}:${studentId}`] ?? null;
const audits = (studentId) =>
  pg.committed.recordAudits.filter((a) => a.lectureAttendanceId === record(studentId)?.id).sort((a, b) => a.version - b.version);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const counts = (result) => {
  const { lectureId, nextCursor, stoppedBecause, ...rest } = result;
  void lectureId; void nextCursor; void stoppedBecause;
  return rest;
};
const ZERO = { processed: 0, applied: 0, duplicates: 0, ineligible: 0, unknown: 0, inactive: 0, finalizedWithoutRecord: 0, busy: 0, skipped: 0 };

function register(extra = {}) {
  pg.committed.registers[L1] = {
    lectureId: L1, classId: C1, scheduledStartAt: START, scheduledEndAt: at(120), graceMinutes: 10,
    finalizedAt: null, finalizedByTeacherId: null, version: 1, createdAt: at(-30), updatedAt: at(-30), ...extra,
  };
}

function seedRecord(studentId, fields) {
  const row = {
    id: `rec-${studentId}`, lectureId: L1, classId: C1, studentId, firstOnlineAt: null, firstQrAt: null, autoStatus: null,
    teacherStatus: null, teacherDecidedAt: null, teacherDecidedById: null, pendingReviewSince: null, version: 1,
    createdAt: at(1), updatedAt: at(1), ...fields,
  };
  model.checkRecord(row);
  pg.committed.records[`${L1}:${studentId}`] = row;
  const action = { AUTO: "CREATED_AUTO", TEACHER: "TEACHER_SET", BACKFILL: "BACKFILL", FINALIZATION: "FINALIZE_ABSENT" }[row.statusSource];
  pg.committed.recordAudits.push({
    id: `seed-${studentId}`, lectureAttendanceId: row.id, version: 1, lectureId: L1, studentId, action,
    fromStatus: null, toStatus: row.status, fromTeacherStatus: null, toTeacherStatus: row.teacherStatus, fromAutoStatus: null, toAutoStatus: row.autoStatus,
    actorRole: row.statusSource === "TEACHER" ? "TEACHER" : "SYSTEM", actorId: row.statusSource === "TEACHER" ? T1 : null,
    reason: null, afterFinalization: false, createdAt: at(1),
  });
  return row;
}

function assertChain(studentId) {
  const rows = audits(studentId);
  rows.forEach((row, i) => {
    assert.equal(row.version, i + 1);
    if (i > 0) {
      assert.equal(row.fromStatus, rows[i - 1].toStatus);
      assert.equal(row.fromAutoStatus, rows[i - 1].toAutoStatus);
      assert.equal(row.fromTeacherStatus, rows[i - 1].toTeacherStatus);
    }
    model.checkAudit(row);
  });
  assert.equal(rows.at(-1).version, record(studentId).version);
  model.checkRecord(record(studentId));
}

function gateOn(label, op) {
  let release;
  const gate = new Promise((r) => { release = r; });
  pg.beforeStatement = async (l, o) => {
    if (l === label && o === op) await gate;
  };
  return release;
}

// ---- Visit selection ------------------------------------------------------------------------

test("earliest eligible visit across sessions (restarts), by joinedAt then visit id; leftAt is never used", async () => {
  reset();
  student("s1");
  visit("s1", at(20), "session-a");
  const early = visit("s1", at(5), "session-b"); // the restart, but the earlier join
  visit("s1", at(40), "session-b");
  visit("s1", at(1), "session-free"); // no lecture link: never considered

  const result = await run();
  assert.deepEqual(counts(result), { ...ZERO, processed: 1, applied: 1 });
  assert.deepEqual([result.nextCursor, result.stoppedBecause], [null, null]);
  const rec = record("s1");
  assert.deepEqual([rec.status, rec.statusSource, rec.firstOnlineAt.toISOString(), rec.autoStatus], ["PRESENT", "AUTO", at(5).toISOString(), "PRESENT"]);
  const [audit] = audits("s1");
  assert.deepEqual([audit.action, audit.attendanceVisitId, audit.actorRole], ["CREATED_AUTO", early, "SYSTEM"]);
  assertChain("s1");
});

test("equal join times: the smaller visit id wins", async () => {
  reset();
  student("s1");
  const a = visit("s1", at(5), "session-b");
  visit("s1", at(5), "session-a");
  await run();
  assert.equal(audits("s1")[0].attendanceVisitId, a);
});

test("eligibility at each visit's own join time: a visit before enrolment is skipped, the later one used (LATE)", async () => {
  reset();
  student("s1", { enrolledAt: at(10) });
  visit("s1", at(5));
  const used = visit("s1", at(15));
  const result = await run();
  assert.deepEqual(counts(result), { ...ZERO, processed: 1, applied: 1 });
  assert.deepEqual([record("s1").status, record("s1").firstOnlineAt.toISOString()], ["LATE", at(15).toISOString()]);
  assert.equal(audits("s1")[0].attendanceVisitId, used);
});

test("never enrolled, NOT_APPROVED and UNKNOWN write nothing and are counted", async () => {
  reset();
  student("s-never", { enrolledAt: null });
  student("s-pending", { confirmationStatus: "PENDING" });
  student("s-unknown", { broken: true });
  for (const id of ["s-never", "s-pending", "s-unknown"]) visit(id, at(3));
  const result = await run();
  assert.deepEqual(counts(result), { ...ZERO, processed: 3, ineligible: 2, unknown: 1 });
  assert.deepEqual(pg.committed.records, {});
  assert.deepEqual(pg.committed.registers, {}, "no register created when nothing is applied");
});

test("deleted / inactive students and another teacher's student are skipped and counted", async () => {
  reset();
  student("s-deleted", { status: 2 });
  student("s-inactive", { status: 1 });
  student("s-other", { teacherId: T2 });
  for (const id of ["s-deleted", "s-inactive", "s-other"]) visit(id, at(3));
  const result = await run();
  assert.deepEqual(counts(result), { ...ZERO, processed: 3, inactive: 2, skipped: 1 });
  assert.deepEqual(pg.committed.records, {});
});

// ---- Duplicates and idempotency ------------------------------------------------------------------

test("re-running is idempotent: the second run finds every student already represented and writes nothing", async () => {
  reset();
  student("s1");
  student("s2");
  visit("s1", at(2));
  visit("s1", at(30));
  visit("s2", at(12));
  assert.deepEqual(counts(await run()), { ...ZERO, processed: 2, applied: 2 });
  const snapshot = JSON.stringify([pg.committed.records, pg.committed.recordAudits, pg.committed.registers, pg.committed.registerAudits]);
  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual(counts(await run()), { ...ZERO, processed: 2, duplicates: 2 });
  }
  assert.equal(JSON.stringify([pg.committed.records, pg.committed.recordAudits, pg.committed.registers, pg.committed.registerAudits]), snapshot);
  assert.equal(Object.keys(pg.committed.records).length, 2);
});

test("dispatched evidence already recorded from a later visit: reconciliation moves it to the earlier visit (stronger)", async () => {
  reset();
  student("s1");
  const late = visit("s1", at(25));
  setNow(at(26));
  await evidence.recordOnlineEvidence(late, { env: ENV }); // the dispatcher saw only the later visit
  visit("s1", at(2)); // the earlier one was dropped
  setNow(at(200));
  const result = await run();
  assert.deepEqual(counts(result), { ...ZERO, processed: 1, applied: 1 });
  assert.deepEqual([record("s1").status, record("s1").firstOnlineAt.toISOString(), record("s1").version], ["PRESENT", at(2).toISOString(), 2]);
  assert.deepEqual(audits("s1").map((a) => a.action), ["CREATED_AUTO", "AUTO_UPDATED"]);
  assertChain("s1");
});

// ---- Lecture refusal ----------------------------------------------------------------------------

test("refusals: historical (lecture or register start), cancelled, deleted, another teacher's lecture", async () => {
  reset();
  student("s1");
  visit("s1", at(3));

  pg.committed.lectures[L1].date = new Date("2026-08-10T12:30:00Z");
  await assert.rejects(run(), (e) => e.code === "ATTENDANCE_LECTURE_HISTORICAL" && e.statusCode === 409);
  pg.committed.lectures[L1].date = START;
  register({ scheduledStartAt: new Date("2026-08-10T12:30:00Z") }); // the register's start decides
  await assert.rejects(run(), (e) => e.code === "ATTENDANCE_LECTURE_HISTORICAL");
  delete pg.committed.registers[L1];

  pg.committed.lectures[L1].classStatus = "CANCELLED";
  await assert.rejects(run(), (e) => e.code === "LECTURE_CANCELLED" && e.statusCode === 409);
  pg.committed.lectures[L1].classStatus = "COMPLETED";
  pg.committed.lectures[L1].status = 1;
  await assert.rejects(run(), (e) => e.code === "LECTURE_NOT_FOUND" && e.statusCode === 404);
  pg.committed.lectures[L1].status = 0;
  await assert.rejects(reconcile.reconcileLectureOnlineEvidence({ teacherId: T2, lectureId: L1 }, { env: ENV }), (e) => e.code === "LECTURE_NOT_FOUND");

  assert.equal(pg.transactions.length, 0);
  assert.deepEqual(pg.committed.records, {});
});

test("the lecture cancelled mid-run: the run stops; the cursor resumes at the first unprocessed student", async () => {
  reset();
  for (const id of ["s1", "s2", "s3"]) { student(id); visit(id, at(3)); }
  pg.beforeStatement = async (label, op) => {
    if (label === "tx2" && op === "lock:lecture") pg.committed.lectures[L1].classStatus = "CANCELLED";
  };
  const result = await run();
  assert.equal(result.stoppedBecause, "LECTURE_CHANGED");
  assert.equal(result.nextCursor, "s1", "continue after s1 (s2 is retried)");
  assert.deepEqual(counts(result), { ...ZERO, processed: 1, applied: 1 });
  assert.equal(record("s2"), null);
});

// ---- Finalized registers (F7) ---------------------------------------------------------------------

test("finalized register: students with a record are reconciled (review only); no record is ever created", async () => {
  reset();
  student("s1");
  student("s2");
  register({ finalizedAt: at(150), finalizedByTeacherId: T1, version: 2 });
  seedRecord("s1", { status: "ABSENT", statusSource: "FINALIZATION" });
  visit("s1", at(4));
  visit("s2", at(4));
  const frozen = JSON.stringify(pg.committed.registers[L1]);

  const result = await run();
  assert.deepEqual(counts(result), { ...ZERO, processed: 2, applied: 1, finalizedWithoutRecord: 1 });
  assert.equal(record("s2"), null, "never a new record after finalization");
  const s1 = record("s1");
  assert.deepEqual([s1.status, s1.statusSource, s1.autoStatus], ["ABSENT", "FINALIZATION", "PRESENT"], "the decision is not altered");
  assert.equal(s1.pendingReviewSince.toISOString(), at(200).toISOString(), "stronger evidence: a review");
  assert.equal(audits("s1").at(-1).afterFinalization, true);
  assert.equal(JSON.stringify(pg.committed.registers[L1]), frozen);
  assertChain("s1");
});

// ---- Existing records ------------------------------------------------------------------------------

test("teacher decisions are preserved: stronger evidence raises a review, weaker is only recorded", async () => {
  reset();
  student("s1");
  student("s2");
  register();
  seedRecord("s1", { status: "ABSENT", statusSource: "TEACHER", teacherStatus: "ABSENT", teacherDecidedAt: at(1), teacherDecidedById: T1 });
  seedRecord("s2", { status: "PRESENT", statusSource: "TEACHER", teacherStatus: "PRESENT", teacherDecidedAt: at(1), teacherDecidedById: T1 });
  visit("s1", at(4));
  visit("s2", at(30));
  const result = await run();
  assert.deepEqual(counts(result), { ...ZERO, processed: 2, applied: 2 });
  assert.deepEqual([record("s1").status, record("s1").teacherStatus, record("s1").pendingReviewSince !== null], ["ABSENT", "ABSENT", true]);
  assert.deepEqual([record("s2").status, record("s2").autoStatus, record("s2").pendingReviewSince], ["PRESENT", "LATE", null]);
  assertChain("s1");
  assertChain("s2");
});

test("BACKFILL records stay PRESENT; only their evidence moves to the earlier visit", async () => {
  reset();
  student("s1");
  register();
  seedRecord("s1", { status: "PRESENT", statusSource: "BACKFILL", firstOnlineAt: at(20), autoStatus: "LATE" });
  visit("s1", at(20));
  visit("s1", at(3));
  await run();
  assert.deepEqual([record("s1").status, record("s1").statusSource, record("s1").autoStatus, record("s1").firstOnlineAt.toISOString()], ["PRESENT", "BACKFILL", "PRESENT", at(3).toISOString()]);
  assertChain("s1");
});

test("pending reviews are preserved (never cleared, original time kept)", async () => {
  reset();
  student("s1");
  register();
  seedRecord("s1", { status: "ABSENT", statusSource: "TEACHER", teacherStatus: "ABSENT", teacherDecidedAt: at(1), teacherDecidedById: T1,
    firstQrAt: at(30), autoStatus: "LATE", pendingReviewSince: at(31) });
  visit("s1", at(25)); // earlier online evidence, still LATE: the review stays as it was
  await run();
  assert.equal(record("s1").pendingReviewSince.toISOString(), at(31).toISOString());
  assert.equal(record("s1").firstOnlineAt.toISOString(), at(25).toISOString());
});

// ---- Concurrency (in-memory model) ------------------------------------------------------------------

test("concurrent with the dispatcher on the same visit: one record, one creation audit", async () => {
  reset();
  student("s1");
  const v = visit("s1", at(3));
  const release = gateOn("tx1", "create:audit");
  const dispatched = evidence.recordOnlineEvidence(v, { env: ENV });
  while (!pg.log.includes("tx1:insert:record:s1")) await tick();
  const reconciling = run();
  while (!pg.log.some((e) => e.startsWith("tx2:waits:") || e.startsWith("tx2:unique-wait:"))) await tick();
  release();
  assert.deepEqual(await dispatched, { status: "APPLIED", effect: "STATUS_UPDATED" });
  assert.deepEqual(counts(await reconciling), { ...ZERO, processed: 1, duplicates: 1 });
  assert.equal(audits("s1").length, 1);
});

test("concurrent with a QR scan: serialized on the record; both pieces of evidence kept", async () => {
  reset();
  student("s1");
  visit("s1", at(2));
  const id = "00000000-0000-4000-8000-000000000001";
  const nonce = Buffer.alloc(32, 1).toString("base64url");
  const value = qrToken.deriveStudentQrToken(SECRET, id, nonce);
  pg.committed.tokens[id] = { id, studentId: "s1", nonce, tokenHash: qrToken.hashStudentQrToken(value), revokedAt: null };
  setNow(at(20));
  const release = gateOn("tx1", "create:scan");
  const scanning = qr.recordQrScan({ teacherId: T1, lectureId: L1, clientScanId: "reconcile-qr-0000001", payload: qrToken.buildStudentQrPayload(value) }, { env: ENV });
  while (!pg.log.includes("tx1:insert:record:s1")) await tick();
  const reconciling = run();
  while (!pg.log.some((e) => e.startsWith("tx2:waits:") || e.startsWith("tx2:unique-wait:"))) await tick();
  release();
  await scanning;
  assert.deepEqual(counts(await reconciling), { ...ZERO, processed: 1, applied: 1 });
  const rec = record("s1");
  assert.deepEqual([rec.status, rec.firstQrAt.toISOString(), rec.firstOnlineAt.toISOString()], ["PRESENT", at(20).toISOString(), at(2).toISOString()]);
  assertChain("s1");
});

test("concurrent with a teacher decision: the decision stays authoritative", async () => {
  reset();
  student("s1");
  visit("s1", at(2));
  const release = gateOn("tx1", "create:audit");
  const deciding = decisions.setTeacherAttendanceStatus({ teacherId: T1, lectureId: L1, studentId: "s1", status: "EXCUSED", expectedVersion: null });
  while (!pg.log.includes("tx1:insert:record:s1")) await tick();
  const reconciling = run();
  while (!pg.log.some((e) => e.startsWith("tx2:waits:") || e.startsWith("tx2:unique-wait:"))) await tick();
  release();
  await deciding;
  assert.deepEqual(counts(await reconciling), { ...ZERO, processed: 1, applied: 1 });
  assert.deepEqual([record("s1").status, record("s1").statusSource, record("s1").autoStatus, record("s1").pendingReviewSince !== null], ["EXCUSED", "TEACHER", "PRESENT", true]);
  assertChain("s1");
});

test("concurrent with a schedule edit: reconciliation waits on the lecture and judges against the new start", async () => {
  reset();
  student("s1");
  register();
  visit("s1", at(8)); // PRESENT under START; LATE once the start moves 5 minutes earlier
  const release = gateOn("tx1", "update:lecture");
  const editing = lectures.updateLectureForTeacher(T1, L1, { date: at(-5) });
  while (!pg.held.some((h) => h.row === `lecture:${L1}` && h.mode === "NO_KEY_UPDATE")) await tick();
  const reconciling = run();
  while (!pg.log.some((e) => e.startsWith("tx2:waits:lecture:"))) await tick();
  release();
  await editing;
  await reconciling;
  assert.deepEqual([record("s1").status, record("s1").autoStatus], ["LATE", "LATE"]);
});

test("busy: a student whose lock wait times out is counted; the others are processed; a fresh run catches up", async () => {
  reset();
  for (const id of ["s1", "s2", "s3"]) { student(id); visit(id, at(3)); }
  pg.held.push({ row: "student:s2", owner: "approval-decision", mode: "NO_KEY_UPDATE" });
  pg.failWhenBlocked = true;
  const result = await run();
  assert.deepEqual(counts(result), { ...ZERO, processed: 3, applied: 2, busy: 1 });
  assert.equal(record("s2"), null);
  assert.equal(pg.transactions.filter((t) => t.outcome === "rollback").length, 1);

  pg.failWhenBlocked = false;
  model.locks.release("approval-decision");
  assert.deepEqual(counts(await run()), { ...ZERO, processed: 3, applied: 1, duplicates: 2 });
});

// ---- Pagination ----------------------------------------------------------------------------------

test("cursor: ordered by studentId, no duplicates or gaps across pages", async () => {
  reset();
  for (const id of ["s5", "s3", "s1", "s4", "s2"]) { student(id); visit(id, at(3)); }
  const seen = [];
  let cursor = null;
  const pages = [];
  do {
    const result = await run({ cursor, limit: 2 });
    pages.push(result.processed);
    cursor = result.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(pages, [2, 2, 1]);
  for (const [, rec] of Object.entries(pg.committed.records)) seen.push(rec.studentId);
  assert.deepEqual(seen.sort(), ["s1", "s2", "s3", "s4", "s5"]);
  // Cursor semantics: the next page starts strictly after it.
  assert.deepEqual((await run({ cursor: "s4", limit: 2 })).processed, 1);
  assert.deepEqual((await run({ cursor: "s5" })).nextCursor, null);
});

test("the 500-student cap: default and maximum 500 per request; invalid limits and cursors are 400", async () => {
  reset();
  for (let i = 0; i < 501; i += 1) {
    const id = `s${String(i).padStart(4, "0")}`;
    student(id);
    visit(id, at(3));
  }
  const first = await run();
  assert.equal(first.processed, 500);
  assert.equal(first.nextCursor, "s0499");
  const second = await run({ cursor: first.nextCursor });
  assert.deepEqual([second.processed, second.nextCursor], [1, null]);

  for (const limit of [0, 501, 1.5, "10", -1]) {
    await assert.rejects(run({ limit }), (e) => e.code === "VALIDATION_ERROR" && e.details.field === "limit", String(limit));
  }
  for (const cursor of ["", "   ", "x".repeat(192), 5]) {
    await assert.rejects(run({ cursor }), (e) => e.code === "VALIDATION_ERROR", String(cursor));
  }
  assert.equal(reconcile.RECONCILE_MAX_LIMIT, 500);
});

// ---- Configuration and output ---------------------------------------------------------------------

test("missing configuration fails closed (503) before any read or transaction", async () => {
  reset();
  student("s1");
  visit("s1", at(3));
  const original = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(run({}, { ATTENDANCE_EVIDENCE_STARTED_AT: ENV.ATTENDANCE_EVIDENCE_STARTED_AT }), (e) => e.code === "ATTENDANCE_APPROVAL_NOT_CONFIGURED" && e.statusCode === 503);
    await assert.rejects(run({}, { APPROVAL_FEATURE_STARTED_AT: ENV.APPROVAL_FEATURE_STARTED_AT, ATTENDANCE_EVIDENCE_STARTED_AT: "bad" }), (e) => e.code === "ATTENDANCE_EVIDENCE_NOT_CONFIGURED");
  } finally {
    console.warn = original;
  }
  assert.equal(pg.transactions.length, 0);
  assert.ok(!pg.log.includes("read:visits"));
  assert.deepEqual(pg.committed.records, {});
});

test("sanitized: the result holds counts only; nothing is logged", async () => {
  reset();
  student("s-secret-student");
  student("s-pending", { confirmationStatus: "PENDING" });
  visit("s-secret-student", at(3));
  visit("s-pending", at(3));
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = (...args) => lines.push(args.join(" "));
  let result;
  try {
    result = await run({ limit: 1 });
  } finally {
    Object.assign(console, saved);
  }
  assert.deepEqual(lines, []);
  assert.deepEqual(Object.keys(result).sort(), ["applied", "busy", "duplicates", "finalizedWithoutRecord", "inactive", "ineligible", "lectureId", "nextCursor", "processed", "skipped", "stoppedBecause", "unknown"]);
  const json = JSON.stringify(result);
  for (const secret of ["Name of", "visit-", "s-secret-student", "hash", "token", "APPROVED", "PENDING", "joinedAt"]) assert.ok(!json.includes(secret), secret);
  // The cursor is the last processed student's id (an opaque continuation key, not a name).
  assert.equal(result.nextCursor, "s-pending");
});
