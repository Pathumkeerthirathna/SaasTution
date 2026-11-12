/*
 * Stage 5.7b-2b-2: the per-lecture grace period
 * (services/lecture-attendance-grace-service.ts setRegisterGraceMinutes), and
 * its interplay with online / QR evidence, teacher decisions,
 * reconciliation, finalization and the class default. The real services run
 * through tsx against the in-memory PostgreSQL model
 * (helpers/attendance-pg-model.cjs: row locks, READ COMMITTED reads,
 * rollback, the CHECK constraints). No database; NOT a real-PostgreSQL
 * concurrency validation.
 *
 *   npm run test:attendance-grace   (also part of npm run test:attendance)
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
{
  const filename = path.join(root, "lib/prisma.ts");
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = { prisma: new Proxy({}, { get: (_, key) => currentPrisma[key] }) };
  require.cache[filename] = mod;
}

const grace = require(path.join(root, "services", "lecture-attendance-grace-service.ts"));
const decisions = require(path.join(root, "services", "lecture-attendance-decision-service.ts"));
const qr = require(path.join(root, "services", "lecture-attendance-qr-service.ts"));
const evidence = require(path.join(root, "services", "lecture-attendance-evidence-service.ts"));
const reconcile = require(path.join(root, "services", "lecture-attendance-reconcile-service.ts"));
const finalization = require(path.join(root, "services", "lecture-attendance-finalization-service.ts"));
const preview = require(path.join(root, "services", "lecture-attendance-finalization-preview-service.ts"));
const qrToken = require(path.join(root, "lib", "student-qr-token.ts"));

// ---- Clock and fixtures ------------------------------------------------------------------

const START = new Date("2026-09-01T12:30:00.000Z");
const at = (minutes) => new Date(START.getTime() + minutes * 60_000);
test.mock.timers.enable({ apis: ["Date"], now: at(60) });
const setNow = (date) => test.mock.timers.setTime(date.getTime());

const T1 = "teacher-1";
const T2 = "teacher-2";
const C1 = "class-1";
const L1 = "lecture-1";
const L2 = "lecture-2";
const APPROVED_AT = new Date("2026-08-01T00:00:00.000Z");
const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 5 + 1) % 256));
const ENV = {
  APPROVAL_FEATURE_STARTED_AT: "2026-07-28T00:00:00Z",
  ATTENDANCE_EVIDENCE_STARTED_AT: "2026-08-15T00:00:00Z",
  STUDENT_QR_SECRET: SECRET.toString("base64"),
};

let model;
let pg;
let visitSeq = 0;
let scanSeq = 0;

function student(id, { teacherId = T1 } = {}) {
  pg.committed.students[id] = {
    id, name: id, registrationNumber: null, teacherId, status: 0, confirmationStatus: "APPROVED", confirmedAt: APPROVED_AT, approvedAt: APPROVED_AT,
  };
  pg.committed.history.push({ id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: "APPROVED", decidedAt: APPROVED_AT, previousConfirmedAt: null });
  pg.committed.enrolments.push({ id: `e-${id}`, studentId: id, classId: C1, assignedAt: new Date("2026-08-05T05:30:00Z"), removedAt: null, isActive: true });
}

function reset() {
  model = createPgModel();
  pg = model.pg;
  currentPrisma = model.prisma;
  visitSeq = 0;
  pg.committed.classes[C1] = { id: C1, teacherId: T1, status: 0, attendanceGraceMinutes: 10 };
  pg.committed.classes["class-2"] = { id: "class-2", teacherId: T2, status: 0, attendanceGraceMinutes: 10 };
  pg.committed.lectures[L1] = { id: L1, classId: C1, status: 0, classStatus: "LIVE", date: START, endDate: at(120) };
  pg.committed.lectures[L2] = { id: L2, classId: C1, status: 0, classStatus: "SCHEDULED", date: at(60 * 24), endDate: at(60 * 24 + 120) };
  for (const id of ["s1", "s2", "s3", "s4", "s5", "s6", "s7"]) student(id);
  pg.committed.sessions["session-1"] = { id: "session-1", lectureId: L1 };
  setNow(at(60));
}

function openRegister({ graceMinutes = 10, version = 1, finalized = false } = {}) {
  pg.committed.registers[L1] = {
    lectureId: L1, classId: C1, scheduledStartAt: START, scheduledEndAt: at(120), graceMinutes,
    finalizedAt: finalized ? at(130) : null, finalizedByTeacherId: finalized ? T1 : null, version, createdAt: at(-30), updatedAt: at(-30),
  };
  pg.committed.registerAudits.push({ id: "reg-audit-1", lectureId: L1, version: 1, action: "CREATED", toGraceMinutes: graceMinutes, actorRole: "SYSTEM", actorId: null, createdAt: at(-30) });
}

function seedRecord(studentId, fields) {
  const row = {
    id: `rec-${studentId}`, lectureId: L1, classId: C1, studentId, firstOnlineAt: null, firstQrAt: null, autoStatus: null, teacherStatus: null,
    teacherDecidedAt: null, teacherDecidedById: null, pendingReviewSince: null, version: 1, createdAt: at(1), updatedAt: at(1), ...fields,
  };
  model.checkRecord(row);
  pg.committed.records[`${L1}:${studentId}`] = row;
  pg.committed.recordAudits.push({ id: `seed-${studentId}`, lectureAttendanceId: row.id, version: row.version, lectureId: L1, studentId, action: "CREATED_AUTO", toStatus: row.status });
  return row;
}

const teacher = (status, extra = {}) => ({ status, statusSource: "TEACHER", teacherStatus: status, teacherDecidedAt: at(50), teacherDecidedById: T1, ...extra });

/** The mixed register: evidence at +20 / +25 / +15 minutes (LATE under 10, PRESENT under 30), plus unaffected rows. */
function mixedRegister() {
  openRegister();
  seedRecord("s1", { status: "LATE", statusSource: "AUTO", firstOnlineAt: at(20), autoStatus: "LATE" });
  seedRecord("s2", teacher("ABSENT", { firstQrAt: at(25), autoStatus: "LATE", pendingReviewSince: at(26) }));
  seedRecord("s3", { status: "PRESENT", statusSource: "BACKFILL", firstOnlineAt: at(15), autoStatus: "LATE" });
  seedRecord("s4", { status: "ABSENT", statusSource: "FINALIZATION", firstQrAt: at(22), autoStatus: "LATE", pendingReviewSince: at(23) });
  seedRecord("s5", { status: "PRESENT", statusSource: "AUTO", firstOnlineAt: at(2), autoStatus: "PRESENT" }); // PRESENT under both
  seedRecord("s6", teacher("EXCUSED")); // no evidence
}

