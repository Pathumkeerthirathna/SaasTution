/*
 * Stage 5.4e: lecture schedule edits keep an OPEN attendance register in step
 * (one transaction), recalculate evidence statuses when the start moves,
 * leave FINALIZED registers untouched, and a lecture with finalized
 * attendance cannot be cancelled or deleted.
 *
 *   npm run test:attendance-schedule
 *
 * No database: the real services (services/lecture-service.ts and the
 * attendance services) run through tsx against the in-memory PostgreSQL model
 * (tests/attendance/helpers/attendance-pg-model.cjs). The fee-waiver hooks and
 * the live-update events are faked (recorded).
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
const waiverCalls = [];
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
  readLectureWaiverState: async (lectureId) => ({ lectureId, read: true }),
  recalculateAfterLectureChange: async (before, after) => waiverCalls.push({ before, after }),
});
fakeModule("lib/session-events.ts", { emitStudentDataChange: () => {}, emitLiveChange: () => {} });

const lectures = require(path.join(root, "services", "lecture-service.ts"));
const attendance = require(path.join(root, "services", "lecture-attendance-service.ts"));
const qr = require(path.join(root, "services", "lecture-attendance-qr-service.ts"));
const decisions = require(path.join(root, "services", "lecture-attendance-decision-service.ts"));
const qrToken = require(path.join(root, "lib", "student-qr-token.ts"));

// ---- Clock and fixtures ------------------------------------------------------------------

const START = new Date("2026-09-01T12:30:00.000Z");
const END = new Date("2026-09-01T14:30:00.000Z");
const at = (minutes, ms = 0, base = START) => new Date(base.getTime() + minutes * 60_000 + ms);
test.mock.timers.enable({ apis: ["Date"], now: at(-60) });
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
let seq = 0;

function reset() {
  model = createPgModel();
  pg = model.pg;
  currentPrisma = model.prisma;
  waiverCalls.length = 0;
  // The CLASS default grace is 15; the register's own (teacher-configured) grace is 10.
  pg.committed.classes[C1] = { id: C1, teacherId: T1, status: 0, attendanceGraceMinutes: 15 };
  pg.committed.lectures[L1] = { id: L1, classId: C1, title: "Kinematics", status: 0, classStatus: "SCHEDULED", date: START, endDate: END, createdAt: at(-10_000) };
  for (const id of ["s1", "s2", "s3", "s4", "s5"]) {
    pg.committed.students[id] = { id, name: id, registrationNumber: null, teacherId: T1, status: 0, confirmationStatus: "APPROVED", confirmedAt: APPROVED_AT, approvedAt: APPROVED_AT };
    pg.committed.history.push({ id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: "APPROVED", decidedAt: APPROVED_AT, previousConfirmedAt: null });
    pg.committed.enrolments.push({ id: `e-${id}`, studentId: id, classId: C1, assignedAt: new Date("2026-08-05T05:30:00Z"), removedAt: null, isActive: true });
  }
  setNow(at(-60));
}

function openRegister(extra = {}) {
  pg.committed.registers[L1] = {
    lectureId: L1, classId: C1, scheduledStartAt: START, scheduledEndAt: END, graceMinutes: 10,
    finalizedAt: null, finalizedByTeacherId: null, version: 1, createdAt: at(-120), updatedAt: at(-120), ...extra,
  };
  pg.committed.registerAudits.push({
    id: "ra-1", lectureId: L1, version: 1, action: "CREATED", toGraceMinutes: 10, toScheduledStartAt: START, toScheduledEndAt: END,
    actorRole: "SYSTEM", actorId: null, createdAt: at(-120),
  });
}

/** A record (version 1) with its creation audit, valid under the CHECK rules. */
function seedRecord(studentId, fields) {
  const row = {
    id: `rec-${studentId}`, lectureId: L1, classId: C1, studentId, firstOnlineAt: null, firstQrAt: null, autoStatus: null,
    teacherStatus: null, teacherDecidedAt: null, teacherDecidedById: null, pendingReviewSince: null, version: 1,
    createdAt: at(-1), updatedAt: at(-1), ...fields,
  };
  model.checkRecord(row);
  pg.committed.records[`${L1}:${studentId}`] = row;
  const action = { AUTO: "CREATED_AUTO", TEACHER: "TEACHER_SET", BACKFILL: "BACKFILL", FINALIZATION: "FINALIZE_ABSENT" }[row.statusSource];
  const audit = {
    id: `seed-${studentId}`, lectureAttendanceId: row.id, version: 1, lectureId: L1, studentId, action,
    fromStatus: null, toStatus: row.status, fromTeacherStatus: null, toTeacherStatus: row.teacherStatus, fromAutoStatus: null, toAutoStatus: row.autoStatus,
    actorRole: row.statusSource === "TEACHER" ? "TEACHER" : "SYSTEM", actorId: row.statusSource === "TEACHER" ? T1 : null,
    reason: null, afterFinalization: false, scanEventId: null, attendanceVisitId: null, registerAuditId: null, createdAt: at(-1),
  };
  model.checkAudit(audit);
  pg.committed.recordAudits.push(audit);
  return row;
}

