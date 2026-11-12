/*
 * Stage 5.4b: attendance evidence processing (QR scans, online evidence after
 * the visit's own transaction, review accept / dismiss), the write-phase
 * guard (C2), lecture revalidation under the lock (W3) and database errors
 * inside transactions (W4).
 *
 *   npm run test:attendance-evidence
 *
 * No database: the real services run through tsx against an in-memory model
 * of PostgreSQL (tests/attendance/helpers/attendance-pg-model.cjs) that
 * enforces the attendance CHECK constraints, row locks, unique-key waits,
 * READ COMMITTED visibility, rollback, and ABORTED transactions after a
 * database error. Settings and the QR secret are test values.
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

// ---- lib/prisma.ts double ---------------------------------------------------------------

let currentPrisma = null;
const prismaProxy = new Proxy({}, { get: (_, key) => currentPrisma[key] });
const fakeModule = (relativePath, exports) => {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
};
fakeModule("lib/prisma.ts", { prisma: prismaProxy });

const lockLib = require(path.join(root, "lib", "attendance", "locks.ts"));
const service = require(path.join(root, "services", "lecture-attendance-service.ts"));
const evidence = require(path.join(root, "services", "lecture-attendance-evidence-service.ts"));
const qr = require(path.join(root, "services", "lecture-attendance-qr-service.ts"));
const dispatcher = require(path.join(root, "services", "attendance-evidence-dispatcher.ts"));
const qrToken = require(path.join(root, "lib", "student-qr-token.ts"));
const config = require(path.join(root, "lib", "attendance", "config.ts"));

// ---- Clock ------------------------------------------------------------------------------

const START = new Date("2026-09-01T12:30:00.000Z"); // the lecture's scheduled start
const minutes = (m) => new Date(START.getTime() + m * 60_000);
test.mock.timers.enable({ apis: ["Date"], now: minutes(5) });
const setNow = (date) => test.mock.timers.setTime(date.getTime());

// ---- Fixtures ---------------------------------------------------------------------------

const T1 = "teacher-1";
const T2 = "teacher-2";
const C1 = "class-1";
const C2 = "class-2";
const L1 = "lecture-1"; // live (after the evidence start)
const L0 = "lecture-0"; // historical (before it)
const APPROVED_AT = new Date("2026-08-01T00:00:00.000Z");
const SL = (5 * 60 + 30) * 60_000;
const digits = (date) => new Date(date.getTime() + SL);

const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
const ENV = {
  APPROVAL_FEATURE_STARTED_AT: "2026-07-28T00:00:00Z",
  ATTENDANCE_EVIDENCE_STARTED_AT: "2026-08-15T00:00:00Z",
  STUDENT_QR_SECRET: SECRET.toString("base64"),
};

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const nonceOf = (n) => Buffer.alloc(32, n).toString("base64url");

let model;
let pg;

function addStudent(id, { teacherId = T1, status = 0, confirmationStatus = "APPROVED", approvedAt = APPROVED_AT, enrolledAt = new Date("2026-08-05T00:00:00Z"), removedAt = null, classId = C1 } = {}) {
  pg.committed.students[id] = {
    id, name: `Student ${id}`, registrationNumber: `R-${id}`, teacherId, status, confirmationStatus,
    confirmedAt: confirmationStatus === "PENDING" ? null : approvedAt, approvedAt: confirmationStatus === "PENDING" ? null : approvedAt,
  };
  if (confirmationStatus !== "PENDING") {
    pg.committed.history.push({ id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: confirmationStatus, decidedAt: approvedAt, previousConfirmedAt: null });
  }
  if (enrolledAt) {
    pg.committed.enrolments.push({
      id: `e-${id}`, studentId: id, classId, assignedAt: digits(enrolledAt), removedAt: removedAt ? digits(removedAt) : null, isActive: removedAt === null,
    });
  }
}

/** A QR token row for the student; returns the scanned payload. */
function addToken(n, studentId, { revokedAt = null, secret = SECRET } = {}) {
  const id = uuid(n);
  const nonce = nonceOf(n);
  const token = qrToken.deriveStudentQrToken(secret, id, nonce);
  // Stored as issued: the hash of the token derived with the secret of that
  // time (an older secret makes it unverifiable under the current one).
  const tokenHash = qrToken.hashStudentQrToken(token);
  pg.committed.tokens[id] = { id, studentId, nonce, tokenHash, revokedAt };
  return { id, payload: qrToken.buildStudentQrPayload(token), hash: qrToken.hashStudentQrToken(token) };
}

function reset() {
  model = createPgModel();
  pg = model.pg;
  currentPrisma = model.prisma;
  pg.committed.classes[C1] = { id: C1, teacherId: T1, status: 0, attendanceGraceMinutes: 10 };
  pg.committed.classes[C2] = { id: C2, teacherId: T2, status: 0, attendanceGraceMinutes: 10 };
  pg.committed.lectures[L1] = { id: L1, classId: C1, status: 0, classStatus: "LIVE", date: START, endDate: minutes(120) };
  pg.committed.lectures[L0] = { id: L0, classId: C1, status: 0, classStatus: "COMPLETED", date: new Date("2026-08-01T12:30:00Z"), endDate: null };
  addStudent("s1");
  addStudent("s2");
  addStudent("s-pending", { confirmationStatus: "PENDING" });
  addStudent("s-other", { teacherId: T2, classId: C2 });
  pg.committed.sessions["session-1"] = { id: "session-1", lectureId: L1 };
  pg.committed.sessions["session-0"] = { id: "session-0", lectureId: L0 };
  pg.committed.sessions["session-free"] = { id: "session-free", lectureId: null };
  dispatcher.onlineEvidenceDispatcherForTesting.reset();
  config.resetConfigurationWarnings();
  setNow(minutes(5));
}

let scanSeq = 0;
const scanId = () => `scan-id-${String(++scanSeq).padStart(10, "0")}`;
const scan = (payload, extra = {}) =>
  qr.recordQrScan({ teacherId: T1, lectureId: L1, clientScanId: extra.clientScanId ?? scanId(), payload, ...extra }, { env: extra.env ?? ENV });

const recordOf = (studentId, lectureId = L1) => pg.committed.records[`${lectureId}:${studentId}`] ?? null;
const auditsOf = (recordId) => pg.committed.recordAudits.filter((a) => a.lectureAttendanceId === recordId).sort((a, b) => a.version - b.version);