const change = (graceMinutes, expectedVersion, reason, teacherId = T1, lectureId = L1) =>
  grace.setRegisterGraceMinutes({ teacherId, lectureId, graceMinutes, expectedVersion, reason });

const record = (studentId, lectureId = L1) => pg.committed.records[`${lectureId}:${studentId}`] ?? null;
const registerAudits = (lectureId = L1) => pg.committed.registerAudits.filter((a) => a.lectureId === lectureId).sort((a, b) => a.version - b.version);
const recordAuditsOf = (action) => pg.committed.recordAudits.filter((a) => a.action === action);
const snapshot = () => JSON.stringify([pg.committed.registers, pg.committed.registerAudits, pg.committed.records, pg.committed.recordAudits]);
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function refused(promise, check) {
  const before = snapshot();
  await assert.rejects(promise, check);
  assert.equal(snapshot(), before, "nothing written");
}

function visit(studentId, joinedAt) {
  const id = `visit-${String(++visitSeq).padStart(4, "0")}`;
  pg.committed.visits[id] = { id, studentId, joinedAt, classSessionId: "session-1" };
  return id;
}

function token(n, studentId) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const nonce = Buffer.alloc(32, n).toString("base64url");
  const value = qrToken.deriveStudentQrToken(SECRET, id, nonce);
  pg.committed.tokens[id] = { id, studentId, nonce, tokenHash: qrToken.hashStudentQrToken(value), revokedAt: null };
  return qrToken.buildStudentQrPayload(value);
}
const scan = (payload) => qr.recordQrScan({ teacherId: T1, lectureId: L1, clientScanId: `grace-scan-${String(++scanSeq).padStart(6, "0")}`, payload }, { env: ENV });

