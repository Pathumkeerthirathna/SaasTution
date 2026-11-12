/*
 * Stage 5.4d: the teacher's manual attendance decisions
 * (services/lecture-attendance-decision-service.ts).
 *
 *   npm run test:attendance-decisions
 *
 * No database: the real services run through tsx against the in-memory
 * PostgreSQL model (tests/attendance/helpers/attendance-pg-model.cjs), which
 * enforces the record and audit CHECK constraints, row locks, unique-key
 * waits, rollback and aborted transactions.
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

const decisions = require(path.join(root, "services", "lecture-attendance-decision-service.ts"));
const qr = require(path.join(root, "services", "lecture-attendance-qr-service.ts"));
const evidence = require(path.join(root, "services", "lecture-attendance-evidence-service.ts"));
const qrToken = require(path.join(root, "lib", "student-qr-token.ts"));

// ---- Clock and fixtures ------------------------------------------------------------------

const START = new Date("2026-09-01T12:30:00.000Z");
const at = (minutes, ms = 0) => new Date(START.getTime() + minutes * 60_000 + ms);
test.mock.timers.enable({ apis: ["Date"], now: at(5) });
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

function student(id, { teacherId = T1, confirmationStatus = "APPROVED", enrolled = true, removed = false, broken = false } = {}) {
  pg.committed.students[id] = {
    id, name: id, registrationNumber: null, teacherId, status: 0, confirmationStatus,
    confirmedAt: confirmationStatus === "PENDING" ? null : broken ? new Date("2026-08-02T00:00:00Z") : APPROVED_AT,
    approvedAt: confirmationStatus === "PENDING" ? null : APPROVED_AT,
  };
  if (confirmationStatus !== "PENDING") {
    pg.committed.history.push({ id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: confirmationStatus, decidedAt: APPROVED_AT, previousConfirmedAt: null });
  }
  if (enrolled) {
    pg.committed.enrolments.push({
      id: `e-${id}`, studentId: id, classId: C1, assignedAt: new Date("2026-08-05T05:30:00Z"),
      removedAt: removed ? new Date("2026-08-20T05:30:00Z") : null, isActive: !removed,
    });
  }
}

function reset() {
  model = createPgModel();
  pg = model.pg;
  currentPrisma = model.prisma;
  pg.committed.classes[C1] = { id: C1, teacherId: T1, status: 0, attendanceGraceMinutes: 10 };
  pg.committed.classes["class-2"] = { id: "class-2", teacherId: T2, status: 0, attendanceGraceMinutes: 10 };
  pg.committed.lectures[L1] = { id: L1, classId: C1, status: 0, classStatus: "LIVE", date: START, endDate: at(120) };
  student("s1");
  student("s2");
  student("s-pending", { confirmationStatus: "PENDING" });
  student("s-unknown", { broken: true }); // history does not match: UNKNOWN eligibility
  student("s-removed", { removed: true });
  student("s-never", { enrolled: false });
  student("s-other", { teacherId: T2, enrolled: false });
  pg.committed.sessions["session-1"] = { id: "session-1", lectureId: L1 };
  setNow(at(5));
}

function token(n, studentId) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const nonce = Buffer.alloc(32, n).toString("base64url");
  const value = qrToken.deriveStudentQrToken(SECRET, id, nonce);
  pg.committed.tokens[id] = { id, studentId, nonce, tokenHash: qrToken.hashStudentQrToken(value), revokedAt: null };
  return qrToken.buildStudentQrPayload(value);
}

let scanSeq = 0;
const scan = (payload) => qr.recordQrScan({ teacherId: T1, lectureId: L1, clientScanId: `decision-scan-${String(++scanSeq).padStart(6, "0")}`, payload }, { env: ENV });

const decide = (studentId, status, expectedVersion, reason, teacherId = T1, lectureId = L1) =>
  decisions.setTeacherAttendanceStatus({ teacherId, lectureId, studentId, status, expectedVersion, reason });

const record = (studentId) => pg.committed.records[`${L1}:${studentId}`] ?? null;
const audits = (studentId) =>
  pg.committed.recordAudits.filter((a) => a.lectureAttendanceId === record(studentId)?.id).sort((a, b) => a.version - b.version);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function finalizedRegister() {
  pg.committed.registers[L1] = {
    lectureId: L1, classId: C1, scheduledStartAt: START, scheduledEndAt: at(120), graceMinutes: 10,
    finalizedAt: at(130), finalizedByTeacherId: T1, version: 2, createdAt: at(-30), updatedAt: at(130),
  };
}

function assertAuditChain(studentId) {
  const rec = record(studentId);
  const rows = audits(studentId);
  rows.forEach((row, i) => {
    assert.equal(row.version, i + 1);
    if (i > 0) {
      assert.equal(row.fromStatus, rows[i - 1].toStatus);
      assert.equal(row.fromTeacherStatus, rows[i - 1].toTeacherStatus);
      assert.equal(row.fromAutoStatus, rows[i - 1].toAutoStatus);
    }
    model.checkAudit(row);
  });
  assert.equal(rows.at(-1).version, rec.version);
  assert.equal(rows.at(-1).toStatus, rec.status);
  model.checkRecord(rec);
}

// ---- First mark and changes -------------------------------------------------------------------

test("first manual mark needs no reason: a TEACHER record (version 1) and a TEACHER_SET audit, atomically", async () => {
  reset();
  const result = await decide("s1", "PRESENT", null);
  assert.deepEqual(result, {
    lectureId: L1, studentId: "s1", status: "PRESENT", statusSource: "TEACHER", teacherStatus: "PRESENT",
    autoStatus: null, pendingReview: false, version: 1, afterFinalization: false, changed: true,
  });

  const rec = record("s1");
  assert.deepEqual(
    [rec.status, rec.statusSource, rec.teacherStatus, rec.teacherDecidedById, rec.teacherDecidedAt.toISOString(), rec.autoStatus, rec.firstQrAt],
    ["PRESENT", "TEACHER", "PRESENT", T1, at(5).toISOString(), null, null]
  );
  const [audit] = audits("s1");
  assert.deepEqual(
    { action: audit.action, version: audit.version, actorRole: audit.actorRole, actorId: audit.actorId, reason: audit.reason, fromStatus: audit.fromStatus, toStatus: audit.toStatus, afterFinalization: audit.afterFinalization },
    { action: "TEACHER_SET", version: 1, actorRole: "TEACHER", actorId: T1, reason: null, fromStatus: null, toStatus: "PRESENT", afterFinalization: false }
  );
  // The register was created by the teacher, in the same transaction.
  assert.deepEqual(pg.committed.registerAudits.map((a) => [a.action, a.actorRole, a.actorId]), [["CREATED", "TEACHER", T1]]);
  assert.equal(pg.transactions.length, 1);
  assertAuditChain("s1");
});

test("changing an existing status needs a reason (trimmed); history is kept", async () => {
  reset();
  await decide("s1", "PRESENT", null);
  setNow(at(50));
  const changed = await decide("s1", "ABSENT", 1, "   Left before the register was taken.   ");
  assert.deepEqual([changed.status, changed.version, changed.changed], ["ABSENT", 2, true]);

  const latest = audits("s1").at(-1);
  assert.deepEqual(
    [latest.reason, latest.fromStatus, latest.toStatus, latest.fromTeacherStatus, latest.toTeacherStatus],
    ["Left before the register was taken.", "PRESENT", "ABSENT", "PRESENT", "ABSENT"]
  );
  assert.equal(record("s1").teacherDecidedAt.toISOString(), at(50).toISOString());
  assertAuditChain("s1");
});

test("missing, blank and over-500-character reasons are refused; nothing changes", async () => {
  reset();
  await decide("s1", "PRESENT", null);
  for (const reason of [undefined, null, "", "    \n\t "]) {
    await assert.rejects(decide("s1", "ABSENT", 1, reason), (e) => e.code === "ATTENDANCE_REASON_REQUIRED" && e.statusCode === 400, JSON.stringify(reason));
  }
  await assert.rejects(decide("s1", "ABSENT", 1, "x".repeat(501)), (e) => e.code === "VALIDATION_ERROR" && e.details.field === "reason");
  await assert.rejects(decide("s1", "ABSENT", 1, 42), (e) => e.code === "VALIDATION_ERROR");
  assert.equal((await decide("s1", "ABSENT", 1, "y".repeat(500))).version, 2, "exactly 500 is allowed");
  assert.equal(audits("s1").length, 2);
});

test("replacing an AUTOMATIC status also needs a reason; the evidence is kept and the review cleared", async () => {
  reset();
  const payload = token(1, "s1");
  setNow(at(20));
  await scan(payload); // AUTO LATE (version 1)
  await assert.rejects(decide("s1", "PRESENT", 1), (e) => e.code === "ATTENDANCE_REASON_REQUIRED");

  const result = await decide("s1", "PRESENT", 1, "Arrived on time; the queue was slow.");
  assert.deepEqual([result.status, result.autoStatus, result.version], ["PRESENT", "LATE", 2]);
  const rec = record("s1");
  assert.equal(rec.firstQrAt.toISOString(), at(20).toISOString(), "evidence is kept");
  assert.equal(rec.autoStatus, "LATE");
  const latest = audits("s1").at(-1);
  assert.deepEqual([latest.fromStatus, latest.toStatus, latest.fromAutoStatus, latest.toAutoStatus], ["LATE", "PRESENT", "LATE", "LATE"]);
  assertAuditChain("s1");
});

test("a decision clears a pending review", async () => {
  reset();
  const payload = token(1, "s1");
  await decide("s1", "ABSENT", null);
  await scan(payload); // stronger evidence: review (version 2)
  assert.notEqual(record("s1").pendingReviewSince, null);
  const result = await decide("s1", "EXCUSED", 2, "Medical note received.");
  assert.equal(result.pendingReview, false);
  assert.equal(record("s1").pendingReviewSince, null);
  assert.equal(record("s1").autoStatus, "PRESENT");
});

test("the same decision again is a no-op (no write, no audit)", async () => {
  reset();
  await decide("s1", "PRESENT", null);
  const before = pg.committed.recordAudits.length;
  const again = await decide("s1", "PRESENT", 1);
  assert.deepEqual([again.changed, again.version], [false, 1]);
  assert.equal(pg.committed.recordAudits.length, before);
  assert.ok(!pg.transactions.at(-1).statements.some((s) => s.startsWith("update:") || s.startsWith("create:")));
});

// ---- Eligibility ---------------------------------------------------------------------------------

test("manual marking works for UNKNOWN and NOT_APPROVED students, and for removed enrolments", async () => {
  reset();
  for (const id of ["s-unknown", "s-pending", "s-removed"]) {
    const result = await decide(id, "PRESENT", null);
    assert.equal(result.changed, true, id);
    assertAuditChain(id);
  }
});

test("manual decisions never read or change approval or enrolment, and never make a student eligible", async () => {
  reset();
  const snapshot = JSON.stringify([pg.committed.students, pg.committed.history, pg.committed.enrolments]);
  await decide("s-pending", "PRESENT", null);
  await decide("s-unknown", "ABSENT", null);
  assert.equal(JSON.stringify([pg.committed.students, pg.committed.history, pg.committed.enrolments]), snapshot);
  for (const tx of pg.transactions) {
    assert.ok(!tx.statements.includes("read:history"), "no approval history");
    // Stage 5.6a: the Student row is locked FOR SHARE (the active / ownership check), never written.
    assert.equal(tx.statements[1], "lock:student");
  }

  // Automatic eligibility is unchanged: their scans are still not eligible, and never touch the decided records.
  const pendingScan = await scan(token(1, "s-pending"));
  const unknownScan = await scan(token(2, "s-unknown"));
  assert.deepEqual([pendingScan.result, unknownScan.result], ["NOT_ELIGIBLE", "ELIGIBILITY_UNKNOWN"]);
  assert.deepEqual([record("s-pending").version, record("s-unknown").version], [1, 1]);
});

// ---- Access and validation -------------------------------------------------------------------------

test("wrong teacher, other teacher's student, never-enrolled student, cancelled or deleted lecture", async () => {
  reset();
  await assert.rejects(decide("s1", "PRESENT", null, undefined, T2), (e) => e.code === "LECTURE_NOT_FOUND" && e.statusCode === 404);
  await assert.rejects(decide("s-other", "PRESENT", null), (e) => e.code === "STUDENT_NOT_FOUND" && e.statusCode === 404);
  await assert.rejects(decide("missing", "PRESENT", null), (e) => e.code === "STUDENT_NOT_FOUND");
  await assert.rejects(decide("s-never", "PRESENT", null), (e) => e.code === "ATTENDANCE_STUDENT_NOT_ENROLLED" && e.statusCode === 409);
  pg.committed.lectures[L1].classStatus = "CANCELLED";
  await assert.rejects(decide("s1", "PRESENT", null), (e) => e.code === "LECTURE_CANCELLED");
  pg.committed.lectures[L1].classStatus = "LIVE";
  pg.committed.lectures[L1].status = 1;
  await assert.rejects(decide("s1", "PRESENT", null), (e) => e.code === "LECTURE_NOT_FOUND");
  assert.deepEqual(pg.committed.records, {});
  assert.deepEqual(pg.committed.registers, {}, "rolled back: no register created");
});

test("invalid status, version and ids are 400 before any transaction", async () => {
  reset();
  for (const [status, version, field] of [["HERE", null, "status"], ["present", null, "status"], [undefined, null, "status"], ["PRESENT", 0, "expectedVersion"], ["PRESENT", 1.5, "expectedVersion"], ["PRESENT", "1", "expectedVersion"]]) {
    await assert.rejects(decide("s1", status, version), (e) => e.code === "VALIDATION_ERROR" && e.details.field === field, `${status} ${version}`);
  }
  await assert.rejects(decide("", "PRESENT", null), (e) => e.code === "VALIDATION_ERROR");
  assert.equal(pg.transactions.length, 0);
});

test("stale or mismatched expected version: 409 ATTENDANCE_RECORD_CHANGED", async () => {
  reset();
  await assert.rejects(decide("s1", "PRESENT", 1), (e) => e.code === "ATTENDANCE_RECORD_CHANGED", "expected a record that does not exist");
  await decide("s1", "PRESENT", null);
  await assert.rejects(decide("s1", "ABSENT", null, "r"), (e) => e.code === "ATTENDANCE_RECORD_CHANGED", "did not see the record");
  await assert.rejects(decide("s1", "ABSENT", 2, "r"), (e) => e.code === "ATTENDANCE_RECORD_CHANGED", "future version");
  await decide("s1", "ABSENT", 1, "r");
  await assert.rejects(decide("s1", "LATE", 1, "r"), (e) => e.code === "ATTENDANCE_RECORD_CHANGED", "stale version");
});

// ---- Concurrency ---------------------------------------------------------------------------------------

test("concurrent first marks: one wins, the other gets 409 ATTENDANCE_RECORD_CHANGED; one record, one audit", async () => {
  reset();
  let release;
  const gate = new Promise((r) => { release = r; });
  pg.beforeStatement = async (label, op) => {
    if (label === "tx1" && op === "create:audit") await gate; // tx1 holds its uncommitted record insert
  };
  const first = decide("s1", "PRESENT", null);
  while (!pg.log.includes("tx1:insert:record:s1")) await tick();
  const second = decide("s1", "ABSENT", null);
  while (!pg.log.some((e) => e.startsWith("tx2:unique-wait:") || e.startsWith("tx2:waits:"))) await tick();
  release();

  assert.equal((await first).status, "PRESENT");
  await assert.rejects(second, (e) => e.code === "ATTENDANCE_RECORD_CHANGED");
  assert.equal(record("s1").status, "PRESENT");
  assert.equal(audits("s1").length, 1);
});

test("concurrent changes of the same version: serialized on the record lock; the second gets 409", async () => {
  reset();
  await decide("s1", "PRESENT", null);
  let release;
  const gate = new Promise((r) => { release = r; });
  pg.beforeStatement = async (label, op) => {
    if (label === "tx2" && op === "create:audit") await gate; // tx2 holds the record FOR NO KEY UPDATE
  };
  const a = decide("s1", "ABSENT", 1, "first");
  while (!pg.log.some((e) => e.startsWith("tx2:update:record:s1"))) await tick();
  const b = decide("s1", "EXCUSED", 1, "second");
  while (!pg.log.some((e) => e.startsWith("tx3:waits:record:"))) await tick();
  release();

  assert.equal((await a).status, "ABSENT");
  await assert.rejects(b, (e) => e.code === "ATTENDANCE_RECORD_CHANGED");
  assert.deepEqual([record("s1").status, record("s1").version], ["ABSENT", 2]);
  assertAuditChain("s1");
});

test("lock order: Student (Stage 5.6a), Lecture, Class, Register, record, then the writes", async () => {
  reset();
  await decide("s1", "PRESENT", null);
  const statements = pg.transactions[0].statements;
  // First occurrence of each step (ensureRegister re-enters the held Lecture / Class locks, which cannot wait).
  const order = ["SET", "lock:student", "lock:lecture", "lock:class", "read:enrolments", "lock:register", "insert:register", "lock:records", "insert:record", "create:audit"];
  const firsts = order.map((step) => statements.indexOf(step));
  assert.ok(firsts.every((index) => index >= 0), JSON.stringify(statements));
  assert.deepEqual([...firsts].sort((a, b) => a - b), firsts, JSON.stringify(statements));
  assert.ok(!statements.includes("read:student") && !statements.includes("read:history"), "the student is read only through its lock");
  assert.deepEqual(pg.transactions[0].options, { maxWait: 5000, timeout: 15000 });
});

// ---- After finalization -------------------------------------------------------------------------------

test("after finalization: every decision needs a reason; the frozen register is untouched", async () => {
  reset();
  finalizedRegister();
  const frozen = { ...pg.committed.registers[L1] };
  setNow(at(200));

  await assert.rejects(decide("s1", "PRESENT", null), (e) => e.code === "ATTENDANCE_REASON_REQUIRED", "even a first mark (database rule)");
  const first = await decide("s1", "PRESENT", null, "Marked late from the paper register.");
  assert.equal(first.afterFinalization, true);
  await assert.rejects(decide("s1", "ABSENT", 1), (e) => e.code === "ATTENDANCE_REASON_REQUIRED");
  const second = await decide("s1", "ABSENT", 1, "Correction.");
  assert.equal(second.version, 2);

  assert.deepEqual(pg.committed.registers[L1], frozen);
  assert.deepEqual(pg.committed.registerAudits, []);
  assert.ok(audits("s1").every((a) => a.afterFinalization === true));
  assertAuditChain("s1");
});

test("after finalization: a FINALIZATION ABSENT record can be corrected with a reason", async () => {
  reset();
  finalizedRegister();
  pg.committed.records[`${L1}:s1`] = {
    id: "rec-s1", lectureId: L1, classId: C1, studentId: "s1", status: "ABSENT", statusSource: "FINALIZATION",
    firstOnlineAt: null, firstQrAt: null, autoStatus: null, teacherStatus: null, teacherDecidedAt: null, teacherDecidedById: null,
    pendingReviewSince: null, version: 1, createdAt: at(130), updatedAt: at(130),
  };
  pg.committed.recordAudits.push({
    id: "seed", lectureAttendanceId: "rec-s1", version: 1, lectureId: L1, studentId: "s1", action: "FINALIZE_ABSENT",
    fromStatus: null, toStatus: "ABSENT", fromTeacherStatus: null, toTeacherStatus: null, fromAutoStatus: null, toAutoStatus: null,
    actorRole: "SYSTEM", actorId: null, reason: null, afterFinalization: false, createdAt: at(130),
  });
  const result = await decide("s1", "EXCUSED", 1, "Doctor's note.");
  assert.deepEqual([result.status, result.version], ["EXCUSED", 2]);
  assertAuditChain("s1");
});

// ---- Atomicity ---------------------------------------------------------------------------------------------

test("audit failure rolls the decision back (new record and existing record)", async () => {
  reset();
  pg.failOn = (label, op) => (op === "create:audit" ? Object.assign(new Error("simulated audit failure"), { name: "PrismaClientKnownRequestError", code: "P2010", __db: true }) : null);
  await assert.rejects(decide("s1", "PRESENT", null), /simulated audit failure/);
  assert.equal(record("s1"), null);
  assert.deepEqual(pg.committed.registers, {}, "the register created in the same transaction rolled back too");
  assert.deepEqual(pg.committed.registerAudits, []);
  assert.equal(pg.transactions.at(-1).statements.at(-1), "create:audit", "nothing sent after the failure");

  pg.failOn = null;
  await decide("s1", "PRESENT", null);
  pg.failOn = (label, op) => (op === "create:audit" ? Object.assign(new Error("simulated audit failure"), { name: "PrismaClientKnownRequestError", code: "P2010", __db: true }) : null);
  await assert.rejects(decide("s1", "ABSENT", 1, "r"), /simulated audit failure/);
  assert.deepEqual([record("s1").status, record("s1").version], ["PRESENT", 1]);
  assert.equal(audits("s1").length, 1);
});

test("lock timeout: 409 ATTENDANCE_BUSY after the rollback", async () => {
  reset();
  await decide("s1", "PRESENT", null);
  pg.held.push({ row: `record:${L1}:s1`, owner: "evidence", mode: "NO_KEY_UPDATE" });
  pg.failWhenBlocked = true;
  await assert.rejects(decide("s1", "ABSENT", 1, "r"), (e) => e.code === "ATTENDANCE_BUSY" && e.statusCode === 409);
  assert.equal(record("s1").version, 1);
});

// ---- Later conflicting evidence ------------------------------------------------------------------------------

test("later conflicting QR and online evidence never overrides the decision; stronger evidence raises a review", async () => {
  reset();
  await decide("s1", "ABSENT", null);
  setNow(at(8));
  const scanned = await scan(token(1, "s1"));
  assert.deepEqual([scanned.result, scanned.effect], ["VALID", "REVIEW_REQUIRED"]);
  pg.committed.visits.v1 = { id: "v1", studentId: "s1", joinedAt: at(2), classSessionId: "session-1" };
  setNow(at(9));
  assert.deepEqual(await evidence.recordOnlineEvidence("v1", { env: ENV }), { status: "APPLIED", effect: "REVIEW_REQUIRED" });
  const rec = record("s1");
  assert.deepEqual([rec.status, rec.statusSource, rec.teacherStatus], ["ABSENT", "TEACHER", "ABSENT"]);
  assert.notEqual(rec.pendingReviewSince, null);
  assertAuditChain("s1");

  // Weaker evidence against a PRESENT decision: recorded, no review.
  await decide("s2", "PRESENT", null);
  setNow(at(40));
  const late = await scan(token(2, "s2"));
  assert.equal(late.effect, "EVIDENCE_ONLY");
  assert.deepEqual([record("s2").status, record("s2").pendingReviewSince], ["PRESENT", null]);
});
