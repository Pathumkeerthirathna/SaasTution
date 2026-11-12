/*
 * Stage 5.5b: the atomic finalization transaction
 * (services/lecture-attendance-finalization-service.ts and the finalization
 * helpers in lib/attendance/locks.ts).
 *
 *   npm run test:attendance-finalization
 *
 * No database: the real services run through tsx against the in-memory
 * PostgreSQL model (tests/attendance/helpers/attendance-pg-model.cjs: row
 * locks and their conflicts, unique waits, READ COMMITTED, rollback, the
 * CHECK constraints and the register freeze trigger). This does NOT validate
 * real PostgreSQL locking (postponed).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const { createPgModel, lockTimeoutError, dbError } = require("./helpers/attendance-pg-model.cjs");

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

const finalization = require(path.join(root, "services", "lecture-attendance-finalization-service.ts"));
const preview = require(path.join(root, "services", "lecture-attendance-finalization-preview-service.ts"));
const lockLib = require(path.join(root, "lib", "attendance", "locks.ts"));
const attendanceService = require(path.join(root, "services", "lecture-attendance-service.ts"));

// ---- Clock and fixtures ----------------------------------------------------------------

const START = new Date("2026-09-01T12:30:00.000Z"); // LIVE
const at = (minutes) => new Date(START.getTime() + minutes * 60_000);
const NOW = at(200); // after the scheduled end (at(120))
test.mock.timers.enable({ apis: ["Date"], now: NOW });

const T1 = "teacher-1";
const T2 = "teacher-2";
const C1 = "class-1";
const L1 = "lecture-1";
const APPROVED_AT = new Date("2026-08-01T00:00:00.000Z");
const ENV = { APPROVAL_FEATURE_STARTED_AT: "2026-07-28T00:00:00Z", ATTENDANCE_EVIDENCE_STARTED_AT: "2026-08-15T00:00:00Z" };
const local = (date) => new Date(date.getTime() + (5 * 60 + 30) * 60_000);
const HEX = "a".repeat(64);

let model;
let pg;
let visitSeq = 0;

function reset({ date = START, endDate = at(120), classStatus = "SCHEDULED", grace = 10 } = {}) {
  model = createPgModel();
  pg = model.pg;
  currentPrisma = model.prisma;
  visitSeq = 0;
  test.mock.timers.setTime(NOW.getTime());
  pg.committed.classes[C1] = { id: C1, teacherId: T1, status: 0, attendanceGraceMinutes: grace };
  pg.committed.lectures[L1] = { id: L1, classId: C1, title: "Kinematics", status: 0, classStatus, date, endDate, createdAt: at(-1000) };
  pg.committed.sessions["sess-a"] = { id: "sess-a", lectureId: L1, isActive: false, startedAt: at(-5) };
}

function student(id, { teacherId = T1, status = 0, confirmationStatus = "APPROVED", broken = false, approvedAt = APPROVED_AT,
  enrolledAt = new Date("2026-08-05T00:00:00Z"), removedAt = null } = {}) {
  pg.committed.students[id] = {
    id, name: `Name of ${id}`, registrationNumber: `REG-${id}`, teacherId, status, confirmationStatus,
    confirmedAt: confirmationStatus === "PENDING" ? null : broken ? new Date(approvedAt.getTime() + 86_400_000) : approvedAt,
    approvedAt: confirmationStatus === "PENDING" ? null : approvedAt,
  };
  if (confirmationStatus !== "PENDING") {
    pg.committed.history.push({ id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: confirmationStatus, decidedAt: approvedAt, previousConfirmedAt: null });
  }
  if (enrolledAt) {
    pg.committed.enrolments.push({ id: `e-${id}`, studentId: id, classId: C1, assignedAt: local(enrolledAt), removedAt: removedAt ? local(removedAt) : null, isActive: !removedAt });
  }
}

function visit(studentId, joinedAt, session = "sess-a") {
  const id = `visit-${String(++visitSeq).padStart(4, "0")}`;
  pg.committed.visits[id] = { id, studentId, joinedAt, classSessionId: session };
  return id;
}

function register(extra = {}) {
  const l = pg.committed.lectures[L1];
  pg.committed.registers[L1] = {
    lectureId: L1, classId: C1, scheduledStartAt: l.date, scheduledEndAt: l.endDate, graceMinutes: 10,
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
  pg.committed.recordAudits.push({ id: `seed-${studentId}`, lectureAttendanceId: row.id, version: 1, lectureId: L1, studentId,
    action: row.statusSource === "TEACHER" ? "TEACHER_SET" : "CREATED_AUTO", toStatus: row.status });
  return row;
}

const teacherRecord = (status, extra = {}) => ({ status, statusSource: "TEACHER", teacherStatus: status, teacherDecidedAt: at(130), teacherDecidedById: T1, ...extra });
const autoRecord = (status, when) => ({ status, statusSource: "AUTO", firstOnlineAt: when, autoStatus: status });

const fingerprint = async () => (await preview.getLectureAttendanceFinalizationPreview({ teacherId: T1, lectureId: L1 }, { env: ENV })).fingerprint;
const finalize = (fp, extra = {}, env = ENV) => finalization.finalizeLectureAttendance({ teacherId: T1, lectureId: L1, fingerprint: fp, ...extra }, { env });
const confirm = async (extra) => finalize(await fingerprint(), extra);
const record = (studentId) => pg.committed.records[`${L1}:${studentId}`] ?? null;
const snapshot = () => JSON.stringify(pg.committed);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const recordAuditsOf = (action) => pg.committed.recordAudits.filter((a) => a.action === action);
const registerAuditsOf = (action) => pg.committed.registerAudits.filter((a) => a.action === action);

const attendanceState = () =>
  JSON.stringify([pg.committed.registers, pg.committed.registerAudits, pg.committed.records, pg.committed.recordAudits, pg.committed.lectures]);

/** Rejects with nothing written: the attendance state unchanged and no transaction started by the call committed a write. */
async function refusedWithoutWrites(promise, check) {
  const before = attendanceState();
  const startedAt = pg.transactions.length;
  await assert.rejects(promise, check);
  assert.equal(attendanceState(), before, "nothing written");
  assert.ok(
    pg.transactions.slice(startedAt).every((t) => t.outcome !== "commit" || !t.statements.some((s) => /^(insert|create|update)/.test(s))),
    "no committed write"
  );
}