function gateOn(label, op) {
  let release;
  const gate = new Promise((r) => { release = r; });
  pg.beforeStatement = async (l, o) => {
    if (l === label && o === op) await gate;
  };
  return () => {
    pg.beforeStatement = null;
    release();
  };
}
async function waitUntil(condition, label) {
  for (let i = 0; i < 200 && !condition(); i += 1) await tick();
  assert.ok(condition(), label);
}

// ======================================================================================
// Effective change on an open register
// ======================================================================================

test("open register: grace stored, version + 1 exactly once, one GRACE_CHANGED audit (the teacher, from / to, reason, count)", async () => {
  reset();
  mixedRegister();
  const result = await change(30, 1, "  Bus strike this morning.  ");
  assert.deepEqual(result, { lectureId: L1, graceMinutes: 30, registerVersion: 2, changed: true, registerCreated: false, recalculatedCount: 4 });

  const reg = pg.committed.registers[L1];
  assert.deepEqual([reg.graceMinutes, reg.version, reg.updatedAt.getTime()], [30, 2, at(60).getTime()]);
  const audits = registerAudits();
  assert.equal(audits.length, 2);
  assert.deepEqual(
    { action: audits[1].action, version: audits[1].version, from: audits[1].fromGraceMinutes, to: audits[1].toGraceMinutes, count: audits[1].recalculatedCount, role: audits[1].actorRole, actor: audits[1].actorId, reason: audits[1].reason },
    { action: "GRACE_CHANGED", version: 2, from: 10, to: 30, count: 4, role: "TEACHER", actor: T1, reason: "Bus strike this morning." }
  );
  assert.equal(audits[1].fromScheduledStartAt ?? null, null, "only the grace is part of this change");
});

test("recalculation: AUTO follows; TEACHER / BACKFILL / FINALIZATION keep their status (autoStatus only); reviews untouched; unaffected rows untouched", async () => {
  reset();
  mixedRegister();
  const before = { s5: { ...record("s5") }, s6: { ...record("s6") } };
  await change(30, 1, "Late bus.");

  assert.deepEqual([record("s1").status, record("s1").statusSource, record("s1").autoStatus, record("s1").version], ["PRESENT", "AUTO", "PRESENT", 2], "AUTO follows");
  assert.deepEqual([record("s2").status, record("s2").teacherStatus, record("s2").autoStatus], ["ABSENT", "ABSENT", "PRESENT"], "TEACHER kept");
  assert.deepEqual([record("s3").status, record("s3").statusSource, record("s3").autoStatus], ["PRESENT", "BACKFILL", "PRESENT"], "BACKFILL kept");
  assert.deepEqual([record("s4").status, record("s4").statusSource, record("s4").autoStatus], ["ABSENT", "FINALIZATION", "PRESENT"], "FINALIZATION kept");
  assert.equal(record("s2").pendingReviewSince.getTime(), at(26).getTime(), "an open review is kept as it was");
  assert.equal(record("s4").pendingReviewSince.getTime(), at(23).getTime());
  assert.equal(record("s1").pendingReviewSince, null, "no review is raised");
  assert.deepEqual(record("s5"), before.s5, "PRESENT under both graces: untouched");
  assert.deepEqual(record("s6"), before.s6, "no evidence: untouched");
  assert.deepEqual(Object.keys(pg.committed.visits), [], "no visit is created or touched");
  assert.deepEqual(pg.committed.scans, [], "no evidence event is created");
});

