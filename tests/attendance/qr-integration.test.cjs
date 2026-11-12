/*
 * Stage 5.7b-3f: physical QR attendance integrated with the rest of the
 * attendance system — online evidence, teacher decisions and reviews,
 * finalization, reconciliation, grace changes, QR closure, history and the
 * register view. The real services run through tsx against the in-memory
 * PostgreSQL model (helpers/attendance-pg-model.cjs: row locks, READ
 * COMMITTED reads, rollback, the CHECK constraints). These tests cover the
 * COMBINED flows; each service's own rules are covered by its own suite
 * (attendance-evidence, qr-window-closure, attendance-decisions, reconcile,
 * finalization-*, grace). No database: NOT a real-PostgreSQL validation.
 *
 *   node --test tests/attendance/qr-integration.test.cjs   (part of npm run test:attendance)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
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
const history = require(path.join(root, "services", "lecture-attendance-history-service.ts"));
const registerService = require(path.join(root, "services", "lecture-attendance-service.ts"));
const qrState = require(path.join(root, "services", "lecture-attendance-qr-state.ts"));
const { toAttendanceRegisterResponse } = require(path.join(root, "lib", "attendance-register-response.ts"));
const qrToken = require(path.join(root, "lib", "student-qr-token.ts"));

// ---- Clock and fixtures (as tests/attendance/grace.test.cjs) -------------------------------

const START = new Date("2026-09-01T12:30:00.000Z");
const at = (minutes) => new Date(START.getTime() + minutes * 60_000);
test.mock.timers.enable({ apis: ["Date"], now: at(60) });
const setNow = (date) => test.mock.timers.setTime(date.getTime());

const T1 = "teacher-1";
const C1 = "class-1";
const L1 = "lecture-1";
const APPROVED_AT = new Date("2026-08-01T00:00:00.000Z");
const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + 7) % 256));
const ENV = {
  APPROVAL_FEATURE_STARTED_AT: "2026-07-28T00:00:00Z",
  ATTENDANCE_EVIDENCE_STARTED_AT: "2026-08-15T00:00:00Z",
  STUDENT_QR_SECRET: SECRET.toString("base64"),
};
const STUDENTS = ["s1", "s2", "s3", "s4", "s5"];

const tokens = {};
let model;
let pg;
let visitSeq = 0;
let scanSeq = 0;

function student(id) {
  pg.committed.students[id] = {
    id, name: `Name ${id}`, registrationNumber: `REG-${id}`, teacherId: T1, status: 0, confirmationStatus: "APPROVED", confirmedAt: APPROVED_AT, approvedAt: APPROVED_AT,
  };
  pg.committed.history.push({ id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: "APPROVED", decidedAt: APPROVED_AT, previousConfirmedAt: null });
  pg.committed.enrolments.push({ id: `e-${id}`, studentId: id, classId: C1, assignedAt: new Date("2026-08-05T05:30:00Z"), removedAt: null, isActive: true });
}

function reset() {
  model = createPgModel();
  pg = model.pg;
  currentPrisma = model.prisma;
  visitSeq = 0;
  for (const key of Object.keys(tokens)) delete tokens[key]; // tokens live in the model: a fresh one per test
  pg.committed.classes[C1] = { id: C1, teacherId: T1, status: 0, attendanceGraceMinutes: 10 };
  pg.committed.lectures[L1] = { id: L1, classId: C1, status: 0, classStatus: "LIVE", date: START, endDate: at(120) };
  for (const id of STUDENTS) student(id);
  pg.committed.sessions["session-1"] = { id: "session-1", lectureId: L1 };
  setNow(at(60));
}

const record = (studentId) => pg.committed.records[`${L1}:${studentId}`] ?? null;
const recordsOf = (studentId) => Object.values(pg.committed.records).filter((r) => r.studentId === studentId && r.lectureId === L1);
const auditsOf = (studentId) => pg.committed.recordAudits.filter((a) => a.studentId === studentId && a.lectureId === L1).sort((a, b) => a.version - b.version);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function visit(studentId, joinedAt) {
  const id = `visit-${String(++visitSeq).padStart(4, "0")}`;
  pg.committed.visits[id] = { id, studentId, joinedAt, classSessionId: "session-1" };
  return id;
}
const online = (studentId, joinedAt) => evidence.recordOnlineEvidence(visit(studentId, joinedAt), { env: ENV });

function payloadOf(studentId) {
  if (tokens[studentId]) return tokens[studentId];
  const n = Object.keys(tokens).length + 1;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const nonce = Buffer.alloc(32, n).toString("base64url");
  const value = qrToken.deriveStudentQrToken(SECRET, id, nonce);
  pg.committed.tokens[id] = { id, studentId, nonce, tokenHash: qrToken.hashStudentQrToken(value), revokedAt: null };
  tokens[studentId] = qrToken.buildStudentQrPayload(value);
  return tokens[studentId];
}
function scan(studentId, clientScanId = `integration-scan-${String(++scanSeq).padStart(6, "0")}`) {
  return qr.recordQrScan({ teacherId: T1, lectureId: L1, clientScanId, payload: payloadOf(studentId) }, { env: ENV });
}
const close = () => qr.closeQrAttendance({ teacherId: T1, lectureId: L1 });
const decide = (studentId, status, reason = null) =>
  decisions.setTeacherAttendanceStatus({ teacherId: T1, lectureId: L1, studentId, status, expectedVersion: record(studentId)?.version ?? null, reason });
const fingerprint = async () => (await preview.getLectureAttendanceFinalizationPreview({ teacherId: T1, lectureId: L1 }, { env: ENV })).fingerprint;
const finalize = (fp) => finalization.finalizeLectureAttendance({ teacherId: T1, lectureId: L1, fingerprint: fp }, { env: ENV });
const reconcileAll = () => reconcile.reconcileLectureOnlineEvidence({ teacherId: T1, lectureId: L1, cursor: null, limit: 100 }, { env: ENV });

/** The register as the teacher's GET answers it (the explicit response mapping and the QR state). */
async function registerResponse() {
  const view = await registerService.getRegister(T1, L1, { env: ENV, now: new Date() });
  return toAttendanceRegisterResponse(view, await qrState.getRegisterQrState(view, { env: ENV, now: new Date() }));
}