function teacherRecord(studentId, status, extra = {}) {
  // A committed register and a teacher-decided record (as a later teacher action would leave them).
  pg.committed.registers[L1] ??= {
    lectureId: L1, classId: C1, scheduledStartAt: START, scheduledEndAt: minutes(120), graceMinutes: 10,
    finalizedAt: null, finalizedByTeacherId: null, version: 1, createdAt: START, updatedAt: START,
  };
  const row = {
    id: `rec-${studentId}`, lectureId: L1, classId: C1, studentId, status, statusSource: "TEACHER",
    firstOnlineAt: null, firstQrAt: null, autoStatus: null, teacherStatus: status, teacherDecidedAt: minutes(1),
    teacherDecidedById: T1, pendingReviewSince: null, version: 1, createdAt: minutes(1), updatedAt: minutes(1), ...extra,
  };
  model.checkRecord(row);
  pg.committed.records[`${L1}:${studentId}`] = row;
  // Its version-1 audit, as the teacher's first mark would have written it.
  const audit = {
    id: `audit-seed-${studentId}`, lectureAttendanceId: row.id, version: 1, lectureId: L1, studentId, action: "TEACHER_SET",
    fromStatus: null, toStatus: status, fromTeacherStatus: null, toTeacherStatus: status, fromAutoStatus: null, toAutoStatus: null,
    actorRole: "TEACHER", actorId: T1, reason: null, afterFinalization: false, scanEventId: null, attendanceVisitId: null,
    registerAuditId: null, createdAt: minutes(1),
  };
  model.checkAudit(audit);
  pg.committed.recordAudits.push(audit);
  return row;
}

/** Audit chain integrity: versions 1..n, each change's "from" is the previous "to", the last matches the record. */
function assertAuditChain(record) {
  const audits = auditsOf(record.id);
  assert.ok(audits.length > 0, "audits exist");
  audits.forEach((audit, i) => {
    assert.equal(audit.version, i + 1, "gap-free versions");
    assert.equal(audit.lectureId, record.lectureId);
    assert.equal(audit.studentId, record.studentId);
    if (i > 0) {
      assert.equal(audit.fromStatus, audits[i - 1].toStatus);
      assert.equal(audit.fromAutoStatus, audits[i - 1].toAutoStatus);
      assert.equal(audit.fromTeacherStatus, audits[i - 1].toTeacherStatus);
    }
  });
  const last = audits.at(-1);
  assert.equal(last.version, record.version);
  assert.equal(last.toStatus, record.status);
  assert.equal(last.toAutoStatus, record.autoStatus);
}

// =========================================================================================
// C2: write-phase enforcement
// =========================================================================================

function guardedLocks() {
  const calls = [];
  const delegate = (name) =>
    new Proxy({}, { get: (_, method) => async (...args) => { calls.push(`${name}.${String(method)}`); return { ok: true, args }; } });
  const tx = { $queryRaw: async () => [], $executeRawUnsafe: async () => 0, lectureAttendance: delegate("lectureAttendance"), attendanceAuditLog: delegate("attendanceAuditLog") };
  return { locks: lockLib.createAttendanceLocksForTesting(tx), calls };
}

test("C2: model writes before beginWrites() are refused; after it they go through; reads are always allowed", async () => {
  const { locks, calls } = guardedLocks();

  for (const method of ["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"]) {
    assert.throws(() => locks.db.lectureAttendance[method]({}), (error) => {
      assert.equal(error.name, "AttendanceLockOrderError");
      assert.match(error.message, /before beginWrites/);
      return true;
    }, method);
  }
  assert.deepEqual(calls, [], "nothing reached the transaction");

  await locks.db.lectureAttendance.findMany({});
  await locks.db.lectureAttendance.findUnique({});
  await locks.db.lectureAttendance.count({});

  locks.beginWrites();
  await locks.db.lectureAttendance.update({});
  await locks.db.attendanceAuditLog.create({});
  assert.deepEqual(calls, ["lectureAttendance.findMany", "lectureAttendance.findUnique", "lectureAttendance.count", "lectureAttendance.update", "attendanceAuditLog.create"]);
});

test("C2: raw SQL, unknown members and the raw transaction are never reachable by callers", async () => {
  const { locks } = guardedLocks();
  for (const member of ["$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe", "$transaction"]) {
    assert.throws(() => locks.db[member], /not available through locks.db/, member);
  }
  assert.throws(() => locks.db.notAModel, /is not a model/);
  assert.throws(() => locks.db.lectureAttendance.$runCommandRaw, /not available|not allowed/);
  assert.equal(locks.db.then, undefined, "not a thenable");
  assert.equal(locks.tx, undefined, "no public transaction");
  const db = locks.db;
  for (const value of Object.values(locks)) {
    if (value === db || !value || typeof value !== "object") continue; // the guarded db itself refuses $queryRaw (above)
    assert.notEqual(typeof value.$queryRaw, "function", "no own property holds the transaction");
  }

  locks.beginWrites();
  assert.throws(() => locks.db.$executeRaw, /not available/); // still refused in the write phase
  await assert.rejects(lockLib.lockLectureShared(locks, "L"), /after writes began/);
});