test("every recalculated record has one AUTO_RECALCULATED audit (SYSTEM) linked to the GRACE_CHANGED audit", async () => {
  reset();
  mixedRegister();
  await change(30, 1, "Late bus.");
  const graceAudit = registerAudits().find((a) => a.action === "GRACE_CHANGED");
  const recalculated = recordAuditsOf("AUTO_RECALCULATED");
  assert.deepEqual(recalculated.map((a) => a.studentId).sort(), ["s1", "s2", "s3", "s4"]);
  for (const a of recalculated) {
    assert.equal(a.registerAuditId, graceAudit.id, a.studentId);
    assert.deepEqual([a.actorRole, a.actorId, a.reason, a.afterFinalization, a.toAutoStatus, a.fromAutoStatus], ["SYSTEM", null, null, false, "PRESENT", "LATE"]);
    assert.equal(a.version, record(a.studentId).version);
  }
  assert.equal(graceAudit.recalculatedCount, recalculated.length);
});

test("a smaller grace makes PRESENT evidence LATE (AUTO follows down too)", async () => {
  reset();
  openRegister({ graceMinutes: 30 });
  seedRecord("s1", { status: "PRESENT", statusSource: "AUTO", firstOnlineAt: at(20), autoStatus: "PRESENT" });
  const result = await change(5, 1, "Strict start.");
  assert.equal(result.recalculatedCount, 1);
  assert.deepEqual([record("s1").status, record("s1").autoStatus], ["LATE", "LATE"]);
});

test("boundaries: 0 and 240 accepted; evidence exactly at start + grace is PRESENT", async () => {
  reset();
  openRegister();
  seedRecord("s1", { status: "LATE", statusSource: "AUTO", firstOnlineAt: at(20), autoStatus: "LATE" });
  const to20 = await change(20, 1, "Exactly the boundary.");
  assert.equal(to20.recalculatedCount, 1);
  assert.equal(record("s1").status, "PRESENT", "at start + 20 minutes with grace 20: PRESENT (inclusive)");
  await change(240, 2);
  await change(0, 3, "No grace.");
  assert.deepEqual([pg.committed.registers[L1].graceMinutes, pg.committed.registers[L1].version, record("s1").status], [0, 4, "LATE"]);
});

// ======================================================================================
// Reason rule
// ======================================================================================

test("reason: required when records are recalculated (missing, empty, whitespace → 400, nothing written)", async () => {
  reset();
  mixedRegister();
  for (const reason of [undefined, null, "", "   \n "]) {
    await refused(change(30, 1, reason), (e) => e.code === "ATTENDANCE_REASON_REQUIRED" && e.statusCode === 400);
  }
  await refused(change(30, 1, "x".repeat(501)), (e) => e.code === "VALIDATION_ERROR" && e.details.field === "reason");
});

test("reason: optional when no record with evidence changes (none, or none affected)", async () => {
  reset();
  openRegister();
  seedRecord("s5", { status: "PRESENT", statusSource: "AUTO", firstOnlineAt: at(2), autoStatus: "PRESENT" });
  seedRecord("s6", teacher("EXCUSED"));
  const result = await change(15, 1);
  assert.deepEqual([result.changed, result.recalculatedCount], [true, 0]);
  const audit = registerAudits().at(-1);
  assert.deepEqual([audit.action, audit.reason, audit.recalculatedCount], ["GRACE_CHANGED", null, 0]);
});

// ======================================================================================
// No-ops and register creation
// ======================================================================================

test("same value as stored: a no-op (no write, no audit, no version change)", async () => {
  reset();
  mixedRegister();
  const before = snapshot();
  assert.deepEqual(await change(10, 1), { lectureId: L1, graceMinutes: 10, registerVersion: 1, changed: false, registerCreated: false, recalculatedCount: 0 });
  assert.equal(snapshot(), before);
});