function gateOn(label, op) {
  let release;
  const gate = new Promise((r) => { release = r; });
  pg.beforeStatement = async (l, o) => {
    if (l === label && o === op) await gate;
  };
  return release;
}

/** A mixed class: every roster partition entry and record status present. */
function mixedClass() {
  register();
  student("s-present"); seedRecord("s-present", autoRecord("PRESENT", at(2))); visit("s-present", at(2));
  student("s-late"); seedRecord("s-late", autoRecord("LATE", at(30))); visit("s-late", at(30));
  student("s-absent"); seedRecord("s-absent", teacherRecord("ABSENT"));
  student("s-excused"); seedRecord("s-excused", teacherRecord("EXCUSED", { firstQrAt: at(20), autoStatus: "LATE", pendingReviewSince: at(21) }));
  student("s-no-show-1");
  student("s-no-show-2");
  student("s-unknown", { broken: true });
  student("s-pending", { confirmationStatus: "PENDING" });
  student("s-removed", { removedAt: at(-60 * 24) });
  student("s-deleted", { status: 2 });
  student("s-inactive", { status: 1 });
  student("s-late-enrol", { enrolledAt: at(60) });
}

// ---- 1-7, 23. Success ------------------------------------------------------------------------------

test("1, 2, 3, 4, 5, 6, 7, 23. finalization: ABSENT only for the plan's CREATE_ABSENT students; everything else preserved; audits and counts", async () => {
  reset();
  mixedClass();
  const existing = JSON.stringify(["s-present", "s-late", "s-absent", "s-excused"].map(record));
  const lectureBefore = JSON.stringify(pg.committed.lectures[L1]);

  const result = await confirm();
  assert.deepEqual(result, {
    lectureId: L1,
    alreadyFinalized: false,
    finalizedAt: NOW,
    registerVersion: 2,
    eligibleStudents: 6,
    unknownEligibilityStudents: 1,
    absentCreated: 2,
    details: {
      rosterSize: 12, studentsWithRecord: 4, manualReview: 1, notEligibleWithoutRecord: 5,
      recordStatusBefore: { PRESENT: 1, LATE: 1, ABSENT: 1, EXCUSED: 1 }, pendingReviews: 1,
    },
  });

  // 1. The new ABSENT records.
  for (const id of ["s-no-show-1", "s-no-show-2"]) {
    const r = record(id);
    assert.deepEqual(
      [r.status, r.statusSource, r.version, r.firstOnlineAt, r.firstQrAt, r.autoStatus, r.teacherStatus, r.teacherDecidedAt, r.teacherDecidedById, r.pendingReviewSince, r.classId],
      ["ABSENT", "FINALIZATION", 1, null, null, null, null, null, null, null, C1]
    );
    model.checkRecord(r);
  }
  // 2, 3, 7. Existing records, the teacher decisions and the pending review: byte-identical.
  assert.equal(JSON.stringify(["s-present", "s-late", "s-absent", "s-excused"].map(record)), existing);
  // 4, 5, 6. No record for UNKNOWN, NOT_APPROVED, removed, deleted, inactive, enrolled after the start.
  for (const id of ["s-unknown", "s-pending", "s-removed", "s-deleted", "s-inactive", "s-late-enrol"]) assert.equal(record(id), null, id);
  assert.equal(Object.keys(pg.committed.records).length, 6);

  // The register: finalized, schedule and grace unchanged; the lecture untouched (classStatus included).
  const reg = pg.committed.registers[L1];
  assert.deepEqual([reg.finalizedAt, reg.finalizedByTeacherId, reg.version, reg.scheduledStartAt, reg.scheduledEndAt, reg.graceMinutes], [NOW, T1, 2, START, at(120), 10]);
  assert.equal(JSON.stringify(pg.committed.lectures[L1]), lectureBefore);

  // 23. Audits: one FINALIZED (TEACHER, counts), one FINALIZE_ABSENT per new record (SYSTEM, v1, linked).
  const [fin, ...more] = registerAuditsOf("FINALIZED");
  assert.equal(more.length, 0);
  assert.deepEqual(
    [fin.version, fin.actorRole, fin.actorId, fin.finalizedAt, fin.eligibleCount, fin.unknownEligibilityCount, fin.absentCreatedCount],
    [2, "TEACHER", T1, NOW, 6, 1, 2]
  );
  const absentAudits = recordAuditsOf("FINALIZE_ABSENT");
  assert.equal(absentAudits.length, 2);
  for (const a of absentAudits) {
    assert.deepEqual(
      [a.version, a.fromStatus, a.toStatus, a.actorRole, a.actorId, a.reason, a.afterFinalization, a.registerAuditId, a.lectureId, a.lectureAttendanceId],
      [1, null, "ABSENT", "SYSTEM", null, null, false, fin.id, L1, record(a.studentId).id]
    );
    model.checkAudit(a);
  }
  assert.deepEqual(absentAudits.map((a) => a.studentId).sort(), ["s-no-show-1", "s-no-show-2"]);
});