test("C2: no source outside lib/attendance/locks.ts can reach raw SQL inside an attendance transaction", () => {
  const files = [
    "services/lecture-attendance-service.ts",
    "services/lecture-attendance-evidence-service.ts",
    "services/lecture-attendance-qr-service.ts",
    "services/attendance-evidence-dispatcher.ts",
  ];
  for (const file of files) {
    // Code only (comments explain the lock modes in words).
    const code = fs.readFileSync(path.join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(code, /\$queryRaw|\$executeRaw|locks\.tx\b|\bFOR (NO KEY UPDATE|KEY SHARE|SHARE|UPDATE)\b/, file);
  }
});

test("C2: ensureRegister's register creation (with its CREATED audit) still works inside the lock phase", async () => {
  reset();
  const result = await lockLib.runAttendanceTransaction(async (locks) => {
    const ensured = await service.ensureRegister(locks, L1, { mode: "KEY_SHARE", now: minutes(5), actor: { role: "SYSTEM" } });
    // Still in the lock phase: records can be locked after the creation unit.
    await lockLib.lockRecords(locks, L1, ["s1"]);
    return { created: ensured.created, writing: locks.writing, trail: [...locks.trail] };
  });
  assert.equal(result.created, true);
  assert.equal(result.writing, false);
  assert.deepEqual(result.trail, ["LECTURE:SHARE:lecture-1", "CLASS:KEY_SHARE:class-1", "REGISTER:UPDATE:lecture-1", "REGISTER:KEY_SHARE:lecture-1"]);
  assert.equal(pg.committed.registerAudits.length, 1);
  assert.equal(pg.committed.registerAudits[0].action, "CREATED");
});

test("C2: the same student's record may be requested again (not held: after a miss), a smaller id may not", async () => {
  const { locks } = guardedLocks();
  await lockLib.lockRecords(locks, "L", ["s2"]); // finds nothing (no rows)
  await lockLib.lockRecords(locks, "L", ["s2"]); // allowed
  await assert.rejects(lockLib.lockRecords(locks, "L", ["s1"]), /out of studentId order/);
});

// =========================================================================================
// W3: lecture revalidation under the lock
// =========================================================================================

test("W3: ensureRegister's fast path re-checks the lecture under its lock (deleted, cancelled, other teacher)", async () => {
  reset();
  await lockLib.runAttendanceTransaction((locks) => service.ensureRegister(locks, L1, { mode: "KEY_SHARE", now: minutes(5), actor: { role: "SYSTEM" } }));
  assert.ok(pg.committed.registers[L1], "register exists: the next calls take the fast path");

  const ensure = (teacherId) =>
    lockLib.runAttendanceTransaction((locks) => service.ensureRegister(locks, L1, { mode: "KEY_SHARE", now: minutes(5), actor: { role: "SYSTEM" }, teacherId }));

  await assert.rejects(ensure(T2), (e) => e.code === "LECTURE_NOT_FOUND");
  pg.committed.lectures[L1].classStatus = "CANCELLED";
  await assert.rejects(ensure(T1), (e) => e.code === "LECTURE_CANCELLED" && e.statusCode === 409);
  pg.committed.lectures[L1].classStatus = "LIVE";
  pg.committed.lectures[L1].status = 1;
  await assert.rejects(ensure(T1), (e) => e.code === "LECTURE_NOT_FOUND" && e.statusCode === 404);
});

test("W3: a lecture cancelled between the ownership read and the locked scan records LECTURE_UNAVAILABLE, no attendance", async () => {
  reset();
  const { payload } = addToken(1, "s1");
  pg.afterOwnershipRead = async () => {
    pg.committed.lectures[L1].classStatus = "CANCELLED"; // after the unlocked read
  };
  const outcome = await scan(payload);
  assert.equal(outcome.result, "LECTURE_UNAVAILABLE");
  assert.equal(outcome.effect, "NONE");
  assert.equal(recordOf("s1"), null);
  assert.equal(pg.committed.registers[L1], undefined);
  assert.equal(pg.committed.scans.length, 1);
});

test("W3: a lecture deleted between reads: QR records LECTURE_UNAVAILABLE; online evidence and review skip / refuse", async () => {
  reset();
  const { payload } = addToken(1, "s1");
  pg.afterOwnershipRead = async () => {
    pg.committed.lectures[L1].status = 1;
  };
  assert.equal((await scan(payload)).result, "LECTURE_UNAVAILABLE");

  pg.committed.visits.v1 = { id: "v1", studentId: "s1", joinedAt: minutes(1), classSessionId: "session-1" };
  assert.deepEqual(await evidence.recordOnlineEvidence("v1", { env: ENV }), { status: "SKIPPED", reason: "LECTURE_UNAVAILABLE" });

  await assert.rejects(evidence.dismissEvidence({ teacherId: T1, lectureId: L1, studentId: "s1", expectedVersion: 1 }), (e) => e.code === "LECTURE_NOT_FOUND");
});

test("W3: a cancel holding the lecture lock makes evidence wait; the evidence then sees the cancellation", async () => {
  reset();
  pg.committed.visits.v1 = { id: "v1", studentId: "s1", joinedAt: minutes(1), classSessionId: "session-1" };
  pg.held.push({ row: `lecture:${L1}`, owner: "cancel", mode: "NO_KEY_UPDATE" });

  const pending = evidence.recordOnlineEvidence("v1", { env: ENV });
  while (!pg.log.some((entry) => entry.includes(`waits:lecture:${L1}`))) await new Promise((r) => setImmediate(r));
  pg.committed.lectures[L1].classStatus = "CANCELLED"; // the cancel commits
  model.locks.release("cancel");

  assert.deepEqual(await pending, { status: "SKIPPED", reason: "LECTURE_UNAVAILABLE" });
  assert.equal(recordOf("s1"), null);
});

// =========================================================================================
// W4: database errors inside transactions
// =========================================================================================

test("W4: a database error mid-transaction propagates, rolls everything back, and nothing more is sent", async () => {
  reset();
  const { payload } = addToken(1, "s1");
  pg.failOn = (label, op) => (op === "create:scan" ? Object.assign(new Error("simulated scan insert failure"), { name: "PrismaClientKnownRequestError", code: "P2010", __db: true }) : null);

  await assert.rejects(scan(payload), /simulated scan insert failure/);
  const tx = pg.transactions.at(-1);
  assert.equal(tx.outcome, "rollback");
  assert.equal(tx.statements.at(-1), "create:scan", "no statement was sent after the failure");
  assert.equal(recordOf("s1"), null, "the record insert was rolled back");
  assert.deepEqual(pg.committed.registers, {});
  assert.deepEqual(pg.committed.registerAudits, []);
  assert.deepEqual(pg.committed.recordAudits, []);
  assert.deepEqual(pg.committed.scans, []);
  assert.deepEqual(pg.held, [], "all locks released");
});

test("W4: a lock timeout becomes 409 ATTENDANCE_BUSY only after the rollback; nothing is committed", async () => {
  reset();
  const { payload } = addToken(1, "s1");
  pg.held.push({ row: `student:s1`, owner: "decision", mode: "NO_KEY_UPDATE" }); // a student decision in progress
  pg.failWhenBlocked = true;

  await assert.rejects(scan(payload), (e) => e.code === "ATTENDANCE_BUSY" && e.statusCode === 409);
  assert.equal(pg.transactions.at(-1).outcome, "rollback");
  assert.deepEqual(pg.committed.scans, []);
});

test("W4: transaction bodies contain no try / catch", () => {
  // [file, minimum number of transaction bodies it must contain] (so a regex that
  // silently matches nothing, e.g. on CRLF files, fails instead of passing).
  for (const [file, minimum] of [
    ["services/lecture-attendance-evidence-service.ts", 2],
    ["services/lecture-attendance-qr-service.ts", 2],
    ["services/lecture-attendance-service.ts", 1],
    ["services/lecture-attendance-decision-service.ts", 1],
    ["services/lecture-service.ts", 2],
    ["services/lecture-attendance-reconcile-service.ts", 1],
    ["services/lecture-attendance-backfill-service.ts", 1],
  ]) {
    const source = fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
    const bodies = [...source.matchAll(/(async function \w*InTransaction\([\s\S]*?\n\}\n)/g)].map((m) => m[1]);
    const ensure = source.match(/export async function ensureRegister\([\s\S]*?\n\}\n/);
    if (ensure) bodies.push(ensure[0]);
    assert.ok(bodies.length >= minimum, `${file}: ${bodies.length} transaction bodies found`);
    for (const body of bodies) assert.doesNotMatch(body, /\btry\s*\{|\bcatch\b/, file);
  }
  const qrSource = fs.readFileSync(path.join(root, "services/lecture-attendance-qr-service.ts"), "utf8");
  assert.ok(qrSource.includes("recordScanInTransaction"));
});

// =========================================================================================
// QR scans
// =========================================================================================

test("QR: a valid scan within grace creates a PRESENT AUTO record, a linked VALID scan and a CREATED_AUTO audit", async () => {
  reset();
  const { payload, hash } = addToken(1, "s1");
  setNow(minutes(10)); // exactly start + grace

  const outcome = await scan(payload);
  assert.equal(outcome.result, "VALID");
  assert.equal(outcome.effect, "STATUS_UPDATED");
  assert.equal(outcome.replayed, false);
  assert.deepEqual(outcome.student, { id: "s1", name: "Student s1", registrationNumber: "R-s1" });
  assert.deepEqual(outcome.attendance, { status: "PRESENT", statusSource: "AUTO", pendingReview: false, version: 1 });

  const record = recordOf("s1");
  assert.equal(record.firstQrAt.getTime(), minutes(10).getTime());
  assert.equal(record.firstOnlineAt, null);
  assert.equal(record.autoStatus, "PRESENT");

  const [event] = pg.committed.scans;
  assert.deepEqual(
    { result: event.result, effect: event.effect, studentId: event.studentId, qrTokenId: event.qrTokenId, scannedTokenHash: event.scannedTokenHash,
      eligibilityReason: event.eligibilityReason, lectureAttendanceId: event.lectureAttendanceId, clientScannedAt: event.clientScannedAt,
      classSessionId: event.classSessionId, afterFinalization: event.afterFinalization },
    { result: "VALID", effect: "STATUS_UPDATED", studentId: "s1", qrTokenId: uuid(1), scannedTokenHash: hash,
      eligibilityReason: "KNOWN_APPROVED", lectureAttendanceId: record.id, clientScannedAt: null, classSessionId: null, afterFinalization: false }
  );
  assert.equal(event.receivedAt.getTime(), minutes(10).getTime());

  const [audit] = auditsOf(record.id);
  assert.deepEqual(
    { action: audit.action, version: audit.version, actorRole: audit.actorRole, actorId: audit.actorId, scanEventId: audit.scanEventId, fromStatus: audit.fromStatus, toStatus: audit.toStatus },
    { action: "CREATED_AUTO", version: 1, actorRole: "SYSTEM", actorId: null, scanEventId: event.id, fromStatus: null, toStatus: "PRESENT" }
  );
  assertAuditChain(record);
  assert.equal(pg.committed.registerAudits.filter((a) => a.action === "CREATED").length, 1);

  // Lock order of the whole scan transaction.
  const order = pg.log.filter((e) => /^tx\d+:(waits|insert|scan|audit)/.test(e));
  assert.ok(order.indexOf(`tx1:insert:register:${L1}`) < order.indexOf("tx1:insert:record:s1"));
  assert.ok(order.indexOf("tx1:insert:record:s1") < order.indexOf("tx1:scan:VALID:STATUS_UPDATED"));
  assert.ok(order.indexOf("tx1:scan:VALID:STATUS_UPDATED") < order.indexOf("tx1:audit:CREATED_AUTO:v1"));
});

test("QR: one millisecond after start + grace is LATE", async () => {
  reset();
  const { payload } = addToken(1, "s1");
  setNow(new Date(minutes(10).getTime() + 1));
  assert.equal((await scan(payload)).attendance.status, "LATE");
});

test("QR: a second scan of the same student (new scan id) is a DUPLICATE event: no audit, no record change", async () => {
  reset();
  const { payload } = addToken(1, "s1");
  await scan(payload);
  setNow(minutes(30));
  const second = await scan(payload);

  assert.equal(second.result, "VALID");
  assert.equal(second.effect, "DUPLICATE");
  const record = recordOf("s1");
  assert.equal(record.version, 1);
  assert.equal(record.firstQrAt.getTime(), minutes(5).getTime());
  assert.equal(pg.committed.scans.length, 2);
  assert.equal(pg.committed.scans[1].lectureAttendanceId, record.id);
  assert.equal(auditsOf(record.id).length, 1);
  assert.equal(Object.keys(pg.committed.records).length, 1, "never a second record");
});

test("QR: retrying the same clientScanId returns the stored outcome and writes nothing", async () => {
  reset();
  const { payload } = addToken(1, "s1");
  const id = scanId();
  const first = await scan(payload, { clientScanId: id });
  setNow(minutes(50));
  const again = await scan(payload, { clientScanId: id });

  assert.equal(again.replayed, true);
  assert.equal(again.scanEventId, first.scanEventId);
  assert.equal(again.result, first.result);
  assert.equal(again.effect, first.effect);
  assert.equal(pg.committed.scans.length, 1);
  assert.equal(pg.transactions.length, 1, "no second transaction");
});

test("QR: a reused clientScanId with a different token or lecture is 409 ATTENDANCE_SCAN_ID_REUSED", async () => {
  reset();
  const a = addToken(1, "s1");
  const b = addToken(2, "s2");
  const id = scanId();
  await scan(a.payload, { clientScanId: id });

  await assert.rejects(scan(b.payload, { clientScanId: id }), (e) => e.code === "ATTENDANCE_SCAN_ID_REUSED" && e.statusCode === 409);
  pg.committed.lectures["lecture-2"] = { id: "lecture-2", classId: C1, status: 0, classStatus: "LIVE", date: START, endDate: null };
  await assert.rejects(scan(a.payload, { clientScanId: id, lectureId: "lecture-2" }), (e) => e.code === "ATTENDANCE_SCAN_ID_REUSED");
  await assert.rejects(scan("not a qr", { clientScanId: id }), (e) => e.code === "ATTENDANCE_SCAN_ID_REUSED");
  assert.equal(pg.committed.scans.length, 1);
});

test("QR: two identical submissions racing produce one scan event; the loser returns the stored outcome", async () => {
  reset();
  const { payload } = addToken(1, "s1");
  const id = scanId();
  let release;
  const gate = new Promise((r) => { release = r; });
  pg.beforeStatement = async (label, op) => {
    if (label === "tx1" && op === "create:audit") await gate; // tx1 holds its scan insert, uncommitted
  };

  const first = scan(payload, { clientScanId: id });
  while (!pg.log.includes("tx1:scan:VALID:STATUS_UPDATED")) await new Promise((r) => setImmediate(r));
  const second = scan(payload, { clientScanId: id });
  while (!pg.log.some((e) => e.startsWith("tx2:waits:") || e.startsWith("tx2:unique-wait:"))) await new Promise((r) => setImmediate(r));
  release();

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, true);
  assert.equal(b.scanEventId, a.scanEventId);
  assert.equal(pg.committed.scans.length, 1);
  assert.equal(pg.transactions.find((t) => t.label === "tx2").outcome, "rollback");
  assertAuditChain(recordOf("s1"));
});

test("QR: eligibility at the exact server-recorded scan time (approval and enrolment)", async () => {
  reset();
  addStudent("s-removed", { removedAt: minutes(3) });
  addStudent("s-late-join", { enrolledAt: minutes(6) });
  const removed = addToken(3, "s-removed");
  const lateJoin = addToken(4, "s-late-join");
  const pending = addToken(5, "s-pending");

  setNow(minutes(4));
  const r1 = await scan(removed.payload);
  assert.deepEqual([r1.result, r1.effect], ["NOT_ELIGIBLE", "NONE"]);
  assert.equal(pg.committed.scans.at(-1).eligibilityReason, "KNOWN_APPROVED"); // approved, but not enrolled at the scan time

  const r2 = await scan(lateJoin.payload); // 4 minutes: not enrolled yet
  assert.equal(r2.result, "NOT_ELIGIBLE");
  setNow(minutes(6));
  const r3 = await scan(lateJoin.payload); // enrolled from 6 minutes exactly
  assert.equal(r3.result, "VALID");

  const r4 = await scan(pending.payload);
  assert.equal(r4.result, "NOT_ELIGIBLE");
  assert.equal(pg.committed.scans.at(-1).eligibilityReason, "KNOWN_NOT_APPROVED");

  assert.equal(recordOf("s-removed"), null);
  assert.equal(recordOf("s-pending"), null);
  assert.ok(recordOf("s-late-join"));
});

test("QR: UNKNOWN eligibility is recorded as ELIGIBILITY_UNKNOWN and never creates attendance", async () => {
  reset();
  addStudent("s-broken");
  pg.committed.students["s-broken"].confirmedAt = new Date("2026-08-02T00:00:00Z"); // history mismatch: BROKEN_HISTORY
  const { payload } = addToken(6, "s-broken");
  const outcome = await scan(payload);
  assert.equal(outcome.result, "ELIGIBILITY_UNKNOWN");
  assert.equal(outcome.effect, "NONE");
  assert.equal(pg.committed.scans[0].eligibilityReason, "BROKEN_HISTORY");
  assert.equal(recordOf("s-broken"), null);
  assert.deepEqual(pg.committed.records, {}, "no attendance");
  // The register exists (every accepted scan holds it: the QR-closure serialization point), but nothing is in it.
  assert.ok(pg.committed.registers[L1]);
  assert.deepEqual(pg.committed.recordAudits, []);
});

test("QR: token problems are recorded with only this teacher's identity data", async () => {
  reset();
  const other = addToken(10, "s-other"); // another teacher's student
  const revoked = addToken(11, "s1", { revokedAt: minutes(-60) });
  const unverifiable = addToken(12, "s2", { secret: Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + 5) % 256)) });
  const unknownToken = qrToken.buildStudentQrPayload(qrToken.deriveStudentQrToken(SECRET, uuid(99), nonceOf(99)));

  const results = [];
  for (const payload of [other.payload, revoked.payload, unverifiable.payload, unknownToken, "garbage"]) results.push((await scan(payload)).result);
  assert.deepEqual(results, ["WRONG_TEACHER", "INVALID_QR", "QR_UNVERIFIABLE", "INVALID_QR", "INVALID_QR"]);

  const [wrong, rev, unver, unknown, malformed] = pg.committed.scans;
  assert.deepEqual([wrong.studentId, wrong.qrTokenId, wrong.scannedTokenHash], [null, null, null]);
  assert.deepEqual([rev.studentId, rev.qrTokenId, rev.scannedTokenHash], ["s1", uuid(11), revoked.hash]);
  assert.deepEqual([unver.studentId, unver.qrTokenId, unver.scannedTokenHash], [null, uuid(12), unverifiable.hash]);
  assert.equal(unknown.studentId, null);
  assert.match(unknown.scannedTokenHash, /^[0-9a-f]{64}$/);
  assert.deepEqual([malformed.studentId, malformed.qrTokenId, malformed.scannedTokenHash], [null, null, null]);
  assert.ok(pg.committed.scans.every((s) => s.effect === "NONE" && s.lectureAttendanceId === null && s.eligibilityReason === null));
  assert.deepEqual(pg.committed.records, {});
});