test("no register and the class default requested: a no-op that creates nothing", async () => {
  reset();
  const before = snapshot();
  assert.deepEqual(await change(10, 0), { lectureId: L1, graceMinutes: 10, registerVersion: 0, changed: false, registerCreated: false, recalculatedCount: 0 });
  assert.equal(snapshot(), before);
  assert.equal(pg.committed.registers[L1], undefined);
});

test("no register and another value: created from the class default (CREATED v1), then changed (GRACE_CHANGED v2)", async () => {
  reset();
  pg.committed.classes[C1].attendanceGraceMinutes = 12;
  const result = await change(25, 0);
  assert.deepEqual(result, { lectureId: L1, graceMinutes: 25, registerVersion: 2, changed: true, registerCreated: true, recalculatedCount: 0 });
  const audits = registerAudits();
  assert.deepEqual(audits.map((a) => [a.version, a.action, a.fromGraceMinutes ?? null, a.toGraceMinutes, a.actorRole, a.actorId]), [
    [1, "CREATED", null, 12, "TEACHER", T1],
    [2, "GRACE_CHANGED", 12, 25, "TEACHER", T1],
  ]);
  assert.deepEqual([pg.committed.registers[L1].graceMinutes, pg.committed.registers[L1].version], [25, 2]);
  // Without a register a version other than 0 is stale.
  reset();
  await refused(change(25, 1), (e) => e.code === "ATTENDANCE_REGISTER_CHANGED" && e.statusCode === 409);
});

test("historical lectures are allowed (no attendance configuration is needed)", async () => {
  reset();
  pg.committed.lectures[L1].date = new Date("2026-08-01T12:30:00.000Z");
  pg.committed.lectures[L1].endDate = new Date("2026-08-01T14:30:00.000Z");
  pg.committed.lectures[L1].classStatus = "COMPLETED";
  const result = await change(20, 0, "Historical correction.");
  assert.deepEqual([result.changed, result.registerCreated], [true, true]);
});

// ======================================================================================
// Refusals
// ======================================================================================

test("refusals: finalized 409, cancelled 409, another teacher's / deleted / unknown lecture 404, stale version 409; nothing written", async () => {
  reset();
  openRegister({ finalized: true });
  await refused(change(30, 1, "x"), (e) => e.code === "ATTENDANCE_REGISTER_FINALIZED" && e.statusCode === 409);
  reset();
  openRegister();
  pg.committed.lectures[L1].classStatus = "CANCELLED";
  await refused(change(30, 1, "x"), (e) => e.code === "LECTURE_CANCELLED" && e.statusCode === 409);
  reset();
  openRegister();
  await refused(change(30, 1, "x", T2), (e) => e.code === "LECTURE_NOT_FOUND" && e.statusCode === 404);
  pg.committed.lectures[L1].status = 1;
  await refused(change(30, 1, "x"), (e) => e.code === "LECTURE_NOT_FOUND");
  await refused(change(30, 0, "x", T1, "no-such-lecture"), (e) => e.code === "LECTURE_NOT_FOUND");
  reset();
  openRegister({ version: 3 });
  for (const expectedVersion of [0, 2, 4]) {
    await refused(change(30, expectedVersion, "x"), (e) => e.code === "ATTENDANCE_REGISTER_CHANGED" && e.statusCode === 409);
  }
  assert.equal(pg.transactions.filter((t) => t.outcome === "commit").length, 0, "no retry, nothing committed");
});

test("invalid inputs are 400 before any transaction", async () => {
  reset();
  for (const [g, v, field] of [[-1, 1, "graceMinutes"], [241, 1, "graceMinutes"], [1.5, 1, "graceMinutes"], ["10", 1, "graceMinutes"], [null, 1, "graceMinutes"], [10, -1, "expectedVersion"], [10, 1.5, "expectedVersion"], [10, "1", "expectedVersion"]]) {
    await assert.rejects(change(g, v), (e) => e.code === "VALIDATION_ERROR" && e.details.field === field, `${g} ${v}`);
  }
  await assert.rejects(change(10, 1, undefined, ""), (e) => e.code === "VALIDATION_ERROR");
  assert.equal(pg.transactions.length, 0);
});