test("no register yet: it is created (TEACHER, version 1) and finalized (version 2) in the same transaction", async () => {
  reset({ grace: 7 });
  student("s1");
  const result = await confirm();
  assert.deepEqual([result.registerVersion, result.absentCreated], [2, 1]);
  const reg = pg.committed.registers[L1];
  assert.deepEqual([reg.version, reg.graceMinutes, reg.scheduledStartAt, reg.finalizedAt], [2, 7, START, NOW]);
  assert.deepEqual(pg.committed.registerAudits.map((a) => [a.action, a.version, a.actorRole, a.actorId]), [["CREATED", 1, "TEACHER", T1], ["FINALIZED", 2, "TEACHER", T1]]);
  assert.equal(pg.transactions.length, 1);
});

test("nobody to mark ABSENT: the register is finalized with zero counts and no record audits", async () => {
  reset();
  register();
  student("s1");
  seedRecord("s1", teacherRecord("PRESENT"));
  const result = await confirm();
  assert.equal(result.absentCreated, 0);
  assert.equal(recordAuditsOf("FINALIZE_ABSENT").length, 0);
  assert.equal(pg.committed.registers[L1].finalizedAt.getTime(), NOW.getTime());
});

test("a historical lecture is finalized under the historical representation rule (D2)", async () => {
  const hStart = new Date("2026-08-10T12:30:00Z");
  reset({ date: hStart, endDate: new Date("2026-08-10T14:30:00Z") });
  register();
  student("s-backfilled");
  student("s-no-show");
  visit("s-backfilled", new Date("2026-08-10T12:35:00Z"));
  seedRecord("s-backfilled", { status: "PRESENT", statusSource: "BACKFILL", firstOnlineAt: new Date("2026-08-10T12:40:00Z"), autoStatus: "PRESENT" });
  const result = await confirm();
  assert.equal(result.absentCreated, 1);
  assert.deepEqual([record("s-backfilled").status, record("s-backfilled").statusSource], ["PRESENT", "BACKFILL"], "never re-marked");
  assert.equal(record("s-no-show").status, "ABSENT");
});

// ---- 8-14. Refusals ----------------------------------------------------------------------------------

test("8. pending eligible online evidence blocks (FINALIZATION_EVIDENCE_PENDING); nothing written", async () => {
  reset();
  register();
  student("s1");
  visit("s1", at(3));
  const fp = await fingerprint();
  await refusedWithoutWrites(finalize(fp), (e) => e.code === "FINALIZATION_EVIDENCE_PENDING" && e.statusCode === 409 && e.details.pendingOnlineEvidence === 1);
});

test("9. UNKNOWN evidence blocks only as evidenceRepresentation reports it", async () => {
  reset();
  register();
  student("s-unknown-visit", { broken: true });
  visit("s-unknown-visit", at(3));
  await refusedWithoutWrites(finalize(await fingerprint()), (e) => e.code === "FINALIZATION_EVIDENCE_PENDING" && e.details.unknownApprovalEvidence === 1);

  // With a teacher record, the same visit is not unknown evidence: finalization proceeds; still no automatic ABSENT.
  seedRecord("s-unknown-visit", teacherRecord("PRESENT"));
  student("s-unknown-quiet", { broken: true }); // UNKNOWN, no visit: manual review, never blocks
  const result = await confirm();
  assert.equal(result.absentCreated, 0);
  assert.equal(result.details.manualReview, 1);
  assert.equal(record("s-unknown-quiet"), null);
});

test("10. an active session blocks (D3)", async () => {
  reset();
  student("s1");
  pg.committed.sessions["sess-a"].isActive = true;
  await refusedWithoutWrites(confirm(), (e) => e.code === "FINALIZATION_SESSION_ACTIVE" && e.statusCode === 409);
});

test("11, 12. readiness: before the start and before the end refused; COMPLETED or the end passed allowed; no end needs COMPLETED", async () => {
  reset();
  student("s1");
  test.mock.timers.setTime(at(-1).getTime());
  await refusedWithoutWrites(confirm(), (e) => e.code === "FINALIZATION_NOT_ALLOWED" && e.details.reason === "LECTURE_NOT_STARTED");
  test.mock.timers.setTime(at(60).getTime());
  await refusedWithoutWrites(confirm(), (e) => e.code === "FINALIZATION_NOT_ALLOWED" && e.details.reason === "SCHEDULED_END_NOT_PASSED");
  pg.committed.lectures[L1].endDate = null;
  await refusedWithoutWrites(confirm(), (e) => e.code === "FINALIZATION_NOT_ALLOWED" && e.details.reason === "COMPLETION_REQUIRED");
  pg.committed.lectures[L1].classStatus = "COMPLETED";
  assert.equal((await confirm()).absentCreated, 1, "COMPLETED before the end (and without an end)");
  assert.equal(pg.committed.lectures[L1].classStatus, "COMPLETED", "never changed");

  reset();
  student("s1");
  assert.equal((await confirm()).absentCreated, 1, "the end passed");
  assert.equal(pg.committed.lectures[L1].classStatus, "SCHEDULED", "never changed");
});