test("QR: a token revoked after resolution is re-checked under the Student lock", async () => {
  reset();
  const { payload, id } = addToken(1, "s1");
  pg.beforeStatement = async (label, op) => {
    if (op === "lock:student") pg.committed.tokens[id].revokedAt = minutes(4); // revoked just before the lock
  };
  const outcome = await scan(payload);
  assert.equal(outcome.result, "INVALID_QR");
  assert.equal(recordOf("s1"), null);
});

test("QR: a historical lecture is refused (409) and nothing is recorded", async () => {
  reset();
  const { payload } = addToken(1, "s1");
  await assert.rejects(scan(payload, { lectureId: L0 }), (e) => e.code === "ATTENDANCE_LECTURE_HISTORICAL" && e.statusCode === 409);
  assert.deepEqual(pg.committed.scans, []);
  assert.deepEqual(pg.committed.registers, {});
});

test("QR: the teacher's decision stays authoritative: stronger evidence only raises a review", async () => {
  reset();
  const { payload } = addToken(1, "s1");
  teacherRecord("s1", "ABSENT");

  const outcome = await scan(payload);
  assert.deepEqual([outcome.result, outcome.effect], ["VALID", "REVIEW_REQUIRED"]);
  const record = recordOf("s1");
  assert.equal(record.status, "ABSENT");
  assert.equal(record.statusSource, "TEACHER");
  assert.equal(record.teacherStatus, "ABSENT");
  assert.equal(record.autoStatus, "PRESENT");
  assert.equal(record.pendingReviewSince.getTime(), minutes(5).getTime());
  assert.equal(record.version, 2);

  const audit = auditsOf(record.id).at(-1);
  assert.deepEqual(
    { action: audit.action, version: audit.version, fromStatus: audit.fromStatus, toStatus: audit.toStatus, fromTeacherStatus: audit.fromTeacherStatus, toTeacherStatus: audit.toTeacherStatus },
    { action: "EVIDENCE_RECORDED", version: 2, fromStatus: "ABSENT", toStatus: "ABSENT", fromTeacherStatus: "ABSENT", toTeacherStatus: "ABSENT" }
  );

  // Weaker evidence against a PRESENT decision: no review.
  reset();
  const again = addToken(1, "s1");
  teacherRecord("s1", "PRESENT");
  setNow(minutes(40));
  const late = await scan(again.payload);
  assert.equal(late.effect, "EVIDENCE_ONLY");
  assert.equal(recordOf("s1").pendingReviewSince, null);
});