test("atomic: a failure in the middle of the recalculation rolls everything back", async () => {
  reset();
  mixedRegister();
  let audits = 0;
  pg.failOn = (label, op) => (op === "create:audit" && ++audits === 2 ? new Error("simulated database failure") : null);
  await refused(change(30, 1, "Late bus."), (e) => /simulated database failure/.test(e.message));
  assert.equal(pg.transactions[0].outcome, "rollback");
  assert.deepEqual([pg.committed.registers[L1].graceMinutes, pg.committed.registers[L1].version], [10, 1]);
});

test("lock order: Lecture FOR SHARE, Class FOR KEY SHARE, Register FOR UPDATE, records (ascending), then the writes", async () => {
  reset();
  mixedRegister();
  await change(30, 1, "Late bus.");
  const statements = pg.transactions[0].statements;
  const order = ["SET", "lock:lecture", "lock:class", "lock:register", "read:records", "lock:records", "update:register", "create:registerAudit", "update:record", "create:audit"];
  const firsts = order.map((step) => statements.indexOf(step));
  assert.ok(firsts.every((i) => i >= 0), JSON.stringify(statements));
  assert.deepEqual([...firsts].sort((a, b) => a - b), firsts, JSON.stringify(statements));
  assert.ok(!statements.includes("lock:student"), "no Student lock (eligibility is not used)");
  assert.deepEqual(pg.transactions[0].options, { maxWait: 5000, timeout: 15000 });
});

test("a register held by another transaction: waits, or 409 ATTENDANCE_BUSY on the lock timeout; nothing written", async () => {
  reset();
  mixedRegister();
  pg.held.push({ row: `register:${L1}`, owner: "elsewhere", mode: "KEY_SHARE" });
  pg.failWhenBlocked = true;
  await refused(change(30, 1, "x"), (e) => e.code === "ATTENDANCE_BUSY" && e.statusCode === 409);
});

// ======================================================================================
// Class default (the register keeps its own copy)
// ======================================================================================

test("class default: changing it never touches an existing register; a NEW register copies the new default", async () => {
  reset();
  mixedRegister();
  const before = snapshot();
  pg.committed.classes[C1].attendanceGraceMinutes = 45; // the class-service update
  assert.equal(snapshot(), before, "existing registers and audits unchanged");
  // L1 keeps classifying with its stored 10.
  setNow(at(61));
  const v = visit("s7", at(30));
  await evidence.recordOnlineEvidence(v, { env: ENV });
  assert.equal(record("s7").status, "LATE", "+30 min with the register's 10: LATE (not the class's 45)");
  // A new register (L2) copies 45.
  assert.deepEqual(await change(45, 0, undefined, T1, L2), { lectureId: L2, graceMinutes: 45, registerVersion: 0, changed: false, registerCreated: false, recalculatedCount: 0 });
  const created = await change(50, 0, undefined, T1, L2);
  assert.equal(created.registerCreated, true);
  assert.deepEqual(registerAudits(L2).map((a) => [a.action, a.fromGraceMinutes ?? null, a.toGraceMinutes]), [["CREATED", null, 45], ["GRACE_CHANGED", 45, 50]]);
});

// ======================================================================================
// Concurrency (in-memory model: order and waits, not real PostgreSQL)
// ======================================================================================

test("grace first, online evidence waits on the register and then uses the NEW grace", async () => {
  reset();
  openRegister();
  const release = gateOn("tx1", "update:register");
  const changing = change(30, 1);
  await waitUntil(() => pg.transactions[0]?.statements.includes("lock:register"), "grace holds the register");
  const v = visit("s1", at(20));
  const recording = evidence.recordOnlineEvidence(v, { env: ENV });
  for (let i = 0; i < 30; i += 1) await tick();
  assert.equal(record("s1"), null, "evidence waits for the register");
  release();
  await changing;
  await recording;
  assert.deepEqual([record("s1").status, record("s1").autoStatus], ["PRESENT", "PRESENT"], "+20 with grace 30");
});