const record = (studentId) => pg.committed.records[`${L1}:${studentId}`];
const recordAudits = (studentId) =>
  pg.committed.recordAudits.filter((a) => a.lectureAttendanceId === record(studentId).id).sort((a, b) => a.version - b.version);
const registerAudits = () => pg.committed.registerAudits.filter((a) => a.lectureId === L1).sort((a, b) => a.version - b.version);
const edit = (update, teacherId = T1) => lectures.updateLectureForTeacher(teacherId, L1, update);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function token(n, studentId) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const nonce = Buffer.alloc(32, n).toString("base64url");
  const value = qrToken.deriveStudentQrToken(SECRET, id, nonce);
  pg.committed.tokens[id] = { id, studentId, nonce, tokenHash: qrToken.hashStudentQrToken(value), revokedAt: null };
  return qrToken.buildStudentQrPayload(value);
}
const scan = (payload) => qr.recordQrScan({ teacherId: T1, lectureId: L1, clientScanId: `sync-scan-${String(++seq).padStart(8, "0")}`, payload }, { env: ENV });

function assertChain(studentId) {
  const rows = recordAudits(studentId);
  rows.forEach((row, i) => {
    assert.equal(row.version, i + 1);
    if (i > 0) {
      assert.equal(row.fromStatus, rows[i - 1].toStatus);
      assert.equal(row.fromTeacherStatus, rows[i - 1].toTeacherStatus);
      assert.equal(row.fromAutoStatus, rows[i - 1].toAutoStatus);
    }
    model.checkAudit(row);
  });
  assert.equal(rows.at(-1).version, record(studentId).version);
  assert.equal(rows.at(-1).toStatus, record(studentId).status);
  assert.equal(rows.at(-1).toAutoStatus, record(studentId).autoStatus);
  model.checkRecord(record(studentId));
}

// ---- Open register synchronization ----------------------------------------------------------