test("13. cancelled 409, deleted / missing / another teacher's lecture 404; nothing written", async () => {
  reset();
  student("s1");
  const fp = await fingerprint();
  pg.committed.lectures[L1].classStatus = "CANCELLED";
  await refusedWithoutWrites(finalize(fp), (e) => e.code === "LECTURE_CANCELLED" && e.statusCode === 409);
  pg.committed.lectures[L1].classStatus = "SCHEDULED";
  await refusedWithoutWrites(finalization.finalizeLectureAttendance({ teacherId: T2, lectureId: L1, fingerprint: fp }, { env: ENV }), (e) => e.code === "LECTURE_NOT_FOUND");
  pg.committed.lectures[L1].status = 1;
  await refusedWithoutWrites(finalize(fp), (e) => e.code === "LECTURE_NOT_FOUND" && e.statusCode === 404);
  await refusedWithoutWrites(finalize(fp, { lectureId: "missing" }), (e) => e.code === "LECTURE_NOT_FOUND");
});

test("14. missing configuration fails closed (503) before any transaction; invalid input 400", async () => {
  reset();
  student("s1");
  const original = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(finalize(HEX, {}, { ATTENDANCE_EVIDENCE_STARTED_AT: ENV.ATTENDANCE_EVIDENCE_STARTED_AT }), (e) => e.code === "ATTENDANCE_APPROVAL_NOT_CONFIGURED" && e.statusCode === 503);
    await assert.rejects(finalize(HEX, {}, { APPROVAL_FEATURE_STARTED_AT: ENV.APPROVAL_FEATURE_STARTED_AT }), (e) => e.code === "ATTENDANCE_EVIDENCE_NOT_CONFIGURED");
  } finally {
    console.warn = original;
  }
  for (const bad of ["", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), 5, null]) {
    await assert.rejects(finalize(bad), (e) => e.code === "VALIDATION_ERROR" && e.details.field === "fingerprint", String(bad));
  }
  await assert.rejects(finalize(HEX, { teacherId: "" }), (e) => e.code === "VALIDATION_ERROR" && e.details.field === "teacherId");
  assert.equal(pg.transactions.length, 0);
});

// ---- 15-18. Roster limit and fingerprint ---------------------------------------------------------

test("15, 16. roster: 500 candidates finalize; 501 refused before any Student lock, nothing written", async () => {
  reset();
  for (let i = 0; i < 500; i += 1) student(`s${String(i).padStart(4, "0")}`);
  const result = await confirm();
  assert.deepEqual([result.absentCreated, result.details.rosterSize], [500, 500]);
  assert.equal(recordAuditsOf("FINALIZE_ABSENT").length, 500);

  reset();
  for (let i = 0; i < 501; i += 1) student(`s${String(i).padStart(4, "0")}`);
  await refusedWithoutWrites(finalize(HEX), (e) => e.code === "FINALIZATION_ROSTER_LIMIT_EXCEEDED" && e.statusCode === 409 && e.details.rosterSize === 501 && e.details.limit === 500);
  assert.ok(!pg.transactions[0].statements.includes("lock:students"), "refused before the Student locks");
  assert.equal(lockLib.FINALIZATION_MAX_STUDENTS, 500);
});

test("17. a stale or foreign fingerprint is refused (FINALIZATION_PREVIEW_STALE) with nothing written", async () => {
  reset();
  mixedClass();
  await refusedWithoutWrites(finalize(HEX), (e) => e.code === "FINALIZATION_PREVIEW_STALE" && e.statusCode === 409);
  const fp = await fingerprint();
  // A new teacher decision after the preview (record version / status).
  Object.assign(pg.committed.records[`${L1}:s-absent`], { status: "EXCUSED", teacherStatus: "EXCUSED", version: 2 });
  await refusedWithoutWrites(finalize(fp), (e) => e.code === "FINALIZATION_PREVIEW_STALE");
  // A new record after the preview.
  const fp2 = await fingerprint();
  seedRecord("s-no-show-1", teacherRecord("PRESENT"));
  await refusedWithoutWrites(finalize(fp2), (e) => e.code === "FINALIZATION_PREVIEW_STALE");
});

test("18. a schedule or grace change after the preview invalidates it", async () => {
  for (const mutate of [
    () => { pg.committed.registers[L1].scheduledStartAt = at(-5); },
    () => { pg.committed.registers[L1].scheduledEndAt = at(110); },
    () => { pg.committed.registers[L1].graceMinutes = 5; },
    () => { pg.committed.registers[L1].version = 2; },
    () => { pg.committed.lectures[L1].date = at(-5); },
  ]) {
    reset();
    mixedClass();
    const fp = await fingerprint();
    mutate();
    await refusedWithoutWrites(finalize(fp), (e) => e.code === "FINALIZATION_PREVIEW_STALE");
  }
  // QR closure does not (D7).
  reset();
  mixedClass();
  const fp = await fingerprint();
  pg.committed.qrClosures[L1] = { lectureId: L1, classId: C1, closedAt: at(100), closedByTeacherId: T1 };
  assert.equal((await finalize(fp)).absentCreated, 2);
});

// ---- 19-20. D8: approval / deletion races and the candidate set ---------------------------------

test("19. an approval decision or deletion cannot commit while finalization holds the Student locks; it runs after", async () => {
  reset();
  student("s1");
  student("s2");
  const fp = await fingerprint();
  const release = gateOn("tx1", "lock:lecture");
  const finalizing = finalize(fp);
  while (!pg.transactions[0]?.statements.includes("lock:lecture")) await tick();
  // A student decision (FOR NO KEY UPDATE) and a deletion (UPDATE takes the same row lock) on locked students.
  let decided = false;
  let deleted = false;
  const decision = model.locks.acquire("student:s1", "decision", "NO_KEY_UPDATE").then(() => { decided = true; });
  const deletion = model.locks.acquire("student:s2", "deletion", "NO_KEY_UPDATE").then(() => { deleted = true; });
  await tick();
  assert.deepEqual([decided, deleted], [false, false], "both wait for finalization");
  release();
  const result = await finalizing;
  assert.equal(result.absentCreated, 2);
  await Promise.all([decision, deletion]);
  assert.deepEqual([decided, deleted], [true, true], "granted only after the commit");
  model.locks.release("decision");
  model.locks.release("deletion");
});