test("QR: after finalization, a scan without a record is RECORDED_ONLY (no record, no audit)", async () => {
  reset();
  const { payload } = addToken(1, "s1");
  pg.committed.registers[L1] = {
    lectureId: L1, classId: C1, scheduledStartAt: START, scheduledEndAt: minutes(120), graceMinutes: 10,
    finalizedAt: minutes(130), finalizedByTeacherId: T1, version: 2, createdAt: START, updatedAt: minutes(130),
  };
  setNow(minutes(140));
  const outcome = await scan(payload);
  assert.deepEqual([outcome.result, outcome.effect, outcome.afterFinalization], ["VALID", "RECORDED_ONLY", true]);
  assert.equal(recordOf("s1"), null);
  assert.equal(pg.committed.scans[0].lectureAttendanceId, null);
  assert.deepEqual(pg.committed.recordAudits, []);
});

test("QR: fail closed: missing settings or QR secret, foreign lecture, bad scan id (nothing recorded)", async () => {
  reset();
  const { payload } = addToken(1, "s1");
  const without = (key) => Object.fromEntries(Object.entries(ENV).filter(([k]) => k !== key));

  await assert.rejects(scan(payload, { env: without("APPROVAL_FEATURE_STARTED_AT") }), (e) => e.code === "ATTENDANCE_APPROVAL_NOT_CONFIGURED" && e.statusCode === 503);
  await assert.rejects(scan(payload, { env: { ...ENV, ATTENDANCE_EVIDENCE_STARTED_AT: "2026-08-15T00:00:00" } }), (e) => e.code === "ATTENDANCE_EVIDENCE_NOT_CONFIGURED");
  await assert.rejects(scan(payload, { env: without("STUDENT_QR_SECRET") }), (e) => e.code === "STUDENT_QR_NOT_CONFIGURED" && e.statusCode === 503);
  await assert.rejects(qr.recordQrScan({ teacherId: T2, lectureId: L1, clientScanId: scanId(), payload }, { env: ENV }), (e) => e.code === "LECTURE_NOT_FOUND");
  for (const bad of ["short", "x".repeat(65), "has space in it!!", 42, null]) {
    await assert.rejects(scan(payload, { clientScanId: bad }), (e) => e.code === "VALIDATION_ERROR");
  }
  assert.equal(pg.transactions.length, 0);
  assert.deepEqual(pg.committed.scans, []);
});