test("start change: the open register follows (grace kept), audited; evidence statuses recalculated by source", async () => {
  reset();
  openRegister();
  seedRecord("s1", { status: "PRESENT", statusSource: "AUTO", firstQrAt: at(8), autoStatus: "PRESENT" }); // PRESENT under START
  seedRecord("s2", { status: "LATE", statusSource: "AUTO", firstOnlineAt: at(20), autoStatus: "LATE" }); // still LATE
  seedRecord("s3", { status: "ABSENT", statusSource: "TEACHER", teacherStatus: "ABSENT", teacherDecidedAt: at(0), teacherDecidedById: T1,
    firstQrAt: at(8), autoStatus: "PRESENT", pendingReviewSince: at(9) });
  seedRecord("s4", { status: "PRESENT", statusSource: "BACKFILL", firstOnlineAt: at(8), autoStatus: "PRESENT" });
  seedRecord("s5", { status: "PRESENT", statusSource: "TEACHER", teacherStatus: "PRESENT", teacherDecidedAt: at(0), teacherDecidedById: T1 }); // no evidence

  setNow(at(30));
  const newStart = at(-5); // 5 minutes earlier: the boundary becomes START + 5
  const lecture = await edit({ date: newStart });
  assert.equal(lecture.date.toISOString(), newStart.toISOString());

  const reg = pg.committed.registers[L1];
  assert.deepEqual(
    [reg.scheduledStartAt.toISOString(), reg.scheduledEndAt.toISOString(), reg.graceMinutes, reg.version, reg.updatedAt.toISOString()],
    [newStart.toISOString(), END.toISOString(), 10, 2, at(30).toISOString()]
  );
  const synced = registerAudits().at(-1);
  assert.deepEqual(
    { action: synced.action, version: synced.version, actorRole: synced.actorRole, actorId: synced.actorId, recalculatedCount: synced.recalculatedCount,
      from: synced.fromScheduledStartAt.toISOString(), to: synced.toScheduledStartAt.toISOString() },
    { action: "SCHEDULE_SYNCED", version: 2, actorRole: "TEACHER", actorId: T1, recalculatedCount: 3, from: START.toISOString(), to: newStart.toISOString() }
  );
  assert.deepEqual([synced.fromScheduledEndAt.toISOString(), synced.toScheduledEndAt.toISOString()], [END.toISOString(), END.toISOString()]);

  // AUTO follows the evidence.
  assert.deepEqual([record("s1").status, record("s1").autoStatus, record("s1").version], ["LATE", "LATE", 2]);
  assert.deepEqual([record("s2").status, record("s2").version], ["LATE", 1], "unchanged evidence status: untouched");
  // TEACHER: decision and pending review kept; only the evidence status changes.
  assert.deepEqual([record("s3").status, record("s3").teacherStatus, record("s3").autoStatus, record("s3").pendingReviewSince.toISOString()], ["ABSENT", "ABSENT", "LATE", at(9).toISOString()]);
  // BACKFILL: stays PRESENT.
  assert.deepEqual([record("s4").status, record("s4").statusSource, record("s4").autoStatus], ["PRESENT", "BACKFILL", "LATE"]);
  // No evidence: untouched.
  assert.equal(record("s5").version, 1);

  for (const id of ["s1", "s3", "s4"]) {
    const audit = recordAudits(id).at(-1);
    assert.deepEqual([audit.action, audit.actorRole, audit.actorId, audit.registerAuditId, audit.reason], ["AUTO_RECALCULATED", "SYSTEM", null, synced.id, null]);
    assertChain(id);
  }
  // No review was raised by the reschedule.
  assert.equal(record("s1").pendingReviewSince, null);
  assert.equal(record("s4").pendingReviewSince, null);

  // Fee waivers: the existing after-commit hook, with the new date.
  assert.deepEqual(waiverCalls.map((c) => c.after.date.toISOString()), [newStart.toISOString()]);
});

test("grace boundary: evidence exactly at new start + grace is PRESENT, one millisecond later LATE", async () => {
  reset();
  openRegister();
  const newStart = at(20);
  seedRecord("s1", { status: "LATE", statusSource: "AUTO", firstQrAt: at(30), autoStatus: "LATE" }); // = newStart + 10 min
  seedRecord("s2", { status: "LATE", statusSource: "AUTO", firstQrAt: at(30, 1), autoStatus: "LATE" }); // + 1 ms
  setNow(at(40));
  await edit({ date: newStart });
  assert.equal(record("s1").status, "PRESENT");
  assert.equal(record("s2").status, "LATE");
  assert.equal(record("s2").version, 1);
  assert.equal(registerAudits().at(-1).recalculatedCount, 1);
});