test("online evidence first (holding the register), the grace change waits and then recalculates it (reason required)", async () => {
  reset();
  openRegister();
  const v = visit("s1", at(20));
  const release = gateOn("tx1", "create:audit");
  const recording = evidence.recordOnlineEvidence(v, { env: ENV });
  await waitUntil(() => pg.transactions[0]?.statements.includes("lock:register"), "evidence holds the register");
  const changing = change(30, 1, "Late bus.");
  for (let i = 0; i < 30; i += 1) await tick();
  assert.equal(pg.committed.registers[L1].graceMinutes, 10, "the grace change waits");
  release();
  await recording;
  const result = await changing;
  assert.equal(result.recalculatedCount, 1);
  assert.deepEqual([record("s1").status, record("s1").autoStatus, record("s1").version], ["PRESENT", "PRESENT", 2]);
  assert.deepEqual(recordAuditsOf("AUTO_RECALCULATED").map((a) => a.studentId), ["s1"]);
});

test("QR evidence after a grace change is classified with the new grace; QR evidence before it is recalculated", async () => {
  reset();
  openRegister();
  setNow(at(20));
  await scan(token(1, "s1")); // +20 with 10: LATE
  assert.equal(record("s1").status, "LATE");
  setNow(at(21));
  await change(30, 1, "Gate queue at the entrance.");
  assert.equal(record("s1").status, "PRESENT", "recalculated");
  setNow(at(35));
  await scan(token(2, "s2")); // +35 with 30: LATE
  setNow(at(39));
  await scan(token(3, "s3"));
  assert.deepEqual([record("s2").status, record("s3").status], ["LATE", "LATE"]);
  const s4 = await scan(token(4, "s4"));
  assert.equal(s4.result, "VALID");
});

test("teacher decision on a record the grace change recalculated: 409 ATTENDANCE_RECORD_CHANGED (stale version, no retry)", async () => {
  reset();
  openRegister();
  seedRecord("s1", { status: "LATE", statusSource: "AUTO", firstOnlineAt: at(20), autoStatus: "LATE" });
  const seenVersion = record("s1").version;
  await change(30, 1, "Late bus.");
  await assert.rejects(decisions.setTeacherAttendanceStatus({ teacherId: T1, lectureId: L1, studentId: "s1", status: "ABSENT", expectedVersion: seenVersion, reason: "x" }), (e) => e.code === "ATTENDANCE_RECORD_CHANGED");
  assert.deepEqual([record("s1").status, record("s1").version], ["PRESENT", 2]);
});

test("a teacher decision in flight holds the register: the grace change waits for it, then recalculates only the evidence status", async () => {
  reset();
  openRegister();
  seedRecord("s1", { status: "LATE", statusSource: "AUTO", firstOnlineAt: at(20), autoStatus: "LATE" });
  const release = gateOn("tx1", "create:audit");
  const deciding = decisions.setTeacherAttendanceStatus({ teacherId: T1, lectureId: L1, studentId: "s1", status: "ABSENT", expectedVersion: 1, reason: "Left early." });
  await waitUntil(() => pg.transactions[0]?.statements.includes("lock:register"), "decision holds the register");
  const changing = change(30, 1, "Late bus.");
  for (let i = 0; i < 30; i += 1) await tick();
  assert.equal(pg.committed.registers[L1].graceMinutes, 10);
  release();
  await deciding;
  await changing;
  assert.deepEqual([record("s1").status, record("s1").statusSource, record("s1").autoStatus, record("s1").version], ["ABSENT", "TEACHER", "PRESENT", 3]);
});