// =========================================================================================
// Online evidence (after the visit's own transaction)
// =========================================================================================

const visit = (id, studentId, joinedAt, sessionId = "session-1") => {
  pg.committed.visits[id] = { id, studentId, joinedAt, classSessionId: sessionId };
};

test("online: an eligible visit creates the AUTO record from joinedAt, audited with the visit", async () => {
  reset();
  visit("v1", "s1", minutes(2));
  setNow(minutes(3));
  assert.deepEqual(await evidence.recordOnlineEvidence("v1", { env: ENV }), { status: "APPLIED", effect: "STATUS_UPDATED" });

  const record = recordOf("s1");
  assert.equal(record.status, "PRESENT");
  assert.equal(record.firstOnlineAt.getTime(), minutes(2).getTime());
  const [audit] = auditsOf(record.id);
  assert.equal(audit.action, "CREATED_AUTO");
  assert.equal(audit.attendanceVisitId, "v1");
  assert.equal(audit.scanEventId, null);
  assertAuditChain(record);
});

test("online: eligibility at joinedAt; UNKNOWN and NOT_ELIGIBLE write nothing", async () => {
  reset();
  addStudent("s-late-join", { enrolledAt: minutes(6) });
  visit("v-early", "s-late-join", minutes(4));
  visit("v-pending", "s-pending", minutes(4));
  addStudent("s-broken");
  pg.committed.students["s-broken"].confirmedAt = new Date("2026-08-02T00:00:00Z");
  visit("v-broken", "s-broken", minutes(4));

  assert.deepEqual(await evidence.recordOnlineEvidence("v-early", { env: ENV }), { status: "NOT_ELIGIBLE", outcome: "NOT_ELIGIBLE" });
  assert.deepEqual(await evidence.recordOnlineEvidence("v-pending", { env: ENV }), { status: "NOT_ELIGIBLE", outcome: "NOT_ELIGIBLE" });
  assert.deepEqual(await evidence.recordOnlineEvidence("v-broken", { env: ENV }), { status: "NOT_ELIGIBLE", outcome: "UNKNOWN" });
  assert.deepEqual(pg.committed.records, {});
  assert.deepEqual(pg.committed.registers, {});
});

test("online: skips (no transaction) for missing settings, lectureless sessions and unknown visits; historical lectures write nothing", async () => {
  reset();
  visit("v1", "s1", minutes(2));
  visit("v-free", "s1", minutes(2), "session-free");
  visit("v-old", "s1", new Date("2026-08-01T12:35:00Z"), "session-0");

  assert.deepEqual(await evidence.recordOnlineEvidence("v1", { env: {} }), { status: "SKIPPED", reason: "APPROVAL_NOT_CONFIGURED" });
  assert.deepEqual(await evidence.recordOnlineEvidence("v1", { env: { APPROVAL_FEATURE_STARTED_AT: ENV.APPROVAL_FEATURE_STARTED_AT } }), { status: "SKIPPED", reason: "EVIDENCE_NOT_CONFIGURED" });
  assert.deepEqual(await evidence.recordOnlineEvidence("v-free", { env: ENV }), { status: "SKIPPED", reason: "NO_LECTURE" });
  assert.deepEqual(await evidence.recordOnlineEvidence("missing", { env: ENV }), { status: "SKIPPED", reason: "VISIT_NOT_FOUND" });
  assert.equal(pg.transactions.length, 0);

  assert.deepEqual(await evidence.recordOnlineEvidence("v-old", { env: ENV }), { status: "SKIPPED", reason: "HISTORICAL_LECTURE" });
  assert.deepEqual(pg.committed.records, {});
});