test("end-only change: the register end follows, no recalculation, no record locked", async () => {
  reset();
  openRegister();
  seedRecord("s1", { status: "PRESENT", statusSource: "AUTO", firstQrAt: at(8), autoStatus: "PRESENT" });
  const newEnd = at(150);
  await edit({ endDate: newEnd });
  assert.equal(pg.committed.registers[L1].scheduledEndAt.toISOString(), newEnd.toISOString());
  assert.equal(pg.committed.registers[L1].scheduledStartAt.toISOString(), START.toISOString());
  const synced = registerAudits().at(-1);
  assert.deepEqual([synced.action, synced.recalculatedCount], ["SCHEDULE_SYNCED", 0]);
  assert.equal(record("s1").version, 1);
  assert.ok(!pg.transactions.at(-1).statements.includes("lock:records"));
});

test("clearing the end time syncs a null end", async () => {
  reset();
  openRegister();
  await edit({ endDate: null });
  assert.equal(pg.committed.registers[L1].scheduledEndAt, null);
  assert.equal(registerAudits().at(-1).toScheduledEndAt, null);
});

test("title-only edits stay on the autocommit path: no transaction, the register untouched", async () => {
  reset();
  openRegister();
  const before = { ...pg.committed.registers[L1] };
  const lecture = await edit({ title: "Kinematics II" });
  assert.equal(lecture.title, "Kinematics II");
  assert.equal(pg.transactions.length, 0);
  assert.deepEqual(pg.committed.registers[L1], before);
  assert.equal(registerAudits().length, 1);
});

test("same-value schedule edits change neither the register nor its audit", async () => {
  reset();
  openRegister();
  const before = { ...pg.committed.registers[L1] };
  await edit({ date: START, endDate: END, title: "Renamed" });
  assert.deepEqual(pg.committed.registers[L1], before);
  assert.equal(registerAudits().length, 1);
  assert.equal(pg.committed.lectures[L1].title, "Renamed");
  assert.equal(pg.transactions.length, 1);
});

test("no register: the edit never creates one", async () => {
  reset();
  await edit({ date: at(60), endDate: at(180) });
  assert.deepEqual(pg.committed.registers, {});
  assert.deepEqual(pg.committed.registerAudits, []);
  assert.equal(pg.committed.lectures[L1].date.toISOString(), at(60).toISOString());
});

test("a stale open register (created before the sync existed) is brought in step by the next schedule edit", async () => {
  reset();
  openRegister({ scheduledStartAt: at(-90) }); // stale copy
  pg.committed.registerAudits[0].toScheduledStartAt = at(-90);
  await edit({ endDate: at(200) }); // an end-only edit
  const reg = pg.committed.registers[L1];
  assert.equal(reg.scheduledStartAt.toISOString(), START.toISOString(), "the start follows the lecture's (locked) start too");
  assert.equal(reg.scheduledEndAt.toISOString(), at(200).toISOString());
  assert.equal(registerAudits().at(-1).fromScheduledStartAt.toISOString(), at(-90).toISOString());
});

// ---- Finalized registers ----------------------------------------------------------------------

test("finalized register: the lecture edit is allowed; the register, records and audits stay exactly as they were", async () => {
  reset();
  openRegister({ finalizedAt: at(130), finalizedByTeacherId: T1, version: 2 });
  seedRecord("s1", { status: "PRESENT", statusSource: "AUTO", firstQrAt: at(8), autoStatus: "PRESENT" });
  const snapshot = JSON.stringify([pg.committed.registers, pg.committed.records, pg.committed.recordAudits, pg.committed.registerAudits]);

  const lecture = await edit({ date: at(60), endDate: at(180) });
  assert.equal(lecture.date.toISOString(), at(60).toISOString());
  assert.equal(JSON.stringify([pg.committed.registers, pg.committed.records, pg.committed.recordAudits, pg.committed.registerAudits]), snapshot);
  assert.ok(!pg.transactions.at(-1).statements.includes("update:register"));
});

test("finalized register: the QR window keeps the frozen start", async () => {
  reset();
  openRegister({ finalizedAt: at(130), finalizedByTeacherId: T1, version: 2 });
  await edit({ date: at(24 * 60), endDate: at(24 * 60 + 60) });
  setNow(at(-30));
  const outcome = await scan(token(1, "s1"));
  assert.deepEqual([outcome.result, outcome.effect], ["VALID", "RECORDED_ONLY"]);
});