function gateOn(label, op) {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  pg.beforeStatement = async (l, o) => {
    if (l === label && o === op) await gate;
  };
  return () => {
    pg.beforeStatement = null;
    release();
  };
}
async function waitUntil(condition, label) {
  for (let i = 0; i < 300 && !condition(); i += 1) await tick();
  assert.ok(condition(), label);
}
const scansFor = (studentId) => pg.committed.scans.filter((s) => s.studentId === studentId);

// ======================================================================================
// 1. Physical QR + online evidence
// ======================================================================================

test("online first, then QR: one record; online decides; the QR time is kept; later scans are duplicates; counted once", async () => {
  reset();
  await online("s1", at(3));
  assert.deepEqual([record("s1").status, record("s1").statusSource, record("s1").firstOnlineAt.getTime()], ["PRESENT", "AUTO", at(3).getTime()]);

  setNow(at(20));
  const first = await scan("s1");
  assert.deepEqual([first.result, first.effect], ["VALID", "EVIDENCE_ONLY"], "the status does not change: the earliest evidence (online) is PRESENT");
  assert.deepEqual([record("s1").status, record("s1").autoStatus, record("s1").firstQrAt.getTime(), record("s1").firstOnlineAt.getTime()], ["PRESENT", "PRESENT", at(20).getTime(), at(3).getTime()]);

  setNow(at(40));
  const again = await scan("s1");
  assert.equal(again.effect, "DUPLICATE");
  assert.equal(record("s1").firstQrAt.getTime(), at(20).getTime(), "the earliest QR time is preserved");

  assert.equal(recordsOf("s1").length, 1, "one canonical record");
  assert.deepEqual(auditsOf("s1").map((a) => a.action), ["CREATED_AUTO", "EVIDENCE_RECORDED"], "a duplicate scan writes no audit");
  assert.equal(scansFor("s1").length, 2, "both scans are kept as scan events");

  const reg = await registerResponse();
  assert.equal(reg.summary.withRecord, 1);
  assert.deepEqual(reg.summary.recordStatus, { PRESENT: 1, LATE: 0, ABSENT: 0, EXCUSED: 0 }, "counted once");
  const row = reg.students.find((s) => s.studentId === "s1");
  assert.equal(row.record.firstQrAt, at(20).toISOString());
  assert.equal(row.record.firstOnlineAt, at(3).toISOString());
});