test("online + QR combined: the earliest evidence decides; an earlier online visit upgrades a LATE QR record", async () => {
  reset();
  const { payload } = addToken(1, "s1");
  setNow(minutes(20));
  assert.equal((await scan(payload)).attendance.status, "LATE");

  visit("v1", "s1", minutes(2)); // reconciled / delayed: an earlier visit
  setNow(minutes(21));
  assert.deepEqual(await evidence.recordOnlineEvidence("v1", { env: ENV }), { status: "APPLIED", effect: "STATUS_UPDATED" });

  const record = recordOf("s1");
  assert.equal(record.status, "PRESENT");
  assert.equal(record.firstQrAt.getTime(), minutes(20).getTime());
  assert.equal(record.firstOnlineAt.getTime(), minutes(2).getTime());
  assert.deepEqual(auditsOf(record.id).map((a) => a.action), ["CREATED_AUTO", "AUTO_UPDATED"]);
  assertAuditChain(record);

  // The same visit again: DUPLICATE, nothing written.
  assert.deepEqual(await evidence.recordOnlineEvidence("v1", { env: ENV }), { status: "APPLIED", effect: "DUPLICATE" });
  assert.equal(recordOf("s1").version, 2);
});

test("online and QR racing for the same new record: one record, both pieces of evidence kept", async () => {
  reset();
  const { payload } = addToken(1, "s1");
  visit("v1", "s1", minutes(2));
  let release;
  const gate = new Promise((r) => { release = r; });
  pg.beforeStatement = async (label, op) => {
    if (label === "tx1" && op === "create:scan") await gate; // the QR transaction holds its uncommitted record insert
  };
  setNow(minutes(3));

  const qrDone = scan(payload);
  while (!pg.log.includes("tx1:insert:record:s1")) await new Promise((r) => setImmediate(r));
  const online = evidence.recordOnlineEvidence("v1", { env: ENV });
  while (!pg.log.some((e) => e.startsWith("tx2:waits:") || e.startsWith("tx2:unique-wait:"))) await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([qrDone, online]);

  assert.equal(Object.keys(pg.committed.records).length, 1);
  const record = recordOf("s1");
  assert.ok(record.firstQrAt && record.firstOnlineAt);
  assert.equal(record.firstOnlineAt.getTime(), minutes(2).getTime());
  assertAuditChain(record);
});

// ---- dispatcher ---------------------------------------------------------------------------

const D = dispatcher.onlineEvidenceDispatcherForTesting;

test("dispatcher: runs the default processor after the visit committed (real recordOnlineEvidence)", async () => {
  reset();
  visit("v1", "s1", minutes(2)); // the join's own transaction has committed this row
  const saved = { ...process.env };
  Object.assign(process.env, ENV);
  try {
    dispatcher.dispatchOnlineEvidence("v1", ENV);
    await D.idle();
  } finally {
    for (const key of Object.keys(ENV)) if (!(key in saved)) delete process.env[key];
  }
  assert.equal(recordOf("s1").status, "PRESENT");
});

test("dispatcher: never throws; failures, overflow and restarts are dropped for reconciliation", async () => {
  reset();
  const calls = [];
  const gates = [];
  D.reset(async (visitId) => {
    calls.push(visitId);
    await new Promise((r) => gates.push(r));
    if (visitId === "boom") throw new Error("database unavailable");
  });
  const errors = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (line) => errors.push(String(line));
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => dispatcher.dispatchOnlineEvidence("boom", ENV));
    dispatcher.dispatchOnlineEvidence("v2", ENV);
    dispatcher.dispatchOnlineEvidence("v3", ENV);
    // Nothing starts inside the caller's call stack.
    assert.deepEqual(D.snapshot(), { queued: 3, running: 0, dropped: 0, failed: 0 });
    assert.deepEqual(calls, []);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(D.snapshot(), { queued: 1, running: dispatcher.ONLINE_EVIDENCE_CONCURRENCY, dropped: 0, failed: 0 });

    for (let i = 0; i < dispatcher.ONLINE_EVIDENCE_QUEUE_CAPACITY + 5; i += 1) dispatcher.dispatchOnlineEvidence(`q${i}`, ENV);
    assert.equal(D.snapshot().queued, dispatcher.ONLINE_EVIDENCE_QUEUE_CAPACITY);
    assert.equal(D.snapshot().dropped, 6);

    while (D.snapshot().running > 0 || D.snapshot().queued > 0) {
      while (gates.length) gates.shift()();
      await new Promise((r) => setImmediate(r));
    }
    await D.idle();
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.equal(D.snapshot().failed, 1);
  assert.ok(errors.some((line) => /online evidence not recorded/.test(line) && /database unavailable/.test(line)));
  assert.ok(calls.length <= dispatcher.ONLINE_EVIDENCE_QUEUE_CAPACITY + 2);
});

test("dispatcher: nothing runs on serverless platforms or without both settings", async () => {
  reset();
  const calls = [];
  D.reset(async (visitId) => calls.push(visitId));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    dispatcher.dispatchOnlineEvidence("v1", { ...ENV, NETLIFY: "true" });
    dispatcher.dispatchOnlineEvidence("v2", { ...ENV, AWS_LAMBDA_FUNCTION_NAME: "fn" });
    dispatcher.dispatchOnlineEvidence("v3", { STUDENT_QR_SECRET: ENV.STUDENT_QR_SECRET });
    dispatcher.dispatchOnlineEvidence("v4", { ...ENV, ATTENDANCE_EVIDENCE_STARTED_AT: "bad" });
  } finally {
    console.warn = originalWarn;
  }
  await D.idle();
  assert.deepEqual(calls, []);
  assert.equal(dispatcher.isServerlessRuntime({ NETLIFY: "1" }), true);
  assert.equal(dispatcher.isServerlessRuntime({}), false);
});