test("reconciliation and a grace change: serialized per student on the register; every record ends consistent with the final grace", async () => {
  reset();
  openRegister();
  for (const [id, minutes] of [["s1", 20], ["s2", 25], ["s3", 5]]) visit(id, at(minutes));
  const release = gateOn("tx2", "create:audit"); // the second student's reconciliation transaction
  const reconciling = reconcile.reconcileLectureOnlineEvidence({ teacherId: T1, lectureId: L1, cursor: null, limit: 100 }, { env: ENV });
  await waitUntil(() => pg.transactions[1]?.statements.includes("lock:register"), "reconciliation holds the register for s2");
  const changing = change(30, 1, "Late bus.");
  for (let i = 0; i < 30; i += 1) await tick();
  assert.equal(pg.committed.registers[L1].graceMinutes, 10, "the grace change waits for the reconciliation transaction");
  release();
  await reconciling;
  await changing;
  assert.equal(pg.committed.registers[L1].graceMinutes, 30);
  for (const id of ["s1", "s2", "s3"]) {
    assert.deepEqual([record(id).status, record(id).autoStatus], ["PRESENT", "PRESENT"], `${id}: consistent with grace 30`);
  }
});

test("finalization: a change before finalization makes the preview stale; after finalization the change is refused", async () => {
  reset();
  openRegister();
  setNow(at(200));
  const fp = (await preview.getLectureAttendanceFinalizationPreview({ teacherId: T1, lectureId: L1 }, { env: ENV })).fingerprint;
  await change(30, 1);
  await assert.rejects(finalization.finalizeLectureAttendance({ teacherId: T1, lectureId: L1, fingerprint: fp }, { env: ENV }), (e) => e.code === "FINALIZATION_PREVIEW_STALE");
  const fresh = (await preview.getLectureAttendanceFinalizationPreview({ teacherId: T1, lectureId: L1 }, { env: ENV })).fingerprint;
  await finalization.finalizeLectureAttendance({ teacherId: T1, lectureId: L1, fingerprint: fresh }, { env: ENV });
  await refused(change(15, pg.committed.registers[L1].version, "x"), (e) => e.code === "ATTENDANCE_REGISTER_FINALIZED");
});

test("finalization holding the register: a concurrent grace change waits, then sees the finalized register (409)", async () => {
  reset();
  openRegister();
  setNow(at(200));
  const fp = (await preview.getLectureAttendanceFinalizationPreview({ teacherId: T1, lectureId: L1 }, { env: ENV })).fingerprint;
  const release = gateOn("tx1", "create:registerAudit");
  const finalizing = finalization.finalizeLectureAttendance({ teacherId: T1, lectureId: L1, fingerprint: fp }, { env: ENV });
  await waitUntil(() => pg.transactions[0]?.statements.includes("create:registerAudit") || pg.transactions[0]?.statements.includes("update:register"), "finalization in its write phase");
  const changing = change(30, 1, "x");
  for (let i = 0; i < 30; i += 1) await tick();
  release();
  await finalizing;
  await assert.rejects(changing, (e) => e.code === "ATTENDANCE_REGISTER_FINALIZED");
  assert.equal(pg.committed.registers[L1].graceMinutes, 10);
});

test("race: evidence creates the register while a change expecting 'no register' runs: 409 ATTENDANCE_REGISTER_CHANGED (never applied to a register the teacher did not see)", async () => {
  reset();
  const v = visit("s1", at(20));
  // The evidence transaction (tx1) has inserted the register (uncommitted) and holds it.
  const release = gateOn("tx1", "lock:records");
  const recording = evidence.recordOnlineEvidence(v, { env: ENV });
  await waitUntil(() => pg.transactions[0]?.statements.includes("insert:register"), "evidence inserted the register");
  const changing = change(30, 0, "Late bus.");
  for (let i = 0; i < 30; i += 1) await tick();
  release();
  await recording;
  await assert.rejects(changing, (e) => e.code === "ATTENDANCE_REGISTER_CHANGED" && e.statusCode === 409);
  assert.deepEqual([pg.committed.registers[L1].graceMinutes, pg.committed.registers[L1].version], [10, 1], "the register created by evidence is untouched");
  assert.deepEqual(registerAudits().map((a) => a.action), ["CREATED"]);
  assert.equal(record("s1").status, "LATE", "+20 with the register's 10");
});