test("QR first (LATE), then a later online visit: QR decides; the online time is recorded; still one record", async () => {
  reset();
  setNow(at(25));
  const s = await scan("s2");
  assert.deepEqual([s.effect, s.attendance.status], ["STATUS_UPDATED", "LATE"]);
  setNow(at(40));
  const later = await online("s2", at(30));
  assert.ok(later);
  assert.deepEqual([record("s2").status, record("s2").autoStatus, record("s2").firstQrAt.getTime(), record("s2").firstOnlineAt.getTime()], ["LATE", "LATE", at(25).getTime(), at(30).getTime()]);
  assert.equal(recordsOf("s2").length, 1);

  // An EARLIER online visit (dispatched late) moves the online channel earlier and upgrades the AUTO status.
  await online("s2", at(4));
  assert.deepEqual([record("s2").status, record("s2").firstOnlineAt.getTime(), record("s2").firstQrAt.getTime()], ["PRESENT", at(4).getTime(), at(25).getTime()]);
  assert.equal(recordsOf("s2").length, 1);
  const reg = await registerResponse();
  assert.equal(reg.summary.withRecord, 1);
  assert.equal(reg.summary.recordStatus.PRESENT, 1);
});

test("concurrent online evidence and QR scan for the same new record: one record, both channels kept (serialized on the register / record)", async () => {
  reset();
  setNow(at(8));
  const v = visit("s3", at(2));
  const release = gateOn("tx1", "create:record");
  const recording = evidence.recordOnlineEvidence(v, { env: ENV });
  await waitUntil(() => pg.transactions[0]?.statements.includes("create:record") || pg.transactions[0]?.statements.some((s) => s.startsWith("lock:")), "online evidence holds its locks");
  const scanning = scan("s3");
  for (let i = 0; i < 20; i += 1) await tick();
  release();
  await recording;
  const outcome = await scanning;
  assert.equal(recordsOf("s3").length, 1, "one canonical record");
  assert.deepEqual([record("s3").firstOnlineAt.getTime(), record("s3").firstQrAt.getTime(), record("s3").status], [at(2).getTime(), at(8).getTime(), "PRESENT"]);
  assert.equal(outcome.result, "VALID");
});

// ======================================================================================
// 2. QR + teacher decisions and reviews
// ======================================================================================

test("decision before QR: a stronger scan only raises a review; it never overwrites the decision; accept / later scans follow the review rules", async () => {
  reset();
  await decide("s1", "ABSENT");
  assert.deepEqual([record("s1").status, record("s1").statusSource], ["ABSENT", "TEACHER"]);

  setNow(at(5));
  const s = await scan("s1");
  assert.deepEqual([s.effect, s.attendance.status, s.attendance.pendingReview], ["REVIEW_REQUIRED", "ABSENT", true]);
  const since = record("s1").pendingReviewSince.getTime();

  setNow(at(9));
  assert.equal((await scan("s1")).effect, "DUPLICATE");
  assert.equal(record("s1").pendingReviewSince.getTime(), since, "the review keeps its original time");
  assert.equal(record("s1").status, "ABSENT", "still the teacher's decision");

  await assert.rejects(evidence.acceptEvidence({ teacherId: T1, lectureId: L1, studentId: "s1", expectedVersion: record("s1").version }), (e) => e.code === "ATTENDANCE_REASON_REQUIRED");
  await evidence.acceptEvidence({ teacherId: T1, lectureId: L1, studentId: "s1", expectedVersion: record("s1").version, reason: "Scanned at the door." });
  assert.deepEqual([record("s1").status, record("s1").statusSource, record("s1").pendingReviewSince], ["PRESENT", "TEACHER", null]);

  setNow(at(30));
  assert.equal((await scan("s1")).effect, "DUPLICATE");
  assert.equal(record("s1").status, "PRESENT");
  assert.deepEqual(auditsOf("s1").map((a) => a.action), ["TEACHER_SET", "EVIDENCE_RECORDED", "EVIDENCE_ACCEPTED"]);
});