test("19. a decision holding a Student row makes finalization wait, or 409 ATTENDANCE_BUSY on timeout; nothing written", async () => {
  reset();
  student("s1");
  const fp = await fingerprint();
  pg.held.push({ row: "student:s1", owner: "decision", mode: "NO_KEY_UPDATE" });
  pg.failWhenBlocked = true;
  await refusedWithoutWrites(finalize(fp), (e) => e.code === "ATTENDANCE_BUSY" && e.statusCode === 409);
  assert.equal(pg.transactions[0].outcome, "rollback");
});

test("19. a deletion or approval change committed after the preview: eligibility changes, so the preview is stale", async () => {
  reset();
  student("s1");
  student("s2");
  let fp = await fingerprint();
  pg.committed.students.s1.status = 2; // deleted after the preview
  await refusedWithoutWrites(finalize(fp), (e) => e.code === "FINALIZATION_PREVIEW_STALE");
  fp = await fingerprint();
  const result = await finalize(fp);
  assert.equal(result.absentCreated, 1);
  assert.equal(record("s1"), null, "a deleted student never gets an automatic ABSENT");

  reset();
  student("s1");
  fp = await fingerprint();
  // An inconsistent approval snapshot (history not matching the row) is UNKNOWN: manual review, never ABSENT.
  pg.committed.history.push({ id: "h-late", studentId: "s1", fromStatus: "APPROVED", toStatus: "REJECTED", decidedAt: at(150), previousConfirmedAt: new Date("2026-07-01T00:00:00Z") });
  await refusedWithoutWrites(finalize(fp), (e) => e.code === "FINALIZATION_PREVIEW_STALE");
  const after = await preview.getLectureAttendanceFinalizationPreview({ teacherId: T1, lectureId: L1 }, { env: ENV });
  assert.deepEqual([after.summary.automaticAbsent, after.summary.manualReview], [0, 1]);
  await finalize(after.fingerprint);
  assert.equal(record("s1"), null);
});

test("20. a candidate appearing between the first read and the locked re-read fails closed (FINALIZATION_CANDIDATES_CHANGED)", async () => {
  reset();
  student("s1");
  const fp = await fingerprint();
  pg.beforeStatement = async (label, op) => {
    if (label === "tx1" && op === "lock:lecture" && !pg.committed.students["s-new"]) student("s-new", { enrolledAt: NOW });
  };
  await refusedWithoutWrites(finalize(fp), (e) => e.code === "FINALIZATION_CANDIDATES_CHANGED" && e.statusCode === 409);
});

test("20. a candidate the Student lock does not return is never skipped: refused", async () => {
  // Foreign keys make a missing Student row impossible in PostgreSQL; the
  // check is defensive, so the model removes the row just before the lock.
  reset();
  student("s1");
  student("s2");
  const fp = await fingerprint();
  pg.beforeStatement = async (label, op) => {
    if (label === "tx1" && op === "lock:students") delete pg.committed.students.s2;
  };
  await refusedWithoutWrites(finalize(fp), (e) => e.code === "FINALIZATION_CANDIDATES_CHANGED" && e.statusCode === 409);
});

// ---- 21-22, 24. Duplicates and integrity --------------------------------------------------------------

test("21. a repeated confirmation is idempotent: the stored counts, nothing written", async () => {
  reset();
  mixedClass();
  const fp = await fingerprint();
  const first = await finalize(fp);
  const after = snapshot();
  for (const again of [fp, HEX]) {
    const second = await finalize(again);
    assert.deepEqual(second, { ...first, alreadyFinalized: true, details: null });
    assert.equal(snapshot(), after);
  }
  // No Student locks are taken for a repeated confirmation.
  assert.ok(!pg.transactions.at(-1).statements.includes("lock:students"));
});

test("22. concurrent confirmations: one finalizes, the other waits on the register and returns the idempotent result", async () => {
  for (const withRegister of [true, false]) {
    reset();
    if (withRegister) register();
    student("s1");
    student("s2");
    const fp = await fingerprint();
    const release = gateOn("tx1", "insert:records");
    const first = finalize(fp);
    while (!pg.transactions[0]?.statements.includes("insert:records")) await tick();
    const second = finalize(fp);
    while (!pg.log.some((e) => e.startsWith("tx2:waits:register") || e.startsWith("tx2:unique-wait:register"))) await tick();
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual([a.alreadyFinalized, b.alreadyFinalized], [false, true], `register ${withRegister}`);
    assert.equal(b.absentCreated, 2);
    assert.equal(Object.keys(pg.committed.records).length, 2);
    assert.equal(recordAuditsOf("FINALIZE_ABSENT").length, 2);
    assert.equal(registerAuditsOf("FINALIZED").length, 1);
  }
});

