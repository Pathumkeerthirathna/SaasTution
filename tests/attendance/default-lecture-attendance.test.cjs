/*
 * The default lecture (Lecture.isDefault, lib/default-lecture.ts) is never a
 * teaching session for attendance: no register, record, QR scan, closure,
 * decision, history or online evidence. The real services run through tsx
 * against the in-memory PostgreSQL model (helpers/attendance-pg-model.cjs),
 * which applies a `where.isDefault` filter like the database. Two layers are
 * checked: the request-level lookups (NORMAL_LECTURE_WHERE: 404 before any
 * lock) and the central check under the lecture lock
 * (inspectLectureForAttendance: NOT_FOUND even if a lookup missed it).
 * No database.
 *
 *   node --test tests/attendance/default-lecture-attendance.test.cjs   (part of npm run test:attendance)
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

const qr = require(path.join(root, "services", "lecture-attendance-qr-service.ts"));
const decisions = require(path.join(root, "services", "lecture-attendance-decision-service.ts"));
const evidence = require(path.join(root, "services", "lecture-attendance-evidence-service.ts"));
const history = require(path.join(root, "services", "lecture-attendance-history-service.ts"));
const registerService = require(path.join(root, "services", "lecture-attendance-service.ts"));
const { runAttendanceTransaction } = require(path.join(root, "lib", "attendance", "locks.ts"));
const qrToken = require(path.join(root, "lib", "student-qr-token.ts"));

const START = new Date("2026-09-01T12:30:00.000Z");
const at = (minutes) => new Date(START.getTime() + minutes * 60_000);
test.mock.timers.enable({ apis: ["Date"], now: at(60) });

const T1 = "teacher-1";
const C1 = "class-1";
const NORMAL = "lecture-normal";
const DEFAULT = "lecture-default";
const APPROVED_AT = new Date("2026-08-01T00:00:00.000Z");
const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + 7) % 256));
const ENV = {
  APPROVAL_FEATURE_STARTED_AT: "2026-07-28T00:00:00Z",
  ATTENDANCE_EVIDENCE_STARTED_AT: "2026-08-15T00:00:00Z",
  STUDENT_QR_SECRET: SECRET.toString("base64"),
};

let model;
let pg;
let payload;
let scanSeq = 0;

function reset() {
  model = createPgModel();
  pg = model.pg;
  currentPrisma = model.prisma;
  pg.committed.classes[C1] = { id: C1, teacherId: T1, status: 0, attendanceGraceMinutes: 10 };
  // The same class's normal lecture (seeded without the column: the database default, false) and its default lecture.
  pg.committed.lectures[NORMAL] = { id: NORMAL, classId: C1, status: 0, classStatus: "LIVE", date: START, endDate: at(120) };
  pg.committed.lectures[DEFAULT] = { id: DEFAULT, classId: C1, status: 0, classStatus: "SCHEDULED", date: START, endDate: null, isDefault: true };
  pg.committed.students.s1 = {
    id: "s1", name: "Name s1", registrationNumber: "REG-s1", teacherId: T1, status: 0, confirmationStatus: "APPROVED", confirmedAt: APPROVED_AT, approvedAt: APPROVED_AT,
  };
  pg.committed.history.push({ id: "h-s1", studentId: "s1", fromStatus: "PENDING", toStatus: "APPROVED", decidedAt: APPROVED_AT, previousConfirmedAt: null });
  pg.committed.enrolments.push({ id: "e-s1", studentId: "s1", classId: C1, assignedAt: new Date("2026-08-05T05:30:00Z"), removedAt: null, isActive: true });
  const id = "00000000-0000-4000-8000-000000000001";
  const nonce = Buffer.alloc(32, 1).toString("base64url");
  const value = qrToken.deriveStudentQrToken(SECRET, id, nonce);
  pg.committed.tokens[id] = { id, studentId: "s1", nonce, tokenHash: qrToken.hashStudentQrToken(value), revokedAt: null };
  payload = qrToken.buildStudentQrPayload(value);
}

const scan = (lectureId) =>
  qr.recordQrScan({ teacherId: T1, lectureId, clientScanId: `default-lecture-scan-${String(++scanSeq).padStart(6, "0")}`, payload }, { env: ENV });

async function rejectsNotFound(promise, label) {
  await assert.rejects(promise, (error) => error.code === "LECTURE_NOT_FOUND", label);
}

function nothingWrittenFor(lectureId) {
  assert.equal(pg.committed.registers[lectureId], undefined, "no attendance register");
  assert.equal(Object.values(pg.committed.records).filter((r) => r.lectureId === lectureId).length, 0, "no attendance record");
  assert.equal(pg.committed.scans.filter((s) => s.lectureId === lectureId).length, 0, "no scan event");
}

test("QR attendance cannot be started for a default lecture: 404 LECTURE_NOT_FOUND, no register, record or scan", async () => {
  reset();
  await rejectsNotFound(scan(DEFAULT), "QR scan");
  nothingWrittenFor(DEFAULT);
  await rejectsNotFound(qr.closeQrAttendance({ teacherId: T1, lectureId: DEFAULT }), "QR closure");
  nothingWrittenFor(DEFAULT);
});

test("control: the same class's normal lecture still takes QR attendance (one record, one scan)", async () => {
  reset();
  const outcome = await scan(NORMAL);
  assert.equal(outcome.result, "VALID");
  assert.equal(Object.values(pg.committed.records).filter((r) => r.lectureId === NORMAL).length, 1);
  assert.ok(pg.committed.registers[NORMAL], "the register is created as before");
  nothingWrittenFor(DEFAULT);
});

test("the register view, history and teacher decisions refuse a default lecture (404)", async () => {
  reset();
  await rejectsNotFound(registerService.getRegister(T1, DEFAULT, { env: ENV, now: new Date() }), "register view");
  await rejectsNotFound(
    decisions.setTeacherAttendanceStatus({ teacherId: T1, lectureId: DEFAULT, studentId: "s1", status: "PRESENT", expectedVersion: null, reason: null }),
    "teacher decision"
  );
  await rejectsNotFound(history.getRegisterHistory(T1, DEFAULT), "register history");
  nothingWrittenFor(DEFAULT);
});

test("central check under the lecture lock: a default lecture is NOT_FOUND (no register can ever be created for it)", async () => {
  reset();
  const found = await runAttendanceTransaction((locks) => registerService.inspectLectureForAttendance(locks, DEFAULT));
  assert.equal(found.state, "NOT_FOUND");
  await rejectsNotFound(
    runAttendanceTransaction((locks) =>
      registerService.ensureRegister(locks, DEFAULT, { mode: "KEY_SHARE", now: new Date(), actor: { role: "TEACHER", teacherId: T1 }, teacherId: T1 })
    ),
    "ensureRegister"
  );
  nothingWrittenFor(DEFAULT);
  const normal = await runAttendanceTransaction((locks) => registerService.inspectLectureForAttendance(locks, NORMAL));
  assert.equal(normal.state, "OK", "a normal lecture is unchanged");
});

test("online evidence from a session on a default lecture is skipped (never recorded)", async () => {
  reset();
  pg.committed.sessions["session-d"] = { id: "session-d", lectureId: DEFAULT };
  pg.committed.visits["visit-d"] = { id: "visit-d", studentId: "s1", joinedAt: at(5), classSessionId: "session-d" };
  const result = await evidence.recordOnlineEvidence("visit-d", { env: ENV });
  assert.deepEqual(result, { status: "SKIPPED", reason: "LECTURE_UNAVAILABLE" });
  nothingWrittenFor(DEFAULT);
});