test("join hook: markAttendanceOnJoin's transaction is byte-identical; the dispatch is one call after the commit and the event", () => {
  const crypto = require("node:crypto");
  const source = fs.readFileSync(path.join(root, "services", "session-service.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("export async function markAttendanceOnJoin(");
  const fn = source.slice(start, source.indexOf("\nexport async function markStudentLeftSession(", start));
  const tx = fn.slice(fn.indexOf("const { attendance, closedVisitIds } = await prisma.$transaction("), fn.indexOf("emitStudentDataChange("));
  const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

  // Hashes recorded before Stage 5.4b changed the file.
  assert.equal(sha(tx), "f898eaf81f4bdc097584753971eee01d2adc12b395d31ecfdb08134b161e02f5", "the visit transaction is unchanged");
  const withoutHook = fn.replace(/\n  \/\/ Unified lecture attendance[^\n]*\n  dispatchOnlineEvidence\(attendance\.id\);\n\n/, "\n");
  assert.equal(sha(withoutHook), "8f6428e95bda139cefd13d6cc3c4a0b76dd6282af823fd8edc5d36ca91ef979f", "nothing else in the function changed");

  assert.equal(fn.split("dispatchOnlineEvidence(").length - 1, 1);
  assert.ok(fn.indexOf("emitStudentDataChange(") < fn.indexOf("dispatchOnlineEvidence(attendance.id)"));
  assert.ok(fn.indexOf("dispatchOnlineEvidence(attendance.id)") < fn.indexOf("return {\n    attendance,"));
  // No other session-service function dispatches evidence.
  assert.equal(source.split("dispatchOnlineEvidence(").length - 1, 1);
});

// =========================================================================================
// Review: accept / dismiss
// =========================================================================================

async function pendingReview() {
  reset();
  const { payload } = addToken(1, "s1");
  teacherRecord("s1", "ABSENT");
  await scan(payload); // raises a review (version 2)
  return recordOf("s1");
}

test("accept: needs a reason; the evidence status becomes the teacher's decision; the review is cleared", async () => {
  const record = await pendingReview();
  const input = { teacherId: T1, lectureId: L1, studentId: "s1", expectedVersion: record.version };

  await assert.rejects(evidence.acceptEvidence(input), (e) => e.code === "ATTENDANCE_REASON_REQUIRED" && e.statusCode === 400);
  await assert.rejects(evidence.acceptEvidence({ ...input, reason: "   " }), (e) => e.code === "ATTENDANCE_REASON_REQUIRED");
  await assert.rejects(evidence.acceptEvidence({ ...input, reason: "x".repeat(501) }), (e) => e.code === "VALIDATION_ERROR");

  setNow(minutes(60));
  const updated = await evidence.acceptEvidence({ ...input, reason: "  Seen in class.  " }, {});
  assert.deepEqual(
    { status: updated.status, statusSource: updated.statusSource, teacherStatus: updated.teacherStatus, pendingReviewSince: updated.pendingReviewSince, version: updated.version },
    { status: "PRESENT", statusSource: "TEACHER", teacherStatus: "PRESENT", pendingReviewSince: null, version: 3 }
  );
  const stored = recordOf("s1");
  assert.equal(stored.teacherDecidedById, T1);
  assert.equal(stored.teacherDecidedAt.getTime(), minutes(60).getTime());

  const audit = auditsOf(stored.id).at(-1);
  assert.deepEqual(
    { action: audit.action, actorRole: audit.actorRole, actorId: audit.actorId, reason: audit.reason, fromStatus: audit.fromStatus, toStatus: audit.toStatus, afterFinalization: audit.afterFinalization },
    { action: "EVIDENCE_ACCEPTED", actorRole: "TEACHER", actorId: T1, reason: "Seen in class.", fromStatus: "ABSENT", toStatus: "PRESENT", afterFinalization: false }
  );
  assertAuditChain(stored);
});

test("dismiss: reason optional; the status stays; the review is cleared", async () => {
  const record = await pendingReview();
  const updated = await evidence.dismissEvidence({ teacherId: T1, lectureId: L1, studentId: "s1", expectedVersion: record.version });
  assert.equal(updated.status, "ABSENT");
  assert.equal(updated.statusSource, "TEACHER");
  assert.equal(updated.pendingReviewSince, null);
  assert.equal(updated.version, 3);
  const audit = auditsOf(updated.id).at(-1);
  assert.deepEqual([audit.action, audit.reason, audit.fromStatus, audit.toStatus], ["EVIDENCE_DISMISSED", null, "ABSENT", "ABSENT"]);
  assertAuditChain(recordOf("s1"));
});

test("review: stale version, nothing pending, other teacher, cancelled lecture; no configuration needed", async () => {
  const record = await pendingReview();
  const base = { teacherId: T1, lectureId: L1, studentId: "s1", reason: "ok" };

  // Works with no settings at all (acts on stored evidence).
  const saved = { ...process.env };
  delete process.env.APPROVAL_FEATURE_STARTED_AT;
  delete process.env.ATTENDANCE_EVIDENCE_STARTED_AT;
  try {
    await assert.rejects(evidence.acceptEvidence({ ...base, expectedVersion: record.version - 1 }), (e) => e.code === "ATTENDANCE_RECORD_CHANGED" && e.statusCode === 409);
    await assert.rejects(evidence.acceptEvidence({ ...base, teacherId: T2, expectedVersion: record.version }), (e) => e.code === "LECTURE_NOT_FOUND");
    await assert.rejects(evidence.acceptEvidence({ ...base, studentId: "s2", expectedVersion: 1 }), (e) => e.code === "ATTENDANCE_NO_PENDING_REVIEW");
    await assert.rejects(evidence.acceptEvidence({ ...base, expectedVersion: 0 }), (e) => e.code === "VALIDATION_ERROR");

    await evidence.dismissEvidence({ ...base, expectedVersion: record.version });
    await assert.rejects(evidence.dismissEvidence({ ...base, expectedVersion: record.version + 1 }), (e) => e.code === "ATTENDANCE_NO_PENDING_REVIEW");

    pg.committed.lectures[L1].classStatus = "CANCELLED";
    await assert.rejects(evidence.dismissEvidence({ ...base, expectedVersion: record.version + 1 }), (e) => e.code === "LECTURE_CANCELLED");
  } finally {
    Object.assign(process.env, saved);
  }
});

test("review after finalization: allowed with a reason and audited as after finalization", async () => {
  const record = await pendingReview();
  pg.committed.registers[L1] = { ...pg.committed.registers[L1], finalizedAt: minutes(130), finalizedByTeacherId: T1, version: 2 };
  setNow(minutes(140));
  const updated = await evidence.acceptEvidence({ teacherId: T1, lectureId: L1, studentId: "s1", expectedVersion: record.version, reason: "Late correction" });
  assert.equal(updated.status, "PRESENT");
  assert.equal(auditsOf(updated.id).at(-1).afterFinalization, true);
});

test("audit integrity: every record, scan and audit written here passed the database CHECK rules, versions are gap-free", async () => {
  reset();
  const a = addToken(1, "s1");
  const b = addToken(2, "s2");
  visit("v1", "s1", minutes(1));
  setNow(minutes(25));
  await scan(a.payload); // LATE
  await evidence.recordOnlineEvidence("v1", { env: ENV }); // PRESENT (earlier)
  await scan(a.payload); // DUPLICATE
  await scan(b.payload);
  for (const record of Object.values(pg.committed.records)) {
    model.checkRecord(record);
    assertAuditChain(record);
  }
  for (const s of pg.committed.scans) model.checkScan(s);
  for (const audit of pg.committed.recordAudits) model.checkAudit(audit);
  // Audits only ever link to scans and visits that exist.
  for (const audit of pg.committed.recordAudits) {
    if (audit.scanEventId) assert.ok(pg.committed.scans.some((s) => s.id === audit.scanEventId));
    if (audit.attendanceVisitId) assert.ok(pg.committed.visits[audit.attendanceVisitId]);
  }
});