test("24. a finalized register whose FINALIZED audit is missing or inconsistent fails closed (FINALIZATION_INTEGRITY_ERROR)", async () => {
  const corruptions = [
    () => { pg.committed.registerAudits = pg.committed.registerAudits.filter((a) => a.action !== "FINALIZED"); },
    () => { pg.committed.registerAudits.push({ ...registerAuditsOf("FINALIZED")[0], id: "dup", version: 9 }); },
    () => { registerAuditsOf("FINALIZED")[0].absentCreatedCount = 3; },
    () => { registerAuditsOf("FINALIZED")[0].actorId = T2; },
    () => { registerAuditsOf("FINALIZED")[0].version = 3; },
    () => { registerAuditsOf("FINALIZED")[0].finalizedAt = at(201); },
    () => { pg.committed.recordAudits = pg.committed.recordAudits.filter((a) => a.action !== "FINALIZE_ABSENT" || a.studentId !== "s1"); },
  ];
  for (const corrupt of corruptions) {
    reset();
    student("s1");
    student("s2");
    await confirm();
    corrupt();
    await refusedWithoutWrites(finalize(HEX), (e) => e.code === "FINALIZATION_INTEGRITY_ERROR" && e.statusCode === 500);
  }
});

// ---- 25. Rollback ------------------------------------------------------------------------------------

test("25. any failing write rolls everything back (register, records, audits)", async () => {
  for (const op of ["insert:register", "insert:records", "update:register", "create:registerAudit", "create:audits"]) {
    reset();
    student("s1");
    student("s2");
    const fp = await fingerprint();
    pg.failOn = (label, o) => (o === op ? dbError(`simulated failure of ${op}`, { code: "P2010", meta: { code: "XX000" } }) : null);
    await refusedWithoutWrites(finalize(fp), (e) => /simulated failure/.test(e.message));
    assert.equal(pg.transactions[0].outcome, "rollback", op);
    assert.deepEqual(pg.committed.registers, {}, op);
    pg.failOn = null;
    assert.equal((await finalize(fp)).absentCreated, 2, `${op}: a retry succeeds`);
  }
  // A lock timeout anywhere is 409 ATTENDANCE_BUSY after the rollback.
  reset();
  student("s1");
  const fp = await fingerprint();
  pg.failOn = (label, o) => (o === "lock:register" ? lockTimeoutError() : null);
  await refusedWithoutWrites(finalize(fp), (e) => e.code === "ATTENDANCE_BUSY");
});

// ---- 26-29. Locks --------------------------------------------------------------------------------

test("26, 27, 28. Student locks first (one statement, ascending, every candidate), then Lecture, Class, Register", async () => {
  reset();
  register();
  for (const id of ["s5", "s3", "s1", "s4", "s2"]) student(id);
  student("s-deleted", { status: 2 });
  student("s-foreign-record", { teacherId: T2, enrolledAt: null });
  seedRecord("s-foreign-record", teacherRecord("PRESENT"));
  const fp = await fingerprint();
  let heldDuring = null;
  pg.beforeStatement = async (label, op) => {
    if (label === "tx1" && op === "lock:lecture") heldDuring = pg.held.filter((h) => h.owner === "tx1").map((h) => `${h.row}:${h.mode}`);
  };
  await finalize(fp);
  const statements = pg.transactions[0].statements;
  const first = (op) => statements.indexOf(op);
  assert.equal(statements.filter((s) => s === "lock:students").length, 1, "one statement");
  assert.ok(first("lock:students") < first("lock:lecture") && first("lock:lecture") < first("lock:class") && first("lock:class") < first("lock:register"));
  assert.ok(!statements.slice(first("lock:lecture")).includes("lock:student"), "no Student lock afterwards");
  assert.deepEqual(heldDuring, [
    "student:s-deleted:SHARE", "student:s-foreign-record:SHARE", "student:s1:SHARE", "student:s2:SHARE", "student:s3:SHARE", "student:s4:SHARE", "student:s5:SHARE",
  ], "every candidate (deleted and record holders included), ascending, before the Lecture");
  assert.equal(record("s-deleted"), null);
  assert.equal(record("s-foreign-record").statusSource, "TEACHER");
});

test("29. the Student set lock is finalization-only, first-only, once, sorted, at most 500; the bulk helper is finalization- and write-phase-only", async () => {
  reset();
  student("s1");
  student("s2");
  const rejects = (work, pattern, finalizationScope = true) =>
    assert.rejects((finalizationScope ? lockLib.runFinalizationTransaction : lockLib.runAttendanceTransaction)(work), pattern);

  await rejects((locks) => lockLib.lockStudentSetForFinalization(locks, ["s1"]), /only be locked by the finalization transaction/, false);
  await rejects(async (locks) => { await lockLib.lockLectureShared(locks, L1); await lockLib.lockStudentSetForFinalization(locks, ["s1"]); }, /must be the first lock/);
  await rejects(async (locks) => { await lockLib.lockStudentSetForFinalization(locks, ["s1"]); await lockLib.lockStudentSetForFinalization(locks, ["s2"]); }, /already locked/);
  await rejects((locks) => lockLib.lockStudentSetForFinalization(locks, ["s2", "s1"]), /strictly ascending/);
  await rejects((locks) => lockLib.lockStudentSetForFinalization(locks, ["s1", "s1"]), /strictly ascending/);
  await rejects((locks) => lockLib.lockStudentSetForFinalization(locks, Array.from({ length: 501 }, (_, i) => `s${String(i).padStart(4, "0")}`)), /more than 500/);
  await rejects(async (locks) => { await lockLib.lockStudentSetForFinalization(locks, ["s1"]); await lockLib.lockStudentShared(locks, "s2"); }, /second STUDENT row/);
  await rejects(async (locks) => { locks.beginWrites(); await lockLib.lockStudentSetForFinalization(locks, ["s1"]); }, /after writes began/);
  // Re-locking a student of the set is allowed (no new wait).
  await lockLib.runFinalizationTransaction(async (locks) => {
    await lockLib.lockStudentSetForFinalization(locks, ["s1", "s2"]);
    await lockLib.lockStudentShared(locks, "s2");
    await lockLib.lockLectureShared(locks, L1);
  });

  register();
  const absent = (locks) => lockLib.createFinalizationAbsences(locks, { lectureId: L1, classId: C1, studentIds: ["s1"], now: NOW });
  await rejects(async (locks) => { await lockLib.lockRegisterForUpdate(locks, L1); locks.beginWrites(); await absent(locks); }, /only be created by the finalization transaction/, false);
  await rejects(async (locks) => { await lockLib.lockRegisterForUpdate(locks, L1); await absent(locks); }, /after beginWrites/);
  await rejects(async (locks) => { await lockLib.lockRegisterKeyShared(locks, L1); locks.beginWrites(); await absent(locks); }, /register FOR UPDATE/);
  await rejects(async (locks) => {
    await lockLib.lockRegisterForUpdate(locks, L1);
    locks.beginWrites();
    await lockLib.createFinalizationAbsences(locks, { lectureId: L1, classId: C1, studentIds: ["s2", "s1"], now: NOW });
  }, /strictly ascending/);
  // A conflicting row is a unique violation (never skipped): everything rolls back.
  seedRecord("s1", teacherRecord("PRESENT"));
  const before = snapshot();
  await rejects(async (locks) => { await lockLib.lockRegisterForUpdate(locks, L1); locks.beginWrites(); await absent(locks); }, (e) => e.code === "P2002");
  assert.equal(snapshot(), before);
});