test("QR before the decision: changing a QR (AUTO) status needs a reason; the QR evidence is kept; later scans never undo the decision", async () => {
  reset();
  setNow(at(5));
  await scan("s2");
  assert.deepEqual([record("s2").status, record("s2").statusSource], ["PRESENT", "AUTO"]);
  await assert.rejects(decide("s2", "EXCUSED"), (e) => e.code === "ATTENDANCE_REASON_REQUIRED");
  await decide("s2", "EXCUSED", "Medical appointment; left after the scan.");
  assert.deepEqual([record("s2").status, record("s2").statusSource, record("s2").firstQrAt.getTime(), record("s2").autoStatus], ["EXCUSED", "TEACHER", at(5).getTime(), "PRESENT"]);

  setNow(at(50));
  assert.equal((await scan("s2")).effect, "DUPLICATE");
  assert.equal(record("s2").status, "EXCUSED");

  const h = await history.getStudentAttendanceHistory(T1, L1, "s2");
  assert.deepEqual(h.entries.map((e) => [e.action, e.cause]), [["CREATED_AUTO", "QR_SCAN"], ["TEACHER_SET", null]]);
  assert.equal(h.entries[1].reason, "Medical appointment; left after the scan.");
  const text = JSON.stringify(h);
  for (const secret of [payloadOf("s2"), ...pg.committed.scans.map((s) => s.id), ...pg.committed.scans.map((s) => s.scannedTokenHash).filter(Boolean)]) {
    assert.ok(!text.includes(secret), "no payload, scan id or token hash in history");
  }
});

// ======================================================================================
// 3. QR + finalization
// ======================================================================================

test("QR before finalization and QR closure before finalization: closure does not finalize; finalization keeps the scanned record and the closure", async () => {
  reset();
  setNow(at(5));
  await scan("s1");
  setNow(at(90));
  const closure = await close();
  assert.equal(closure.alreadyClosed, false);
  assert.equal(pg.committed.registers[L1].finalizedAt, null, "closing QR attendance does not finalize the register");
  const before = JSON.stringify(record("s1"));

  setNow(at(200));
  const result = await finalize(await fingerprint());
  assert.ok(result);
  assert.notEqual(pg.committed.registers[L1].finalizedAt, null);
  assert.equal(JSON.stringify(record("s1")), before, "the QR record is preserved, never marked ABSENT");
  for (const id of ["s2", "s3", "s4", "s5"]) assert.deepEqual([record(id).status, record(id).statusSource], ["ABSENT", "FINALIZATION"], id);
  assert.equal(pg.committed.qrClosures[L1].closedAt.getTime(), at(90).getTime(), "the closure is unchanged");
  assert.equal(scansFor("s1").length, 1, "no scan evidence deleted");

  const reg = await registerResponse();
  assert.deepEqual(reg.qr, { closed: true, closedAt: at(90).toISOString(), opensAt: at(-30).toISOString(), window: "CLOSED" });
  assert.deepEqual(reg.summary.recordStatus, { PRESENT: 1, LATE: 0, ABSENT: 4, EXCUSED: 0 });
});

test("QR after finalization: an ABSENT (finalization) record only gets a review; the finalized register is unchanged; closure after finalization changes nothing else", async () => {
  reset();
  setNow(at(200));
  await finalize(await fingerprint());
  const frozen = JSON.stringify(pg.committed.registers[L1]);
  const s = await scan("s3");
  assert.deepEqual([s.effect, s.afterFinalization, s.attendance.status, s.attendance.pendingReview], ["REVIEW_REQUIRED", true, "ABSENT", true]);
  assert.deepEqual([record("s3").status, record("s3").statusSource], ["ABSENT", "FINALIZATION"]);
  assert.equal(JSON.stringify(pg.committed.registers[L1]), frozen, "the finalized register is untouched by the scan");

  const recordsBefore = JSON.stringify(pg.committed.records);
  await close();
  assert.equal(JSON.stringify(pg.committed.registers[L1]), frozen, "and by the closure");
  assert.equal(JSON.stringify(pg.committed.records), recordsBefore, "no record changed or deleted by the closure");
  await assert.rejects(scan("s4"), (e) => e.code === "ATTENDANCE_QR_CLOSED");

  // The authorized correction path still works after both.
  await evidence.acceptEvidence({ teacherId: T1, lectureId: L1, studentId: "s3", expectedVersion: record("s3").version, reason: "Was present: scanned at the door." });
  assert.deepEqual([record("s3").status, record("s3").statusSource, record("s3").pendingReviewSince], ["LATE", "TEACHER", null]);
});