// ---- Classification and the QR window ---------------------------------------------------------

test("classification follows the synced register across ATTENDANCE_EVIDENCE_STARTED_AT (both ways)", async () => {
  reset();
  openRegister();
  // LIVE -> HISTORICAL (before 2026-08-15): QR is refused.
  const old = new Date("2026-08-10T12:30:00.000Z");
  await edit({ date: old, endDate: at(60, 0, old) });
  setNow(at(5, 0, old));
  await assert.rejects(scan(token(1, "s1")), (e) => e.code === "ATTENDANCE_LECTURE_HISTORICAL");

  // HISTORICAL -> LIVE again.
  await edit({ date: START, endDate: END });
  setNow(at(5));
  assert.equal((await scan(token(2, "s2"))).result, "VALID");
});

test("QR window and PRESENT / LATE use the same synced start", async () => {
  reset();
  setNow(at(-60));
  openRegister();
  const newStart = at(60);
  await edit({ date: newStart, endDate: at(180) });

  setNow(at(-30, -1, newStart));
  await assert.rejects(scan(token(1, "s1")), (e) => e.code === "ATTENDANCE_QR_NOT_OPEN" && e.details.opensAt === at(-30, 0, newStart).toISOString());
  setNow(at(10, 0, newStart));
  assert.equal((await scan(token(1, "s1"))).attendance.status, "PRESENT");
  setNow(at(10, 1, newStart));
  assert.equal((await scan(token(2, "s2"))).attendance.status, "LATE");
});

// ---- Concurrency ----------------------------------------------------------------------------------

function gateOn(label, op) {
  let release;
  const gate = new Promise((r) => { release = r; });
  pg.beforeStatement = async (l, o) => {
    if (l === label && o === op) await gate;
  };
  return release;
}

test("concurrent: a scan holding the lecture first commits; the edit waits, then recalculates the new record", async () => {
  reset();
  openRegister();
  setNow(at(8)); // PRESENT under START
  const release = gateOn("tx1", "create:scan");
  const scanning = scan(token(1, "s1"));
  while (!pg.log.includes("tx1:insert:record:s1")) await tick();
  const editing = edit({ date: at(-5) }); // boundary START + 5: the scan becomes LATE
  while (!pg.log.some((e) => e.startsWith("tx2:waits:lecture:"))) await tick();
  release();
  await scanning;
  await editing;
  assert.deepEqual([record("s1").status, record("s1").autoStatus, record("s1").version], ["LATE", "LATE", 2]);
  assert.equal(registerAudits().at(-1).recalculatedCount, 1);
  assertChain("s1");
});

test("concurrent: an edit holding the lecture first makes a scan wait; the scan is judged against the new start", async () => {
  reset();
  openRegister();
  setNow(at(8));
  const release = gateOn("tx1", "update:lecture");
  const editing = edit({ date: at(-5) });
  while (!pg.held.some((h) => h.row === `lecture:${L1}` && h.mode === "NO_KEY_UPDATE")) await tick();
  const scanning = scan(token(1, "s1"));
  while (!pg.log.some((e) => e.startsWith("tx2:waits:lecture:"))) await tick();
  release();
  await editing;
  assert.equal((await scanning).attendance.status, "LATE");
});

test("concurrent: a teacher decision and a closure in progress make the edit wait; the edit then sees them", async () => {
  reset();
  openRegister();
  setNow(at(8));
  let release = gateOn("tx1", "create:audit");
  const deciding = decisions.setTeacherAttendanceStatus({ teacherId: T1, lectureId: L1, studentId: "s1", status: "PRESENT", expectedVersion: null });
  while (!pg.log.includes("tx1:insert:record:s1")) await tick();
  const editing = edit({ endDate: at(150) });
  while (!pg.log.some((e) => e.startsWith("tx2:waits:lecture:"))) await tick();
  release();
  await deciding;
  await editing;
  assert.equal(pg.committed.registers[L1].scheduledEndAt.toISOString(), at(150).toISOString());

  release = gateOn("tx3", "insert:closure");
  const closing = qr.closeQrAttendance({ teacherId: T1, lectureId: L1 });
  while (!pg.held.some((h) => h.row === `register:${L1}` && h.mode === "UPDATE" && h.owner === "tx3")) await tick();
  const editing2 = edit({ endDate: at(160) });
  while (!pg.log.some((e) => e.startsWith("tx4:waits:"))) await tick();
  release();
  await closing;
  await editing2;
  assert.equal(pg.committed.registers[L1].scheduledEndAt.toISOString(), at(160).toISOString());
  assert.ok(pg.committed.qrClosures[L1]);
});

