/*
 * Stage 5.4b correction: the QR scanning window (opens exactly 30 minutes
 * before the scheduled start) and the teacher's permanent QR closure (the
 * scheduled end never closes scanning).
 *
 *   npm run test:attendance-qr-window
 *
 * No database: the real services run through tsx against the in-memory
 * PostgreSQL model (tests/attendance/helpers/attendance-pg-model.cjs). Plus a
 * static guard for the additive migration and the schema.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const { createPgModel } = require("./helpers/attendance-pg-model.cjs");

const root = path.resolve(__dirname, "..", "..");

let currentPrisma = null;
const prismaProxy = new Proxy({}, { get: (_, key) => currentPrisma[key] });
{
  const filename = path.join(root, "lib/prisma.ts");
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = { prisma: prismaProxy };
  require.cache[filename] = mod;
}

const qr = require(path.join(root, "services", "lecture-attendance-qr-service.ts"));
const evidenceLib = require(path.join(root, "lib", "attendance", "evidence.ts"));
const qrToken = require(path.join(root, "lib", "student-qr-token.ts"));

// ---- Clock and fixtures ---------------------------------------------------------------

const START = new Date("2026-09-01T12:30:00.000Z");
const END = new Date("2026-09-01T14:30:00.000Z");
const at = (minutes, ms = 0) => new Date(START.getTime() + minutes * 60_000 + ms);
test.mock.timers.enable({ apis: ["Date"], now: at(0) });
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
  pg.committed.classes[C1] = { id: C1, teacherId: T1, status: 0, attendanceGraceMinutes: 10 };
  pg.committed.lectures[L1] = { id: L1, classId: C1, status: 0, classStatus: "SCHEDULED", date: START, endDate: END };
  for (const id of ["s1", "s2", "s3"]) {
    pg.committed.students[id] = { id, name: id, registrationNumber: null, teacherId: T1, status: 0, confirmationStatus: "APPROVED", confirmedAt: APPROVED_AT, approvedAt: APPROVED_AT };
    pg.committed.history.push({ id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: "APPROVED", decidedAt: APPROVED_AT, previousConfirmedAt: null });
    pg.committed.enrolments.push({ id: `e-${id}`, studentId: id, classId: C1, assignedAt: new Date("2026-08-05T05:30:00Z"), removedAt: null, isActive: true });
  }
  setNow(at(0));
}

function token(n, studentId) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const nonce = Buffer.alloc(32, n).toString("base64url");
  const value = qrToken.deriveStudentQrToken(SECRET, id, nonce);
  pg.committed.tokens[id] = { id, studentId, nonce, tokenHash: qrToken.hashStudentQrToken(value), revokedAt: null };
  return qrToken.buildStudentQrPayload(value);
}

const nextScanId = () => `window-scan-${String(++seq).padStart(8, "0")}`;
const scan = (payload, clientScanId = nextScanId()) => qr.recordQrScan({ teacherId: T1, lectureId: L1, clientScanId, payload }, { env: ENV });
const close = (teacherId = T1) => qr.closeQrAttendance({ teacherId, lectureId: L1 });
const record = (studentId) => pg.committed.records[`${L1}:${studentId}`] ?? null;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function finalizedRegister(scheduledStartAt) {
  pg.committed.registers[L1] = {
    lectureId: L1, classId: C1, scheduledStartAt, scheduledEndAt: new Date(scheduledStartAt.getTime() + 2 * 3600_000), graceMinutes: 10,
    finalizedAt: at(200), finalizedByTeacherId: T1, version: 2, createdAt: at(-60), updatedAt: at(200),
  };
}

// ---- The window (pure) ---------------------------------------------------------------

test("window helper: opens exactly 30 minutes before the start; CLOSED whatever the time once closed", () => {
  assert.equal(evidenceLib.QR_SCAN_OPENS_MINUTES_BEFORE_START, 30);
  assert.equal(evidenceLib.qrScanOpensAt(START).toISOString(), at(-30).toISOString());
  const state = (receivedAt, closed = false) => evidenceLib.qrScanWindowState({ scheduledStartAt: START, closed, receivedAt });
  assert.equal(state(at(-30, -1)), "NOT_OPEN");
  assert.equal(state(at(-30)), "OPEN");
  assert.equal(state(at(500)), "OPEN"); // long after the scheduled end
  assert.equal(state(at(-60), true), "CLOSED");
  assert.equal(state(at(10), true), "CLOSED");
  assert.throws(() => state(new Date(NaN)), RangeError);
});

// ---- Scan window -----------------------------------------------------------------------

test("scan exactly 30 minutes before the start is accepted (PRESENT)", async () => {
  reset();
  const payload = token(1, "s1");
  setNow(at(-30));
  const outcome = await scan(payload);
  assert.deepEqual([outcome.result, outcome.attendance.status], ["VALID", "PRESENT"]);
  assert.equal(record("s1").firstQrAt.toISOString(), at(-30).toISOString());
});

test("scan one millisecond before opening is refused with 409 ATTENDANCE_QR_NOT_OPEN; nothing is recorded", async () => {
  reset();
  const payload = token(1, "s1");
  setNow(at(-30, -1));
  await assert.rejects(scan(payload), (e) => {
    assert.equal(e.code, "ATTENDANCE_QR_NOT_OPEN");
    assert.equal(e.statusCode, 409);
    assert.deepEqual(e.details, { opensAt: at(-30).toISOString() });
    assert.equal(e.message, "QR attendance is not open yet for this lecture.");
    return true;
  });
  assert.deepEqual(pg.committed.scans, []);
  assert.deepEqual(pg.committed.records, {});
  assert.deepEqual(pg.committed.registers, {}, "the register created for the check rolled back");
  assert.equal(pg.transactions.at(-1).outcome, "rollback");
});

test("token problems before opening are refused too (nothing recorded)", async () => {
  reset();
  setNow(at(-31));
  await assert.rejects(scan("garbage"), (e) => e.code === "ATTENDANCE_QR_NOT_OPEN");
  assert.deepEqual(pg.committed.scans, []);
});

test("scan at the scheduled start is PRESENT; the grace boundary is unchanged", async () => {
  reset();
  const a = token(1, "s1");
  const b = token(2, "s2");
  const c = token(3, "s3");
  setNow(at(0));
  assert.equal((await scan(a)).attendance.status, "PRESENT");
  setNow(at(10));
  assert.equal((await scan(b)).attendance.status, "PRESENT");
  setNow(at(10, 1));
  assert.equal((await scan(c)).attendance.status, "LATE");
});

test("scan after the scheduled end but before the teacher closes QR attendance is accepted (LATE)", async () => {
  reset();
  const payload = token(1, "s1");
  setNow(new Date(END.getTime() + 45 * 60_000));
  const outcome = await scan(payload);
  assert.deepEqual([outcome.result, outcome.effect, outcome.attendance.status], ["VALID", "STATUS_UPDATED", "LATE"]);
});

// ---- Closure ------------------------------------------------------------------------------

test("close: persisted with the teacher and server time, in one transaction; later scans get 409 ATTENDANCE_QR_CLOSED", async () => {
  reset();
  const a = token(1, "s1");
  const b = token(2, "s2");
  setNow(at(5));
  await scan(a);

  setNow(at(40));
  const closed = await close();
  assert.deepEqual(closed, { lectureId: L1, closedAt: at(40), closedByTeacherId: T1, alreadyClosed: false });
  assert.deepEqual(pg.committed.qrClosures[L1], { lectureId: L1, classId: C1, closedAt: at(40), closedByTeacherId: T1 });
  const tx = pg.transactions.at(-1);
  assert.deepEqual(tx.options, { maxWait: 5000, timeout: 15000 });
  assert.equal(tx.statements[0], "SET");
  assert.ok(tx.statements.indexOf("lock:lecture") < tx.statements.indexOf("lock:register"));
  assert.ok(tx.statements.indexOf("lock:register") < tx.statements.indexOf("insert:closure"));

  setNow(at(41));
  await assert.rejects(scan(b), (e) => e.code === "ATTENDANCE_QR_CLOSED" && e.statusCode === 409);
  // Even inside the "normal" lecture time window, and for a student who already has a record.
  setNow(at(42));
  await assert.rejects(scan(a), (e) => e.code === "ATTENDANCE_QR_CLOSED");
  assert.equal(pg.committed.scans.length, 1);
  assert.equal(record("s2"), null);
});

test("close needs no configuration and works before any scan (creates the register with a TEACHER CREATED audit)", async () => {
  reset();
  const saved = { ...process.env };
  delete process.env.APPROVAL_FEATURE_STARTED_AT;
  delete process.env.ATTENDANCE_EVIDENCE_STARTED_AT;
  try {
    setNow(at(-120));
    const closed = await close();
    assert.equal(closed.alreadyClosed, false);
  } finally {
    Object.assign(process.env, saved);
  }
  assert.ok(pg.committed.registers[L1]);
  assert.deepEqual(
    pg.committed.registerAudits.map((a) => [a.action, a.actorRole, a.actorId]),
    [["CREATED", "TEACHER", T1]]
  );
});

test("close retry is idempotent: the stored closure is returned, nothing is written again", async () => {
  reset();
  setNow(at(30));
  const first = await close();
  setNow(at(90));
  const again = await close();
  assert.deepEqual(again, { ...first, alreadyClosed: true });
  assert.equal(Object.keys(pg.committed.qrClosures).length, 1);
  assert.equal(pg.committed.qrClosures[L1].closedAt.toISOString(), at(30).toISOString());
  assert.ok(!pg.transactions.at(-1).statements.includes("insert:closure"));
});

test("two concurrent closures: one row; the second waits on the register and returns it", async () => {
  reset();
  setNow(at(30));
  let release;
  const gate = new Promise((r) => { release = r; });
  pg.beforeStatement = async (label, op) => {
    if (label === "tx1" && op === "insert:closure") await gate;
  };
  const first = close();
  while (!pg.log.some((e) => e.startsWith("tx1:insert:register") || e.includes("tx1"))) await tick();
  await tick();
  const second = close();
  while (!pg.log.some((e) => e.startsWith("tx2:waits:") || e.startsWith("tx2:unique-wait:"))) await tick();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.alreadyClosed, false);
  assert.equal(b.alreadyClosed, true);
  assert.equal(Object.keys(pg.committed.qrClosures).length, 1);
});

test("another teacher cannot close (404, nothing written); a cancelled lecture is 409; unknown input is 400", async () => {
  reset();
  await assert.rejects(close(T2), (e) => e.code === "LECTURE_NOT_FOUND" && e.statusCode === 404);
  assert.deepEqual(pg.committed.qrClosures, {});
  assert.deepEqual(pg.committed.registers, {});

  pg.committed.lectures[L1].classStatus = "CANCELLED";
  await assert.rejects(close(), (e) => e.code === "LECTURE_CANCELLED");
  await assert.rejects(qr.closeQrAttendance({ teacherId: "", lectureId: L1 }), (e) => e.code === "VALIDATION_ERROR");
});

test("no reopening: the service has no reopen operation; the database row is append-only", () => {
  assert.deepEqual(Object.keys(qr).filter((name) => /reopen|open/i.test(name) && name !== "qrScanOpensAt"), []);
  const sql = fs.readFileSync(path.join(root, "prisma/migrations/20261110150000_add_lecture_qr_attendance_closure/migration.sql"), "utf8");
  assert.match(sql, /CREATE TRIGGER "LectureQrAttendanceClosure_no_update_delete"\s+BEFORE UPDATE OR DELETE ON "LectureQrAttendanceClosure"\s+FOR EACH ROW EXECUTE FUNCTION "AttendanceAppendOnly_guard"\(\);/);
  assert.match(sql, /CREATE TRIGGER "LectureQrAttendanceClosure_no_truncate"\s+BEFORE TRUNCATE ON "LectureQrAttendanceClosure"\s+FOR EACH STATEMENT EXECUTE FUNCTION "AttendanceAppendOnly_guard"\(\);/);
});

test("closure failure rolls everything back: no closure, no register, no CREATED audit", async () => {
  reset();
  setNow(at(30));
  pg.failOn = (label, op) => (op === "insert:closure" ? Object.assign(new Error("simulated closure insert failure"), { name: "PrismaClientKnownRequestError", code: "P2010", __db: true }) : null);
  await assert.rejects(close(), /simulated closure insert failure/);
  assert.equal(pg.transactions.at(-1).outcome, "rollback");
  assert.equal(pg.transactions.at(-1).statements.at(-1), "insert:closure", "nothing sent after the failure");
  assert.deepEqual(pg.committed.qrClosures, {});
  assert.deepEqual(pg.committed.registers, {});
  assert.deepEqual(pg.committed.registerAudits, []);

  pg.failOn = null;
  assert.equal((await close()).alreadyClosed, false);
});

// ---- Concurrency ---------------------------------------------------------------------------

test("concurrent: a scan holding the register first is accepted; the closure waits for it; later scans are refused", async () => {
  reset();
  const a = token(1, "s1");
  const b = token(2, "s2");
  setNow(at(5));
  let release;
  const gate = new Promise((r) => { release = r; });
  pg.beforeStatement = async (label, op) => {
    if (label === "tx1" && op === "create:scan") await gate; // the scan holds the register FOR KEY SHARE
  };

  const accepted = scan(a);
  while (!pg.log.includes("tx1:insert:record:s1")) await tick();
  const closing = close();
  // The register is the scan's own uncommitted insert: the closure waits on its unique key.
  while (!pg.log.some((e) => e.startsWith("tx2:waits:register:") || e.startsWith(`tx2:unique-wait:register:${L1}`))) await tick();
  assert.deepEqual(pg.committed.qrClosures, {}, "the closure waits for the scan");
  release();

  assert.equal((await accepted).result, "VALID");
  assert.equal((await closing).alreadyClosed, false);
  assert.ok(pg.log.indexOf("tx1:commit") < pg.log.indexOf("tx2:commit"));
  await assert.rejects(scan(b), (e) => e.code === "ATTENDANCE_QR_CLOSED");
});

test("concurrent: a closure holding the register first makes a waiting scan refuse after it commits", async () => {
  reset();
  const a = token(1, "s1");
  setNow(at(5));
  await scan(token(2, "s2")); // the register exists
  let release;
  const gate = new Promise((r) => { release = r; });
  pg.beforeStatement = async (label, op) => {
    if (op === "insert:closure") await gate; // the closure holds the register FOR UPDATE
  };

  const closing = close();
  while (!pg.held.some((h) => h.row === `register:${L1}` && h.mode === "UPDATE")) await tick();
  const scanning = scan(a);
  while (!pg.log.some((e) => /waits:register:/.test(e))) await tick();
  release();

  assert.equal((await closing).alreadyClosed, false);
  await assert.rejects(scanning, (e) => e.code === "ATTENDANCE_QR_CLOSED");
  assert.equal(record("s1"), null);
  assert.equal(pg.committed.scans.length, 1);
});

test("a duplicate scan retry after closure returns the stored outcome (idempotency kept)", async () => {
  reset();
  const payload = token(1, "s1");
  const id = nextScanId();
  setNow(at(5));
  const first = await scan(payload, id);
  setNow(at(30));
  await close();
  setNow(at(31));
  const retry = await scan(payload, id);
  assert.equal(retry.replayed, true);
  assert.equal(retry.scanEventId, first.scanEventId);
  // A new scan id is refused.
  await assert.rejects(scan(payload), (e) => e.code === "ATTENDANCE_QR_CLOSED");
});

// ---- Frozen schedule --------------------------------------------------------------------------

test("finalized register: the window uses the frozen start, not a later lecture edit", async () => {
  reset();
  finalizedRegister(START);
  pg.committed.lectures[L1].date = new Date(START.getTime() + 24 * 3600_000); // edited afterwards
  const payload = token(1, "s1");

  setNow(at(-30)); // open under the frozen start (and long before the edited one)
  const outcome = await scan(payload);
  assert.deepEqual([outcome.result, outcome.effect, outcome.afterFinalization], ["VALID", "RECORDED_ONLY", true]);

  setNow(at(-30, -1));
  await assert.rejects(scan(token(2, "s2")), (e) => e.code === "ATTENDANCE_QR_NOT_OPEN" && e.details.opensAt === at(-30).toISOString());
});

test("open register: the window uses the register's start, the same start PRESENT / LATE uses (Stage 5.4e)", async () => {
  reset();
  setNow(at(0));
  await scan(token(1, "s1")); // creates the open register with START
  // The lecture row alone moves (no schedule sync: a stale register). The
  // register stays authoritative; the real edit path syncs both together
  // (tests/attendance/schedule-sync.test.cjs).
  const moved = new Date(START.getTime() + 3 * 3600_000);
  pg.committed.lectures[L1].date = moved;
  pg.committed.lectures[L1].endDate = new Date(moved.getTime() + 3600_000);

  setNow(at(-30, -1));
  await assert.rejects(scan(token(2, "s2")), (e) => e.code === "ATTENDANCE_QR_NOT_OPEN" && e.details.opensAt === at(-30).toISOString());
  setNow(at(10));
  const onTime = await scan(token(2, "s2"));
  assert.deepEqual([onTime.result, onTime.attendance.status], ["VALID", "PRESENT"]); // judged against the register's start
});

test("closure after finalization is allowed and the frozen register is not modified", async () => {
  reset();
  finalizedRegister(START);
  const before = { ...pg.committed.registers[L1] };
  setNow(at(300));
  assert.equal((await close()).alreadyClosed, false);
  assert.deepEqual(pg.committed.registers[L1], before);
  assert.deepEqual(pg.committed.registerAudits, []);
});

// ---- Migration and schema (static) --------------------------------------------------------

const MIGRATIONS = path.join(root, "prisma", "migrations");
const NEW_MIGRATION = "20261110150000_add_lecture_qr_attendance_closure";

test("migration: additive, exact, after the attendance migration; only approved migrations follow; lock timeout first and last", () => {
  const names = fs.readdirSync(MIGRATIONS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.equal(names[names.indexOf("20261110140000_add_lecture_attendance") + 1], NEW_MIGRATION);
  // Only approved later migrations may follow (Student Profile SP-5.2: an additive Student column;
  // Recorded Lectures RL-2: additive new tables and a Class (id, teacherId) unique;
  // unified storage Stage 2: additive nullable Note / AssignmentSubmission columns;
  // teacher storage accounting Stage 3.1: additive new tables).
  assert.deepEqual(names.slice(names.indexOf(NEW_MIGRATION) + 1), [
    "20261112120000_add_student_session_version",
    "20261114120000_add_recorded_lectures",
    "20261115120000_add_unified_file_storage_keys",
    "20261116120000_add_teacher_storage_accounting",
    // teacher profile photos on unified storage (additive; tests/storage-quota/profile-image-migration-guard.test.cjs)
    "20261117120000_add_profile_image_reservation_category",
    "20261117120100_add_teacher_profile_image_storage",
    // simplified student registration (additive; tests/students/first-login-migration-guard.test.cjs)
    "20261118120000_add_student_password_setup_pending",
    // student email delivery outbox (additive; tests/students/email-delivery-migration-guard.test.cjs)
    "20261119120000_add_email_delivery_tracking",
    // teacher-issued Free Cards (additive; tests/fee-waiver/free-card-migration-guard.test.cjs)
    "20261120120000_add_class_student_fee_free_card",
    "20261121120000_add_class_payment_access_control", // payment access control (tests/class-access/class-access-migration-guard.test.cjs)
    "20261122120000_add_class_payment_source_and_reversal", // partial payments Stage 1 (tests/fee-waiver/partial-payment-migration-guard.test.cjs)
    "20261123120000_add_class_student_free_card_eligible", // Free Card eligibility Stage 1 (tests/fee-waiver/free-card-eligibility-migration-guard.test.cjs)
    "20261124120000_add_recorded_lecture_publication", // Recorded lecture public profile (tests/recorded-lectures/publication-migration-guard.test.cjs)
    "20261125120000_add_teacher_payment_accounts", // Teacher payment accounts (tests/teacher-profile/role-aware-profile.test.cjs)
    "20261126120000_add_teacher_title_eng", // Teacher title ENG (tests/teacher-profile/teacher-title-eng-migration-guard.test.cjs)
    "20261127120000_add_grade_zero", // Grade 0 (tests/students/grade-zero-migration-guard.test.cjs)
  ]);

  const raw = fs.readFileSync(path.join(MIGRATIONS, NEW_MIGRATION, "migration.sql"), "utf8");
  const statements = raw
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  assert.deepEqual(statements, [
    "SET lock_timeout = '5s'",
    'CREATE TABLE "LectureQrAttendanceClosure" ( "lectureId" TEXT NOT NULL, "classId" TEXT NOT NULL, "closedAt" TIMESTAMP(3) NOT NULL, "closedByTeacherId" TEXT NOT NULL, CONSTRAINT "LectureQrAttendanceClosure_pkey" PRIMARY KEY ("lectureId") )',
    'ALTER TABLE "LectureQrAttendanceClosure" ADD CONSTRAINT "LectureQrAttendanceClosure_lectureId_classId_fkey" FOREIGN KEY ("lectureId", "classId") REFERENCES "LectureAttendanceRegister"("lectureId", "classId") ON DELETE RESTRICT ON UPDATE CASCADE',
    'ALTER TABLE "LectureQrAttendanceClosure" ADD CONSTRAINT "LectureQrAttendanceClosure_closedByTeacherId_fkey" FOREIGN KEY ("closedByTeacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
    'CREATE TRIGGER "LectureQrAttendanceClosure_no_update_delete" BEFORE UPDATE OR DELETE ON "LectureQrAttendanceClosure" FOR EACH ROW EXECUTE FUNCTION "AttendanceAppendOnly_guard"()',
    'CREATE TRIGGER "LectureQrAttendanceClosure_no_truncate" BEFORE TRUNCATE ON "LectureQrAttendanceClosure" FOR EACH STATEMENT EXECUTE FUNCTION "AttendanceAppendOnly_guard"()',
    "RESET lock_timeout",
  ]);
  // Nothing destructive or rewriting: no statement drops, deletes, updates,
  // inserts, truncates, renames, alters a column, replaces a function or adds a default.
  for (const statement of statements) {
    assert.doesNotMatch(statement, /^(DROP|DELETE|UPDATE|INSERT|TRUNCATE|CREATE OR REPLACE)\b|ALTER COLUMN|RENAME|DROP |\bDEFAULT\b/, statement);
  }
});

test("previously applied migrations are byte-for-byte unchanged", () => {
  const sha = (name) => crypto.createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, name, "migration.sql"))).digest("hex");
  assert.equal(sha("20261110120000_add_lecture_end_date"), "019f1374f5b0fab4a88e2459aff3c897a98b1a8ad95cd2e2da35acdd2c096644");
  assert.equal(sha("20261110130000_add_student_confirmation_history"), "d7a9741b0de2cd8dc567c193a2041ecc73508157947aa74fd4221d0a5e6bebfc");
  assert.equal(sha("20261110140000_add_lecture_attendance"), "7bffd84e9ce603886df86edc5706c3de0bcd951bbb0bf93325a2996980a88b0f");
});

test("schema.prisma: the closure model, RESTRICT relations, back-relations; no timestamp defaults", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const block = (name) => {
    const start = schema.indexOf(`model ${name} {`);
    return schema.slice(start, schema.indexOf("\n}", start));
  };
  const closure = block("LectureQrAttendanceClosure");
  for (const line of [
    /^\s*lectureId\s+String\s+@id$/m,
    /^\s*classId\s+String$/m,
    /^\s*closedAt\s+DateTime$/m,
    /^\s*closedByTeacherId String$/m,
    /^\s*register LectureAttendanceRegister @relation\(fields: \[lectureId, classId\], references: \[lectureId, classId\], onDelete: Restrict\)$/m,
    /^\s*closedBy Teacher\s+@relation\(fields: \[closedByTeacherId\], references: \[id\], onDelete: Restrict\)$/m,
  ]) {
    assert.match(closure, line);
  }
  assert.doesNotMatch(closure, /@default|@updatedAt/);
  assert.match(block("LectureAttendanceRegister"), /^\s*qrClosures\s+LectureQrAttendanceClosure\[\]$/m);
  assert.match(block("Teacher"), /^\s*qrAttendanceClosures\s+LectureQrAttendanceClosure\[\]$/m);
});