test("29, 30. static guards: the finalization-only helpers are used only by the finalization service; no API route or UI yet; join untouched", () => {
  const code = (file) => fs.readFileSync(path.join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const users = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(entry.name) && /runFinalizationTransaction|lockStudentSetForFinalization|createFinalizationAbsences|finalizeLectureAttendance/.test(code(rel))) users.push(rel);
    }
  };
  for (const dir of ["app", "components", "lib", "services", "scripts"]) if (fs.existsSync(path.join(root, dir))) walk(dir);
  // Stage 5.5c: the finalize API route calls the service (and only the service).
  assert.deepEqual(users.sort(), [
    "app/api/lectures/[id]/attendance/finalize/route.ts",
    "lib/attendance/locks.ts",
    "services/lecture-attendance-finalization-service.ts",
  ]);
  const routeCode = code("app/api/lectures/[id]/attendance/finalize/route.ts");
  assert.doesNotMatch(routeCode, /runFinalizationTransaction|lockStudentSetForFinalization|createFinalizationAbsences|@\/lib\/attendance\/locks|prisma/);

  const service = code("services/lecture-attendance-finalization-service.ts");
  assert.doesNotMatch(service, /\$queryRaw|\$executeRaw|\$transaction|skipDuplicates|console\./);
  assert.doesNotMatch(service, /data:\s*\{[^}]*classStatus/, "Lecture.classStatus is never written");
  assert.doesNotMatch(service, /lecture\.update|reconcile|backfill|recordOnlineEvidence|dispatch/i);
  assert.match(service, /planFinalizationAbsences/);
  assert.match(service, /buildFinalizationPreview/);
});

// ---- D10 / D11: eligibility at the scheduled start ---------------------------------------------

const DAY = 24 * 60;
/** The roster entry (eligibility at the scheduled start) the register view reports for a student. */
const rosterEntry = async (studentId) =>
  (await attendanceService.getRegister(T1, L1, { env: ENV, now: new Date() })).roster.find((e) => e.studentId === studentId);
const absentAuditsFor = (studentId) => recordAuditsOf("FINALIZE_ABSENT").filter((a) => a.studentId === studentId);

test("D11 / A. enrolled at the start, removed afterwards (lecture day 0, removal day 5, finalized day 10): one ABSENT and its audit", async () => {
  reset();
  test.mock.timers.setTime(at(10 * DAY).getTime());
  register();
  student("s-removed-after", { enrolledAt: new Date("2026-08-05T00:00:00Z"), removedAt: at(5 * DAY) });
  const enrolment = pg.committed.enrolments.find((e) => e.studentId === "s-removed-after");
  assert.deepEqual([enrolment.isActive, enrolment.removedAt !== null], [false, true], "a removed ClassStudent row");

  const entry = await rosterEntry("s-removed-after");
  assert.deepEqual([entry.eligibility.outcome, entry.eligibility.reason, entry.absenceDecision], ["ELIGIBLE", "ELIGIBLE", "CREATE_ABSENT"]);
  const p = await preview.getLectureAttendanceFinalizationPreview({ teacherId: T1, lectureId: L1 }, { env: ENV });
  assert.deepEqual([p.summary.rosterSize, p.summary.automaticAbsent, p.summary.notEligibleWithoutRecord, p.readiness.ready], [1, 1, 0, true]);

  const result = await finalize(p.fingerprint);
  assert.deepEqual([result.absentCreated, result.eligibleStudents, result.details.rosterSize], [1, 1, 1]);
  const r = record("s-removed-after");
  assert.deepEqual([r.status, r.statusSource, r.version, r.firstOnlineAt, r.firstQrAt, r.autoStatus], ["ABSENT", "FINALIZATION", 1, null, null, null]);
  const audits = absentAuditsFor("s-removed-after");
  assert.equal(audits.length, 1);
  const [fin] = registerAuditsOf("FINALIZED");
  assert.deepEqual(
    [audits[0].lectureAttendanceId, audits[0].version, audits[0].toStatus, audits[0].actorRole, audits[0].actorId, audits[0].registerAuditId],
    [r.id, 1, "ABSENT", "SYSTEM", null, fin.id]
  );
  assert.equal(fin.absentCreatedCount, 1);

  // A repeated confirmation adds nothing.
  await finalize(p.fingerprint);
  assert.equal(Object.keys(pg.committed.records).length, 1);
  assert.equal(absentAuditsFor("s-removed-after").length, 1);
});