test("lock timeout: an edit blocked by attendance work fails with 409 ATTENDANCE_BUSY; nothing changes", async () => {
  reset();
  openRegister();
  pg.held.push({ row: `lecture:${L1}`, owner: "scan-in-progress", mode: "SHARE" });
  pg.failWhenBlocked = true;
  await assert.rejects(edit({ date: at(-5) }), (e) => e.code === "ATTENDANCE_BUSY" && e.statusCode === 409);
  assert.equal(pg.committed.lectures[L1].date.toISOString(), START.toISOString());
  assert.equal(pg.committed.registers[L1].version, 1);
  assert.equal(waiverCalls.length, 0);
});

// ---- Atomicity, validation and lock order ------------------------------------------------------------

test("an audit failure rolls the lecture update back with the register sync", async () => {
  reset();
  openRegister();
  seedRecord("s1", { status: "PRESENT", statusSource: "AUTO", firstQrAt: at(8), autoStatus: "PRESENT" });
  for (const op of ["create:registerAudit", "create:audit"]) {
    pg.failOn = (label, statement) => (statement === op ? Object.assign(new Error(`simulated ${op} failure`), { name: "PrismaClientKnownRequestError", code: "P2010", __db: true }) : null);
    await assert.rejects(edit({ date: at(-5) }), new RegExp(`simulated ${op} failure`));
    assert.equal(pg.committed.lectures[L1].date.toISOString(), START.toISOString(), op);
    assert.equal(pg.committed.registers[L1].version, 1, op);
    assert.equal(record("s1").version, 1, op);
    assert.equal(registerAudits().length, 1, op);
  }
  assert.equal(waiverCalls.length, 0);
});

test("ownership and the end time are re-checked under the lock", async () => {
  reset();
  openRegister();
  await assert.rejects(edit({ date: at(-5) }, T2), (e) => e.code === "LECTURE_NOT_FOUND" && e.statusCode === 404);
  // Deleted between the ownership read and the lock.
  pg.afterOwnershipRead = async () => { pg.committed.lectures[L1].status = 1; };
  await assert.rejects(edit({ date: at(-5) }), (e) => e.code === "LECTURE_NOT_FOUND");
  pg.afterOwnershipRead = null;
  pg.committed.lectures[L1].status = 0;
  // The stored end moved earlier between the read and the lock: the new start no longer fits.
  pg.afterOwnershipRead = async () => { pg.committed.lectures[L1].endDate = at(30); };
  await assert.rejects(edit({ date: at(40) }), (e) => e.code === "LECTURE_END_NOT_AFTER_START" && e.statusCode === 400);
  assert.equal(pg.committed.registers[L1].version, 1);
});

test("lock order: Lecture (NO KEY UPDATE), register (UPDATE), records; then the writes", async () => {
  reset();
  openRegister();
  seedRecord("s2", { status: "LATE", statusSource: "AUTO", firstQrAt: at(20), autoStatus: "LATE" });
  seedRecord("s1", { status: "PRESENT", statusSource: "AUTO", firstQrAt: at(8), autoStatus: "PRESENT" });
  await edit({ date: at(-5) });
  const statements = pg.transactions.at(-1).statements;
  const order = ["SET", "lock:lecture", "read:lecture", "lock:register", "read:records", "lock:records", "update:lecture", "update:register", "create:registerAudit", "update:record", "create:audit"];
  const firsts = order.map((step) => statements.indexOf(step));
  assert.ok(firsts.every((i) => i >= 0), JSON.stringify(statements));
  assert.deepEqual([...firsts].sort((a, b) => a - b), firsts, JSON.stringify(statements));
  assert.ok(!statements.includes("lock:class") && !statements.includes("lock:student"));
  assert.ok(pg.held.length === 0);
});