test("QR racing finalization (preview first): a scan committed after the preview makes it stale; nothing lost or doubled; a fresh preview finalizes", async () => {
  reset();
  setNow(at(200));
  const stale = await fingerprint();
  await scan("s1");
  const snapshot = JSON.stringify([pg.committed.registers, pg.committed.records]);
  await assert.rejects(finalize(stale), (e) => e.code === "FINALIZATION_PREVIEW_STALE");
  assert.equal(JSON.stringify([pg.committed.registers, pg.committed.records]), snapshot, "nothing written");
  await finalize(await fingerprint());
  assert.deepEqual([record("s1").status, record("s1").statusSource], ["LATE", "AUTO"]);
  assert.equal(recordsOf("s1").length, 1);
});

test("concurrent: a scan holding the register makes finalization wait; finalization then refuses as stale (the scan is kept)", async () => {
  reset();
  setNow(at(200));
  const fp = await fingerprint();
  const release = gateOn("tx1", "create:scan");
  const scanning = scan("s2");
  await waitUntil(() => pg.transactions[0]?.statements.includes("create:scan"), "the scan holds its locks, record written (uncommitted)");
  const finalizing = finalize(fp);
  for (let i = 0; i < 30; i += 1) await tick();
  assert.equal(pg.committed.registers[L1]?.finalizedAt ?? null, null, "finalization is waiting (the scan's register is not even committed yet)");
  release();
  const outcome = await scanning;
  assert.equal(outcome.effect, "STATUS_UPDATED");
  await assert.rejects(finalizing, (e) => e.code === "FINALIZATION_PREVIEW_STALE");
  assert.equal(pg.committed.registers[L1].finalizedAt, null);
  assert.equal(record("s2").status, "LATE");
});

test("concurrent: finalization holding the register makes a scan wait; the scan then sees the finalized register (review only)", async () => {
  reset();
  setNow(at(200));
  const fp = await fingerprint();
  const release = gateOn("tx1", "create:registerAudit");
  const finalizing = finalize(fp);
  await waitUntil(() => pg.transactions[0]?.statements.includes("create:registerAudit") || pg.transactions[0]?.statements.includes("update:register"), "finalization in its write phase");
  const scanning = scan("s4");
  for (let i = 0; i < 30; i += 1) await tick();
  assert.equal(scansFor("s4").length, 0, "the scan waits");
  release();
  await finalizing;
  const outcome = await scanning;
  assert.deepEqual([outcome.effect, outcome.afterFinalization, record("s4").status, record("s4").statusSource], ["REVIEW_REQUIRED", true, "ABSENT", "FINALIZATION"]);
  assert.equal(recordsOf("s4").length, 1);
});

// ======================================================================================
// 4. QR + reconciliation and grace
// ======================================================================================

test("reconciliation after QR scans and QR closure: QR-only students untouched; online evidence added once; re-running writes nothing", async () => {
  reset();
  setNow(at(25));
  await scan("s1"); // QR only, LATE
  await scan("s2"); // QR LATE; an earlier online visit was never dispatched
  visit("s2", at(3));
  setNow(at(100));
  await close();
  const s1Before = JSON.stringify(record("s1"));

  setNow(at(200));
  await reconcileAll();
  assert.equal(JSON.stringify(record("s1")), s1Before, "a QR-only student is not touched or duplicated");
  assert.deepEqual([record("s2").status, record("s2").statusSource, record("s2").firstOnlineAt.getTime(), record("s2").firstQrAt.getTime()], ["PRESENT", "AUTO", at(3).getTime(), at(25).getTime()]);
  assert.equal(recordsOf("s2").length, 1);
  assert.equal(scansFor("s2").length, 1, "reconciliation creates no scan events");

  const after = JSON.stringify([pg.committed.records, pg.committed.recordAudits]);
  await reconcileAll();
  assert.equal(JSON.stringify([pg.committed.records, pg.committed.recordAudits]), after, "idempotent");
  assert.equal(pg.committed.qrClosures[L1].closedAt.getTime(), at(100).getTime(), "closure unaffected by reconciliation");
});