test("D11 / A. the removal boundary is half-open: removed exactly at the start is not enrolled, one millisecond later is", async () => {
  reset();
  register();
  student("s-removed-at-start", { removedAt: START });
  student("s-removed-just-after", { removedAt: new Date(START.getTime() + 1) });
  assert.equal((await rosterEntry("s-removed-at-start")).eligibility.reason, "NOT_ENROLLED");
  assert.equal((await rosterEntry("s-removed-just-after")).eligibility.reason, "ELIGIBLE");
  const result = await confirm();
  assert.equal(result.absentCreated, 1);
  assert.equal(record("s-removed-at-start"), null);
  assert.equal(record("s-removed-just-after").status, "ABSENT");
});

test("D11 / B. enrolled only after the start: NOT_ENROLLED at the start, no ABSENT", async () => {
  reset();
  register();
  student("s-enrolled-after", { enrolledAt: new Date(START.getTime() + 1) });
  student("s-enrolled-next-day", { enrolledAt: at(DAY) });
  for (const id of ["s-enrolled-after", "s-enrolled-next-day"]) {
    const entry = await rosterEntry(id);
    assert.deepEqual([entry.eligibility.outcome, entry.eligibility.reason, entry.absenceDecision], ["NOT_ELIGIBLE", "NOT_ENROLLED", "NOT_ELIGIBLE"], id);
  }
  const p = await preview.getLectureAttendanceFinalizationPreview({ teacherId: T1, lectureId: L1 }, { env: ENV });
  assert.deepEqual([p.summary.rosterSize, p.summary.automaticAbsent, p.summary.notEligibleWithoutRecord], [2, 0, 2]);
  const result = await finalize(p.fingerprint);
  assert.equal(result.absentCreated, 0);
  assert.deepEqual(pg.committed.records, {});
  assert.equal(recordAuditsOf("FINALIZE_ABSENT").length, 0);
});

test("D10 / C, D. an inactive (status 1) or deleted (status 2) account enrolled and approved at the start: STUDENT_INACTIVE, no ABSENT, no audit", async () => {
  reset();
  register();
  student("s-active");
  student("s-inactive", { status: 1 });
  student("s-deleted", { status: 2 });
  for (const id of ["s-inactive", "s-deleted"]) {
    const entry = await rosterEntry(id);
    assert.deepEqual([entry.eligibility.outcome, entry.eligibility.reason, entry.absenceDecision], ["NOT_ELIGIBLE", "STUDENT_INACTIVE", "NOT_ELIGIBLE"], id);
  }
  const p = await preview.getLectureAttendanceFinalizationPreview({ teacherId: T1, lectureId: L1 }, { env: ENV });
  // Each student exactly once: 1 automatic ABSENT + 2 not eligible = the roster.
  assert.deepEqual([p.summary.rosterSize, p.summary.automaticAbsent, p.summary.notEligibleWithoutRecord, p.summary.eligibleStudents], [3, 1, 2, 1]);

  const result = await finalize(p.fingerprint);
  assert.deepEqual([result.absentCreated, result.eligibleStudents], [1, 1]);
  assert.equal(record("s-active").status, "ABSENT");
  for (const id of ["s-inactive", "s-deleted"]) {
    assert.equal(record(id), null, id);
    assert.deepEqual(absentAuditsFor(id), [], id);
  }
});

test("D10 / D11 with existing records: records preserved, each student counted once, preview and finalization agree", async () => {
  reset();
  register();
  student("s-removed-after", { removedAt: at(DAY) });
  student("s-removed-after-recorded", { removedAt: at(DAY) });
  seedRecord("s-removed-after-recorded", teacherRecord("EXCUSED"));
  student("s-inactive-recorded", { status: 1 });
  seedRecord("s-inactive-recorded", teacherRecord("PRESENT"));
  student("s-enrolled-after", { enrolledAt: at(30) });
  const kept = JSON.stringify([record("s-removed-after-recorded"), record("s-inactive-recorded")]);

  const p = await preview.getLectureAttendanceFinalizationPreview({ teacherId: T1, lectureId: L1 }, { env: ENV });
  const s = p.summary;
  assert.deepEqual([s.rosterSize, s.studentsWithRecord, s.automaticAbsent, s.manualReview, s.notEligibleWithoutRecord], [4, 2, 1, 0, 1]);
  assert.equal(s.studentsWithRecord + s.automaticAbsent + s.manualReview + s.notEligibleWithoutRecord, s.rosterSize);
  // Identical inputs, identical fingerprint; the transaction recomputes and accepts it.
  assert.equal((await preview.getLectureAttendanceFinalizationPreview({ teacherId: T1, lectureId: L1 }, { env: ENV })).fingerprint, p.fingerprint);
  const result = await finalize(p.fingerprint);
  assert.deepEqual([result.absentCreated, result.details.studentsWithRecord, result.details.notEligibleWithoutRecord], [1, 2, 1]);
  assert.equal(JSON.stringify([record("s-removed-after-recorded"), record("s-inactive-recorded")]), kept);
  assert.equal(record("s-removed-after").status, "ABSENT");
  assert.equal(record("s-enrolled-after"), null);
});