// ---- Finalized-lecture protection -------------------------------------------------------------------------

test("a lecture with a finalized register cannot be cancelled or deleted (409); nothing changes", async () => {
  reset();
  openRegister({ finalizedAt: at(130), finalizedByTeacherId: T1, version: 2 });
  await assert.rejects(lectures.updateLectureClassStatusForTeacher(T1, L1, "CANCELLED"), (e) => e.code === "LECTURE_ATTENDANCE_FINALIZED" && e.statusCode === 409);
  await assert.rejects(lectures.deleteLectureForTeacher(T1, L1), (e) => e.code === "LECTURE_ATTENDANCE_FINALIZED");
  assert.deepEqual([pg.committed.lectures[L1].classStatus, pg.committed.lectures[L1].status], ["SCHEDULED", 0]);
  assert.equal(waiverCalls.length, 0);
  // COMPLETED does not change attendance: still allowed (existing path).
  assert.equal((await lectures.updateLectureClassStatusForTeacher(T1, L1, "COMPLETED")).classStatus, "COMPLETED");
});

test("open or no register: cancelling and deleting work as before", async () => {
  reset();
  openRegister();
  assert.equal((await lectures.updateLectureClassStatusForTeacher(T1, L1, "CANCELLED")).classStatus, "CANCELLED");
  reset();
  await lectures.deleteLectureForTeacher(T1, L1);
  assert.equal(pg.committed.lectures[L1].status, 1);
  assert.equal(waiverCalls.length, 1);
});

test("the guard re-checks under the lock: a register finalized after the ownership read still blocks", async () => {
  reset();
  openRegister();
  pg.afterOwnershipRead = async () => {
    pg.committed.registers[L1] = { ...pg.committed.registers[L1], finalizedAt: at(130), finalizedByTeacherId: T1, version: 2 };
  };
  await assert.rejects(lectures.deleteLectureForTeacher(T1, L1), (e) => e.code === "LECTURE_ATTENDANCE_FINALIZED");
  assert.equal(pg.committed.lectures[L1].status, 0);
});

test("recalculation helper (pure): only changed records; AUTO follows, others keep their status", () => {
  const base = { lectureId: L1, classId: C1, teacherDecidedAt: null, teacherDecidedById: null, pendingReviewSince: null, version: 1, createdAt: START, updatedAt: START, firstOnlineAt: null };
  const changes = attendance.planAutoStatusRecalculation(
    [
      { ...base, id: "a", studentId: "a", status: "PRESENT", statusSource: "AUTO", firstQrAt: at(12), autoStatus: "PRESENT", teacherStatus: null },
      { ...base, id: "b", studentId: "b", status: "EXCUSED", statusSource: "TEACHER", firstQrAt: at(12), autoStatus: "PRESENT", teacherStatus: "EXCUSED" },
      { ...base, id: "c", studentId: "c", status: "LATE", statusSource: "AUTO", firstQrAt: at(12), autoStatus: "LATE", teacherStatus: null },
    ],
    { scheduledStartAt: START, graceMinutes: 10 }
  );
  assert.deepEqual(changes.map((c) => [c.record.id, c.autoStatus, c.status]), [["a", "LATE", "LATE"], ["b", "LATE", "EXCUSED"]]);
  // Same rule for a future grace change (E6): a longer grace makes them PRESENT again.
  assert.deepEqual(attendance.planAutoStatusRecalculation([{ ...base, id: "c", studentId: "c", status: "LATE", statusSource: "AUTO", firstQrAt: at(12), autoStatus: "LATE", teacherStatus: null }], { scheduledStartAt: START, graceMinutes: 15 }).map((c) => c.status), ["PRESENT"]);
});
