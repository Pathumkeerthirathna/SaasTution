/*
 * Stage 5.4f-2: historical attendance backfill
 * (services/lecture-attendance-backfill-service.ts, scripts/attendance-backfill-cli.ts).
 *
 *   npm run test:attendance-backfill
 *
 * No database: the real service and CLI logic run through tsx against the
 * in-memory PostgreSQL model (tests/attendance/helpers/attendance-pg-model.cjs).
 * The script itself is never executed. This is NOT a real-PostgreSQL
 * validation (postponed).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
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

const backfill = require(path.join(root, "services", "lecture-attendance-backfill-service.ts"));
const cli = require(path.join(root, "scripts", "attendance-backfill-cli.ts"));
const evidence = require(path.join(root, "services", "lecture-attendance-evidence-service.ts"));
const decisions = require(path.join(root, "services", "lecture-attendance-decision-service.ts"));

// ---- Clock and fixtures ----------------------------------------------------------------

// A HISTORICAL lecture: before ATTENDANCE_EVIDENCE_STARTED_AT.
const START = new Date("2026-08-10T12:30:00.000Z");
const at = (minutes, ms = 0) => new Date(START.getTime() + minutes * 60_000 + ms);
const NOW = new Date("2026-11-11T08:00:00.000Z");
test.mock.timers.enable({ apis: ["Date"], now: NOW });

const T1 = "teacher-1";
const T2 = "teacher-2";
const C1 = "class-1";
const L1 = "lecture-1";
const APPROVED_AT = new Date("2026-08-01T00:00:00.000Z");
const ENV = {
  APPROVAL_FEATURE_STARTED_AT: "2026-07-28T00:00:00Z",
  ATTENDANCE_EVIDENCE_STARTED_AT: "2026-08-15T00:00:00Z",
};
const DATABASE_URL = "postgresql://backfill_user:not-a-real-password@db.example.test:5432/slc_testing";

let model;
let pg;
let visitSeq = 0;

// ClassStudent times are stored as Sri Lanka wall-clock digits (+05:30), as in the other suites.
const local = (date) => new Date(date.getTime() + (5 * 60 + 30) * 60_000);

function student(id, { teacherId = T1, status = 0, confirmationStatus = "APPROVED", broken = false, approvedAt = APPROVED_AT,
  enrolledAt = new Date("2026-08-05T00:00:00Z"), removedAt = null } = {}) {
  pg.committed.students[id] = {
    id, name: `Name of ${id}`, registrationNumber: null, teacherId, status, confirmationStatus,
    confirmedAt: confirmationStatus === "PENDING" ? null : broken ? new Date(approvedAt.getTime() + 86_400_000) : approvedAt,
    approvedAt: confirmationStatus === "PENDING" ? null : approvedAt,
  };
  if (confirmationStatus !== "PENDING") {
    pg.committed.history.push({ id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: confirmationStatus, decidedAt: approvedAt, previousConfirmedAt: null });
  }
  if (enrolledAt) {
    pg.committed.enrolments.push({
      id: `e-${id}`, studentId: id, classId: C1, assignedAt: local(enrolledAt), removedAt: removedAt ? local(removedAt) : null, isActive: !removedAt,
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
  test.mock.timers.setTime(NOW.getTime());
}

const run = (mode = "execute", env = ENV, lectureId = L1) => backfill.backfillLectureAttendance({ lectureId, mode }, { env });
const record = (studentId, lectureId = L1) => pg.committed.records[`${lectureId}:${studentId}`] ?? null;
const audits = (studentId) =>
  pg.committed.recordAudits.filter((a) => a.lectureAttendanceId === record(studentId)?.id).sort((a, b) => a.version - b.version);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const counts = (result) => {
  const { lectureId, mode, stoppedBecause, ...rest } = result;
  void lectureId; void mode; void stoppedBecause;
  return rest;
};
const ZERO = { students: 0, created: 0, createdLateJoin: 0, existing: 0, ineligible: 0, unknown: 0, inactive: 0, skipped: 0, busy: 0 };
const snapshot = () =>
  JSON.stringify([pg.committed.records, pg.committed.recordAudits, pg.committed.registers, pg.committed.registerAudits, pg.committed.scans]);

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

function gateOn(label, op) {
  let release;
  const gate = new Promise((r) => { release = r; });
  pg.beforeStatement = async (l, o) => {
    if (l === label && o === op) await gate;
  };
  return release;
}

function cliRun(argv, { databaseUrl = DATABASE_URL, env = ENV } = {}) {
  const out = [];
  const err = [];
  return cli
    .runAttendanceBackfillCli(argv, { databaseUrl, env, log: (l) => out.push(l), error: (l) => err.push(l) })
    .then((code) => ({ code, out, err, text: [...out, ...err].join("\n") }));
}

const EXECUTE = ["--execute", "--confirm-backfill-historical-attendance", "--confirm-database=slc_testing"];

// ---- 1, 24. Dry run -------------------------------------------------------------------------------

test("1. dry run (the service default) reports what execute would do and writes nothing", async () => {
  reset();
  student("s1");
  student("s2");
  student("s-pending", { confirmationStatus: "PENDING" });
  visit("s1", at(3));
  visit("s2", at(25)); // after start + grace: autoStatus LATE
  visit("s-pending", at(3));
  const before = snapshot();

  const result = await backfill.backfillLectureAttendance({ lectureId: L1 }, { env: ENV });
  assert.equal(result.mode, "dry-run");
  assert.deepEqual(counts(result), { ...ZERO, students: 3, created: 2, createdLateJoin: 1, ineligible: 1 });
  assert.equal(snapshot(), before);
  assert.equal(pg.transactions.length, 0, "no transaction at all (no locks)");

  // The dry run agrees with what execute then does.
  assert.deepEqual(counts(await run("execute")), counts(result));
});

test("24. dry-run script mode: exit 0, counts only, no transaction, no writes", async () => {
  reset();
  student("s-secret");
  visit("s-secret", at(3));
  const before = snapshot();
  const { code, out, err, text } = await cliRun([`--lecture=${L1}`]);
  assert.equal(code, 0);
  assert.deepEqual(err, []);
  assert.equal(snapshot(), before);
  assert.equal(pg.transactions.length, 0);
  assert.match(out[0], /DRY RUN \(no writes\)/);
  assert.match(text, /would create 1/);
  assert.match(text, /Dry run only: nothing was changed\./);
  for (const secret of ["s-secret", "Name of", "visit-", "backfill_user", "not-a-real-password", "postgresql://"]) assert.ok(!text.includes(secret), secret);
  assert.match(text, /target database: db\.example\.test:5432\/slc_testing/);

  assert.equal((await cliRun([`--lecture=${L1}`, "--dry-run"])).code, 0);
  assert.equal(pg.transactions.length, 0);
});

// ---- 2, 3, 16. Record creation ---------------------------------------------------------------------

test("2, 3, 16. execute creates one BACKFILL record (PRESENT) and its BACKFILL v1 audit (SYSTEM, visit link)", async () => {
  reset();
  student("s1");
  const v = visit("s1", at(4));
  const result = await run();
  assert.deepEqual(counts(result), { ...ZERO, students: 1, created: 1 });
  assert.equal(result.stoppedBecause, null);

  const rec = record("s1");
  assert.deepEqual(
    [rec.status, rec.statusSource, rec.autoStatus, rec.firstOnlineAt.toISOString(), rec.firstQrAt, rec.teacherStatus, rec.teacherDecidedAt, rec.teacherDecidedById, rec.pendingReviewSince, rec.version, rec.classId],
    ["PRESENT", "BACKFILL", "PRESENT", at(4).toISOString(), null, null, null, null, null, 1, C1]
  );
  model.checkRecord(rec);
  const [audit, ...more] = audits("s1");
  assert.equal(more.length, 0);
  assert.deepEqual(
    [audit.action, audit.version, audit.fromStatus, audit.toStatus, audit.fromAutoStatus, audit.toAutoStatus, audit.fromTeacherStatus, audit.toTeacherStatus,
      audit.actorRole, audit.actorId, audit.reason, audit.afterFinalization, audit.scanEventId, audit.attendanceVisitId, audit.createdAt.toISOString()],
    ["BACKFILL", 1, null, "PRESENT", null, "PRESENT", null, null, "SYSTEM", null, null, false, null, v, NOW.toISOString()]
  );
  model.checkAudit(audit);

  // The register: created by the SYSTEM with the lecture's schedule and the class's grace.
  const reg = pg.committed.registers[L1];
  assert.deepEqual([reg.scheduledStartAt.toISOString(), reg.graceMinutes, reg.finalizedAt, reg.version], [START.toISOString(), 10, null, 1]);
  const [created] = pg.committed.registerAudits;
  assert.deepEqual([created.action, created.actorRole, created.actorId], ["CREATED", "SYSTEM", null]);
  assert.equal(pg.committed.scans.length, 0, "no scan events");
});

test("3, 4. canonical status is always PRESENT; autoStatus is the join-time classification (grace boundary, register grace)", async () => {
  reset();
  register({ graceMinutes: 5 }); // the register's own grace, not the class's 10
  student("s-on-time");
  student("s-boundary");
  student("s-late");
  student("s-very-late");
  visit("s-on-time", at(-20)); // before the start
  visit("s-boundary", at(5)); // exactly start + grace: PRESENT
  visit("s-late", at(5, 1)); // one millisecond later: LATE
  visit("s-very-late", at(110));
  const result = await run();
  assert.deepEqual(counts(result), { ...ZERO, students: 4, created: 4, createdLateJoin: 2 });
  const view = (id) => [record(id).status, record(id).autoStatus, audits(id)[0].toStatus, audits(id)[0].toAutoStatus];
  assert.deepEqual(view("s-on-time"), ["PRESENT", "PRESENT", "PRESENT", "PRESENT"]);
  assert.deepEqual(view("s-boundary"), ["PRESENT", "PRESENT", "PRESENT", "PRESENT"]);
  assert.deepEqual(view("s-late"), ["PRESENT", "LATE", "PRESENT", "LATE"]);
  assert.deepEqual(view("s-very-late"), ["PRESENT", "LATE", "PRESENT", "LATE"]);
});

// ---- 5, 6, 7. Visit selection ------------------------------------------------------------------------

test("5. earliest eligible visit across sessions (restarts) by joinedAt, then visit id; unlinked sessions ignored", async () => {
  reset();
  student("s1");
  student("s2");
  visit("s1", at(20), "session-a");
  const early = visit("s1", at(15), "session-b");
  visit("s1", at(40), "session-b");
  visit("s1", at(1), "session-free"); // no lecture link: never considered
  const tieA = visit("s2", at(7), "session-b");
  visit("s2", at(7), "session-a");
  await run();
  assert.deepEqual([record("s1").firstOnlineAt.toISOString(), record("s1").autoStatus, audits("s1")[0].attendanceVisitId], [at(15).toISOString(), "LATE", early]);
  assert.equal(audits("s2")[0].attendanceVisitId, tieA);
});

test("6. approval at joinedAt (immutable history): visits before the approval are skipped; a later rejection does not matter", async () => {
  reset();
  student("s-approved-mid", { approvedAt: at(5) });
  visit("s-approved-mid", at(2)); // still PENDING then
  const used = visit("s-approved-mid", at(8));
  // Approved at the lecture, rejected afterwards: still approved at the join time.
  student("s-rejected-later");
  pg.committed.history.push({ id: "h-rej", studentId: "s-rejected-later", fromStatus: "APPROVED", toStatus: "REJECTED", decidedAt: at(60 * 24 * 7), previousConfirmedAt: APPROVED_AT });
  Object.assign(pg.committed.students["s-rejected-later"], { confirmationStatus: "REJECTED", confirmedAt: at(60 * 24 * 7) });
  visit("s-rejected-later", at(3));
  // Only approved after the lecture: not approved at any visit.
  student("s-approved-after", { approvedAt: at(60 * 24) });
  visit("s-approved-after", at(3));

  const result = await run();
  assert.deepEqual(counts(result), { ...ZERO, students: 3, created: 2, ineligible: 1 });
  assert.equal(audits("s-approved-mid")[0].attendanceVisitId, used);
  assert.equal(record("s-approved-mid").firstOnlineAt.toISOString(), at(8).toISOString());
  assert.equal(record("s-rejected-later").status, "PRESENT");
  assert.equal(record("s-approved-after"), null);
});

test("7. enrolment at joinedAt: before enrolment skipped, after removal skipped, never enrolled skipped", async () => {
  reset();
  student("s-enrolled-mid", { enrolledAt: at(6) });
  visit("s-enrolled-mid", at(2));
  visit("s-enrolled-mid", at(9));
  student("s-removed", { removedAt: at(-60) });
  visit("s-removed", at(3));
  student("s-never", { enrolledAt: null });
  visit("s-never", at(3));
  const result = await run();
  assert.deepEqual(counts(result), { ...ZERO, students: 3, created: 1, ineligible: 2 });
  assert.equal(record("s-enrolled-mid").firstOnlineAt.toISOString(), at(9).toISOString());
  assert.equal(record("s-removed"), null);
  assert.equal(record("s-never"), null);
});

// ---- 8, 9, 10. Skipped students -----------------------------------------------------------------

test("8, 9. UNKNOWN and NOT_APPROVED students are skipped and counted; nothing is created", async () => {
  reset();
  student("s-unknown", { broken: true });
  student("s-pending", { confirmationStatus: "PENDING" });
  visit("s-unknown", at(3));
  visit("s-pending", at(3));
  for (const mode of ["dry-run", "execute"]) {
    assert.deepEqual(counts(await run(mode)), { ...ZERO, students: 2, unknown: 1, ineligible: 1 }, mode);
  }
  assert.deepEqual(pg.committed.records, {});
  assert.deepEqual(pg.committed.registers, {}, "no register created when nothing is backfilled");
});

test("10. deleted / inactive students skipped and counted; another teacher's student skipped", async () => {
  reset();
  student("s-deleted", { status: 2 });
  student("s-inactive", { status: 1 });
  student("s-other", { teacherId: T2 });
  for (const id of ["s-deleted", "s-inactive", "s-other"]) visit(id, at(3));
  for (const mode of ["dry-run", "execute"]) {
    assert.deepEqual(counts(await run(mode)), { ...ZERO, students: 3, inactive: 2, skipped: 1 }, mode);
  }
  assert.deepEqual(pg.committed.records, {});
});

// ---- 11, 12, 13. Existing records -------------------------------------------------------------------

test("11, 12, 13. existing AUTO, TEACHER (with a pending review), BACKFILL and FINALIZATION-free records are never changed", async () => {
  reset();
  register();
  for (const id of ["s-auto", "s-teacher", "s-backfill", "s-new"]) student(id);
  seedRecord("s-auto", { status: "LATE", statusSource: "AUTO", firstQrAt: at(30), autoStatus: "LATE" });
  seedRecord("s-teacher", { status: "ABSENT", statusSource: "TEACHER", teacherStatus: "ABSENT", teacherDecidedAt: at(1), teacherDecidedById: T1,
    firstQrAt: at(20), autoStatus: "LATE", pendingReviewSince: at(21) });
  seedRecord("s-backfill", { status: "PRESENT", statusSource: "BACKFILL", firstOnlineAt: at(25), autoStatus: "LATE" });
  for (const id of ["s-auto", "s-teacher", "s-backfill", "s-new"]) visit(id, at(2)); // earlier and stronger than the records' evidence
  const kept = JSON.stringify([record("s-auto"), record("s-teacher"), record("s-backfill"), pg.committed.recordAudits]);

  assert.deepEqual(counts(await run("dry-run")), { ...ZERO, students: 4, created: 1, existing: 3 });
  assert.deepEqual(counts(await run()), { ...ZERO, students: 4, created: 1, existing: 3 });
  assert.equal(JSON.stringify([record("s-auto"), record("s-teacher"), record("s-backfill"), pg.committed.recordAudits.filter((a) => a.studentId !== "s-new")]), kept);
  assert.equal(record("s-teacher").pendingReviewSince.toISOString(), at(21).toISOString());
  assert.equal(record("s-new").statusSource, "BACKFILL");
});

// ---- 14. Concurrent insert race ----------------------------------------------------------------------

test("14. concurrent backfills of the same student: one record, one audit; the loser reports it as existing", async () => {
  reset();
  student("s1");
  visit("s1", at(3));
  const release = gateOn("tx1", "create:audit");
  const first = run();
  while (!pg.log.includes("tx1:insert:record:s1")) await tick();
  const second = run();
  while (!pg.log.some((e) => e.startsWith("tx2:waits:") || e.startsWith("tx2:unique-wait:"))) await tick();
  release();
  assert.deepEqual(counts(await first), { ...ZERO, students: 1, created: 1 });
  assert.deepEqual(counts(await second), { ...ZERO, students: 1, existing: 1 });
  assert.equal(Object.keys(pg.committed.records).length, 1);
  assert.equal(audits("s1").length, 1);
  assert.equal(pg.committed.registerAudits.length, 1, "one register, one CREATED audit");
});

test("14. a teacher decision wins a race with the backfill: the backfill inserts nothing", async () => {
  reset();
  student("s1");
  visit("s1", at(3));
  const release = gateOn("tx1", "create:audit");
  const deciding = decisions.setTeacherAttendanceStatus({ teacherId: T1, lectureId: L1, studentId: "s1", status: "ABSENT", expectedVersion: null });
  while (!pg.log.includes("tx1:insert:record:s1")) await tick();
  const backfilling = run();
  while (!pg.log.some((e) => e.startsWith("tx2:waits:") || e.startsWith("tx2:unique-wait:"))) await tick();
  release();
  await deciding;
  assert.deepEqual(counts(await backfilling), { ...ZERO, students: 1, existing: 1 });
  assert.deepEqual([record("s1").status, record("s1").statusSource, audits("s1").length], ["ABSENT", "TEACHER", 1]);
});

// ---- 15. Idempotency -----------------------------------------------------------------------------

test("15. repeated execution creates nothing twice and writes nothing", async () => {
  reset();
  for (const id of ["s1", "s2", "s3"]) { student(id); visit(id, at(3)); visit(id, at(50)); }
  assert.deepEqual(counts(await run()), { ...ZERO, students: 3, created: 3 });
  const after = snapshot();
  for (let i = 0; i < 2; i += 1) assert.deepEqual(counts(await run()), { ...ZERO, students: 3, existing: 3 });
  assert.deepEqual(counts(await run("dry-run")), { ...ZERO, students: 3, existing: 3 });
  assert.equal(snapshot(), after);
  assert.equal(pg.committed.recordAudits.length, 3);
});

test("BACKFILL records are not changed later by online evidence (evidence rules unchanged)", async () => {
  reset();
  student("s1");
  visit("s1", at(30));
  await run();
  // Online evidence skips HISTORICAL lectures entirely.
  const v = visit("s1", at(1));
  assert.deepEqual(await evidence.recordOnlineEvidence(v, { env: ENV }), { status: "SKIPPED", reason: "HISTORICAL_LECTURE" });
  assert.deepEqual([record("s1").status, record("s1").autoStatus, record("s1").version], ["PRESENT", "LATE", 1]);
});

// ---- 17, 18, 19. Lecture refusals --------------------------------------------------------------------

test("17. LIVE lectures are refused (lecture date, or the register's start) in both modes", async () => {
  reset();
  student("s1");
  visit("s1", at(3));
  pg.committed.lectures[L1].date = new Date("2026-08-15T00:00:00Z"); // exactly the evidence start: LIVE
  for (const mode of ["dry-run", "execute"]) {
    await assert.rejects(run(mode), (e) => e.code === "ATTENDANCE_LECTURE_LIVE" && e.statusCode === 409, mode);
  }
  pg.committed.lectures[L1].date = START;
  register({ scheduledStartAt: new Date("2026-09-01T00:00:00Z") }); // the register's start decides
  await assert.rejects(run(), (e) => e.code === "ATTENDANCE_LECTURE_LIVE");
  assert.equal(pg.transactions.length, 0);
  assert.deepEqual(pg.committed.records, {});
});

test("18. finalized lectures are refused in both modes; nothing is read or written", async () => {
  reset();
  student("s1");
  visit("s1", at(3));
  register({ finalizedAt: at(200), finalizedByTeacherId: T1, version: 2 });
  for (const mode of ["dry-run", "execute"]) {
    await assert.rejects(run(mode), (e) => e.code === "ATTENDANCE_REGISTER_FINALIZED" && e.statusCode === 409, mode);
  }
  assert.ok(!pg.log.includes("read:visits"));
  assert.equal(pg.transactions.length, 0);
});

test("19. cancelled, deleted and missing lectures are refused", async () => {
  reset();
  student("s1");
  visit("s1", at(3));
  pg.committed.lectures[L1].classStatus = "CANCELLED";
  await assert.rejects(run(), (e) => e.code === "LECTURE_CANCELLED" && e.statusCode === 409);
  pg.committed.lectures[L1].classStatus = "COMPLETED";
  pg.committed.lectures[L1].status = 1;
  await assert.rejects(run(), (e) => e.code === "LECTURE_NOT_FOUND" && e.statusCode === 404);
  await assert.rejects(run("execute", ENV, "lecture-missing"), (e) => e.code === "LECTURE_NOT_FOUND");
  await assert.rejects(backfill.backfillLectureAttendance({ lectureId: L1, mode: "write" }, { env: ENV }), (e) => e.code === "VALIDATION_ERROR");
  assert.equal(pg.transactions.length, 0);
  assert.deepEqual(pg.committed.records, {});
});

test("a lecture cancelled mid-run stops the run (re-checked under the lock); a later run is safe", async () => {
  reset();
  for (const id of ["s1", "s2", "s3"]) { student(id); visit(id, at(3)); }
  pg.beforeStatement = async (label, op) => {
    if (label === "tx2" && op === "lock:lecture") pg.committed.lectures[L1].classStatus = "CANCELLED";
  };
  const result = await run();
  assert.equal(result.stoppedBecause, "LECTURE_CHANGED");
  assert.deepEqual(counts(result), { ...ZERO, students: 1, created: 1 });
  assert.equal(record("s2"), null);
});

// ---- 20. Busy students --------------------------------------------------------------------------------

test("20. a busy student is counted (rolled back); the lecture continues; a later run catches up", async () => {
  reset();
  for (const id of ["s1", "s2", "s3"]) { student(id); visit(id, at(3)); }
  pg.held.push({ row: "student:s2", owner: "approval-decision", mode: "NO_KEY_UPDATE" });
  pg.failWhenBlocked = true;
  assert.deepEqual(counts(await run()), { ...ZERO, students: 3, created: 2, busy: 1 });
  assert.equal(record("s2"), null);
  assert.equal(pg.transactions.filter((t) => t.outcome === "rollback").length, 1);

  pg.failWhenBlocked = false;
  model.locks.release("approval-decision");
  assert.deepEqual(counts(await run()), { ...ZERO, students: 3, created: 1, existing: 2 });
});

test("busy students make the CLI report an incomplete run (exit 1)", async () => {
  reset();
  student("s1");
  visit("s1", at(3));
  pg.held.push({ row: "student:s1", owner: "approval-decision", mode: "NO_KEY_UPDATE" });
  pg.failWhenBlocked = true;
  const { code, text } = await cliRun([`--lecture=${L1}`, ...EXECUTE]);
  assert.equal(code, 1);
  assert.match(text, /busy 1/);
  assert.match(text, /Incomplete/);
});

test("all students of a lecture are processed in batches of 500 (studentId order)", async () => {
  reset();
  for (let i = 0; i < 501; i += 1) {
    const id = `s${String(i).padStart(4, "0")}`;
    student(id);
    visit(id, at(3));
  }
  assert.equal(backfill.BACKFILL_STUDENT_BATCH, 500);
  assert.deepEqual(counts(await run("dry-run")), { ...ZERO, students: 501, created: 501 });
  assert.equal(pg.log.filter((e) => e === "read:visits").length, 4, "two batches: student ids + visits each");
});

// ---- 21, 22, 23. Script arguments ----------------------------------------------------------------------

test("21. scope arguments are validated strictly", () => {
  const usage = (argv, pattern) =>
    assert.throws(() => cli.parseBackfillArgs(argv), (e) => e instanceof cli.BackfillUsageError && (!pattern || pattern.test(e.message)), argv.join(" "));

  usage([], /A scope is required/);
  usage(["--dry-run"], /A scope is required/);
  usage(["--lecture=l1", "--class=c1"], /exactly one scope/);
  usage(["--class=c1", "--before=2026-08-15T00:00:00Z"], /exactly one scope/);
  usage(["--lecture=l1", "--lecture=l2"], /more than once/);
  usage(["--lecture="], /valid id/);
  usage(["--lecture=l1;DROP"], /valid id/);
  usage(["--class=" + "x".repeat(192)], /valid id/);
  for (const bad of ["2026-08-15", "2026-08-15T00:00:00", "2026-08-15T00:00:00-00:00", "2026-02-30T00:00:00Z", "yesterday", ""]) {
    usage([`--before=${bad}`], /explicit offset/);
  }
  usage(["--all"], /Unknown argument \(value not shown\)/);
  usage(["--lecture=l1", "postgresql://u:secret@h/db"], /Unknown argument/);
  usage(["--lecture=l1", "--execute", "--dry-run"], /cannot be combined/);
  // An unknown argument is never echoed.
  try {
    cli.parseBackfillArgs(["--lecture=l1", "SUPER-SECRET-VALUE"]);
  } catch (e) {
    assert.ok(!e.message.includes("SUPER-SECRET-VALUE"));
  }

  assert.deepEqual(cli.parseBackfillArgs(["--lecture=l1"]).scope, { kind: "lecture", lectureId: "l1" });
  assert.deepEqual(cli.parseBackfillArgs(["--class=c-1_x"]).scope, { kind: "class", classId: "c-1_x" });
  assert.equal(cli.parseBackfillArgs(["--before=2026-08-15T05:30:00+05:30"]).scope.before.toISOString(), "2026-08-15T00:00:00.000Z");
  assert.deepEqual(
    [cli.parseBackfillArgs(["--lecture=l1"]).execute, cli.parseBackfillArgs(["--lecture=l1", ...EXECUTE]).execute],
    [false, true]
  );
});

test("22. execution needs --execute AND --confirm-backfill-historical-attendance; refused before any database access", async () => {
  reset();
  student("s1");
  visit("s1", at(3));
  const refused = [
    [`--lecture=${L1}`, "--execute", "--confirm-database=slc_testing"],
    [`--lecture=${L1}`, "--execute"],
    // Confirmations without --execute are refused rather than silently ignored.
    [`--lecture=${L1}`, "--confirm-backfill-historical-attendance", "--confirm-database=slc_testing"],
    [`--lecture=${L1}`, "--confirm-backfill-historical-attendance"],
  ];
  for (const argv of refused) {
    const { code, text } = await cliRun(argv);
    assert.equal(code, 2, argv.join(" "));
    assert.match(text, /Usage error/);
  }
  assert.deepEqual(pg.log, [], "nothing read");
  assert.equal(pg.transactions.length, 0);
  assert.deepEqual(pg.committed.records, {});

  assert.throws(() => cli.assertExecutionConfirmed({ execute: true, confirmed: false, database: "slc_testing" }, { name: "slc_testing" }), /confirm-backfill-historical-attendance/);
});

test("23. --confirm-database must name the DATABASE_URL database; then execute writes", async () => {
  reset();
  student("s1");
  visit("s1", at(3));
  for (const argv of [
    [`--lecture=${L1}`, "--execute", "--confirm-backfill-historical-attendance"],
    [`--lecture=${L1}`, "--execute", "--confirm-backfill-historical-attendance", "--confirm-database=slc_production"],
    [`--lecture=${L1}`, "--execute", "--confirm-backfill-historical-attendance", "--confirm-database="],
  ]) {
    const { code, text } = await cliRun(argv);
    assert.equal(code, 2, argv.join(" "));
    assert.ok(!text.includes("not-a-real-password") && !text.includes("backfill_user"));
  }
  for (const databaseUrl of ["", "not a url", "postgresql://h:5432/"]) {
    assert.equal((await cliRun([`--lecture=${L1}`], { databaseUrl })).code, 2, String(databaseUrl));
  }
  assert.equal(pg.transactions.length, 0);
  assert.deepEqual(pg.committed.records, {});

  const { code, text } = await cliRun([`--lecture=${L1}`, ...EXECUTE]);
  assert.equal(code, 0);
  assert.match(text, /EXECUTE/);
  assert.match(text, /created 1/);
  assert.equal(record("s1").statusSource, "BACKFILL");
  for (const secret of ["s1:", "Name of", "visit-", "backfill_user", "not-a-real-password"]) assert.ok(!text.includes(secret), secret);
});

// ---- Scopes, configuration, isolation ---------------------------------------------------------------------

test("class and date scopes: lectures one by one in date order; LIVE / finalized refused per lecture; deleted / cancelled not listed", async () => {
  reset();
  const lecture = (id, date, extra = {}) => {
    pg.committed.lectures[id] = { id, classId: C1, title: id, status: 0, classStatus: "COMPLETED", date, endDate: null, createdAt: at(-1000), ...extra };
    pg.committed.sessions[`session-${id}`] = { id: `session-${id}`, lectureId: id };
  };
  lecture("lecture-0", new Date("2026-08-08T12:30:00Z"));
  lecture("lecture-live", new Date("2026-09-01T12:30:00Z"));
  lecture("lecture-final", new Date("2026-08-09T12:30:00Z"));
  lecture("lecture-gone", new Date("2026-08-07T12:30:00Z"), { status: 1 });
  lecture("lecture-cancel", new Date("2026-08-07T12:30:00Z"), { classStatus: "CANCELLED" });
  pg.committed.registers["lecture-final"] = { lectureId: "lecture-final", classId: C1, scheduledStartAt: new Date("2026-08-09T12:30:00Z"), scheduledEndAt: null,
    graceMinutes: 10, finalizedAt: at(-60), finalizedByTeacherId: T1, version: 2, createdAt: at(-2000), updatedAt: at(-60) };
  student("s1");
  visit("s1", at(3));
  visit("s1", new Date("2026-08-08T12:31:00Z"), "session-lecture-0");
  visit("s1", new Date("2026-09-01T12:31:00Z"), "session-lecture-live");

  assert.deepEqual(await backfill.listBackfillLectures({ kind: "class", classId: C1 }), ["lecture-0", "lecture-final", L1, "lecture-live"]);
  assert.deepEqual(await backfill.listBackfillLectures({ kind: "before", before: new Date("2026-08-10T00:00:00Z") }), ["lecture-0", "lecture-final"]);

  const { code, out } = await cliRun([`--class=${C1}`, ...EXECUTE]);
  assert.equal(code, 0, "per-lecture refusals do not fail a class run");
  assert.deepEqual(out.filter((l) => l.startsWith("  lecture ")).map((l) => l.split(":")[0].trim() + (l.includes("refused") ? " refused" : "")), [
    "lecture lecture-0",
    "lecture lecture-final refused",
    `lecture ${L1}`,
    "lecture lecture-live refused",
  ]);
  assert.ok(out.some((l) => l.includes("refused (ATTENDANCE_LECTURE_LIVE)")));
  assert.ok(out.some((l) => l.includes("refused (ATTENDANCE_REGISTER_FINALIZED)")));
  assert.match(out.at(-1), /^Total: lectures 2, refused 2, created 2, existing 0, busy 0$/);
  assert.equal(record("s1", "lecture-live"), null);
  assert.equal(record("s1", "lecture-final"), null);

  // A single-lecture scope that is refused exits 1.
  assert.equal((await cliRun(["--lecture=lecture-live"])).code, 1);
  // An empty scope.
  assert.equal((await cliRun(["--class=class-none"])).code, 0);
});

test("missing configuration fails closed (503) before any read; the CLI stops with exit 1", async () => {
  reset();
  student("s1");
  visit("s1", at(3));
  const original = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(run("dry-run", { ATTENDANCE_EVIDENCE_STARTED_AT: ENV.ATTENDANCE_EVIDENCE_STARTED_AT }), (e) => e.code === "ATTENDANCE_APPROVAL_NOT_CONFIGURED" && e.statusCode === 503);
    await assert.rejects(run("execute", { APPROVAL_FEATURE_STARTED_AT: ENV.APPROVAL_FEATURE_STARTED_AT }), (e) => e.code === "ATTENDANCE_EVIDENCE_NOT_CONFIGURED");
    const { code, text } = await cliRun([`--lecture=${L1}`], { env: {} });
    assert.equal(code, 1);
    assert.match(text, /failed \(ATTENDANCE_APPROVAL_NOT_CONFIGURED\)/);
  } finally {
    console.warn = original;
  }
  assert.ok(!pg.log.includes("read:visits"));
  assert.equal(pg.transactions.length, 0);
});

test("the service is sanitized and logs nothing; it is reachable only from the operator CLI", async () => {
  reset();
  student("s-secret");
  visit("s-secret", at(3));
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = (...args) => lines.push(args.join(" "));
  let result;
  try {
    result = await run();
  } finally {
    Object.assign(console, saved);
  }
  assert.deepEqual(lines, []);
  assert.deepEqual(Object.keys(result).sort(), ["busy", "created", "createdLateJoin", "existing", "inactive", "ineligible", "lectureId", "mode", "skipped", "stoppedBecause", "students", "unknown"]);
  for (const secret of ["s-secret", "Name of", "visit-"]) assert.ok(!JSON.stringify(result).includes(secret), secret);

  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const importers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(entry.name) && /lecture-attendance-backfill-service|attendance-backfill-cli/.test(code(fs.readFileSync(path.join(root, rel), "utf8")))) {
        importers.push(rel);
      }
    }
  };
  for (const dir of ["app", "components", "lib", "services", "hooks", "scripts"]) if (fs.existsSync(path.join(root, dir))) walk(dir);
  assert.deepEqual(importers.sort(), ["scripts/attendance-backfill-cli.ts", "scripts/attendance-backfill.ts"]);
  for (const file of ["middleware.ts", "instrumentation.ts"]) {
    if (fs.existsSync(path.join(root, file))) assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"), /backfill/i, file);
  }
  const service = code(fs.readFileSync(path.join(root, "services/lecture-attendance-backfill-service.ts"), "utf8"));
  assert.doesNotMatch(service, /console\.|writeFile|\$executeRaw|\$queryRaw/);
  const cliSource = code(fs.readFileSync(path.join(root, "scripts/attendance-backfill-cli.ts"), "utf8"));
  assert.doesNotMatch(cliSource, /process\.|console\.|writeFile|\.env["'`]/, "the CLI logic only uses its injected dependencies");
});