test("grace change after QR closure: QR evidence is re-judged, decisions and reviews kept, and QR attendance stays closed", async () => {
  reset();
  setNow(at(15));
  await scan("s1"); // LATE under grace 10
  await decide("s2", "ABSENT");
  await scan("s2"); // review
  const review = record("s2").pendingReviewSince.getTime();
  setNow(at(60));
  await close();
  const closure = JSON.stringify(pg.committed.qrClosures[L1]);

  const result = await grace.setRegisterGraceMinutes({ teacherId: T1, lectureId: L1, graceMinutes: 30, expectedVersion: pg.committed.registers[L1].version, reason: "Rain delayed the bus." });
  assert.equal(result.recalculatedCount, 2);
  assert.deepEqual([record("s1").status, record("s1").autoStatus], ["PRESENT", "PRESENT"], "the QR record follows the new grace");
  assert.deepEqual([record("s2").status, record("s2").statusSource, record("s2").autoStatus, record("s2").pendingReviewSince.getTime()], ["ABSENT", "TEACHER", "PRESENT", review]);
  assert.equal(JSON.stringify(pg.committed.qrClosures[L1]), closure, "the closure is unchanged");
  await assert.rejects(scan("s3"), (e) => e.code === "ATTENDANCE_QR_CLOSED", "a grace change never reopens QR attendance");
  const reg = await registerResponse();
  assert.equal(reg.qr.closed, true);
  assert.equal(reg.qr.window, "CLOSED");
});

// ======================================================================================
// 5. Closure, history and the register view
// ======================================================================================

test("closure: idempotent for a second tab; the register shows it (no teacher id); register history lists it; nothing is deleted", async () => {
  reset();
  setNow(at(5));
  await scan("s1");
  await online("s2", at(1));
  const before = JSON.stringify([pg.committed.records, pg.committed.recordAudits, pg.committed.scans]);
  setNow(at(70));
  const first = await close();
  setNow(at(75));
  const second = await close(); // the other tab
  assert.deepEqual([first.alreadyClosed, second.alreadyClosed, second.closedAt.getTime()], [false, true, at(70).getTime()]);
  assert.equal(JSON.stringify([pg.committed.records, pg.committed.recordAudits, pg.committed.scans]), before, "no evidence, record or audit changed");

  const reg = await registerResponse();
  assert.deepEqual(reg.qr, { closed: true, closedAt: at(70).toISOString(), opensAt: at(-30).toISOString(), window: "CLOSED" });
  assert.ok(!JSON.stringify(reg).includes(T1), "no teacher id in the register response");
  const rh = await history.getRegisterHistory(T1, L1);
  assert.equal(rh.qrClosure.closedAt.getTime(), at(70).getTime());
  assert.deepEqual(rh.qrClosure.actor, { role: "TEACHER", teacherId: T1 }, "the service's actor; the route maps it to isCurrentTeacher");
  await assert.rejects(scan("s3"), (e) => e.code === "ATTENDANCE_QR_CLOSED");
  const replay = await scan("s1", pg.committed.scans[0].clientScanId);
  assert.equal(replay.replayed, true, "a replay of a stored scan still answers after closure (idempotency kept)");
});

// ======================================================================================
// 6. Attendance percentages: unchanged by this feature (documented boundary)
// ======================================================================================

test("percentages: the existing calculations read online session attendance only; no QR / canonical-record source was added to them", () => {
  const sources = {
    "services/student-service.ts": fs.readFileSync(path.join(root, "services", "student-service.ts"), "utf8"),
    "app/api/student/dashboard/performance/route.ts": fs.readFileSync(path.join(root, "app", "api", "student", "dashboard", "performance", "route.ts"), "utf8"),
    "app/api/classes/[id]/attendance-summary/route.ts": fs.readFileSync(path.join(root, "app", "api", "classes", "[id]", "attendance-summary", "route.ts"), "utf8"),
  };
  for (const [file, code] of Object.entries(sources)) {
    assert.doesNotMatch(code, /lectureAttendance\b|attendanceScanEvent|lectureQrAttendanceClosure|recordQrScan/, `${file}: no QR or canonical-record source`);
  }
  assert.match(sources["app/api/student/dashboard/performance/route.ts"], /attendance: \{ where: \{ studentId \}, select: \{ id: true \}, take: 1 \}/);
});
