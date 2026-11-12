/*
 * Shared in-process environment for the attendance API route tests
 * (app/api/lectures/[id]/attendance/**). Must be required BEFORE any route.
 *
 * Faked edges only: the session (lib/auth-session.ts, mirroring its 401
 * rules, as tests/student-qr/helpers/qr-route-env.cjs does) and Prisma
 * (lib/prisma.ts → the in-memory PostgreSQL model of
 * tests/attendance/helpers/attendance-pg-model.cjs). The routes, the real
 * attendance services, the error handler and the same-origin check run
 * unchanged. The settings come from process.env (test values, no secrets);
 * the error log goes to a memory sink. No database.
 */

"use strict";

const path = require("node:path");
const Module = require("node:module");

require("../../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const { createPgModel } = require("./attendance-pg-model.cjs");

const root = path.resolve(__dirname, "..", "..", "..");
const { AppError } = require(path.join(root, "lib", "error-handler.ts"));

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

const state = {
  session: null, // { role: "TEACHER" | "STUDENT" | "ADMIN", userId }
  calls: { session: 0 },
  model: null,
  pg: null,
};

const unauthorized = () => new AppError("Authentication required.", 401, "UNAUTHORIZED");
const invalid = () => new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");

fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    state.calls.session += 1;
    if (!state.session) throw unauthorized();
    if (state.session.role !== "TEACHER") throw invalid();
    return { teacherId: state.session.userId, email: "t@example.test", name: "T", role: "TEACHER" };
  },
  requireStudentSession: async () => {
    throw new Error("not used");
  },
  requireAppSession: async () => {
    throw new Error("not used");
  },
  requireAdminSession: async () => {
    throw new Error("not used");
  },
  getOptionalSession: async () => null,
});
fake("lib/prisma.ts", { prisma: new Proxy({}, { get: (_, key) => state.model.prisma[key] }) });

// Test-only settings (no secrets): the app origin and the two attendance instants.
const APP_ORIGIN = "https://app.example.test";
const ENV = { APPROVAL_FEATURE_STARTED_AT: "2026-07-28T00:00:00Z", ATTENDANCE_EVIDENCE_STARTED_AT: "2026-08-15T00:00:00Z" };
process.env.APP_URL = APP_ORIGIN;
Object.assign(process.env, ENV);

// The API error log: a memory sink.
const serverLogger = require(path.join(root, "lib", "error-logging", "server-logger.ts"));
const errorLog = [];
serverLogger.setErrorLogSinkForTests({
  write: async (channel, entry) => { errorLog.push({ channel, entry }); },
  writeSync: (channel, entry) => { errorLog.push({ channel, entry }); },
  flush: async () => {},
});

// ---- Fixtures -----------------------------------------------------------------------------

const START = new Date("2026-09-01T12:30:00.000Z"); // LIVE
const at = (minutes) => new Date(START.getTime() + minutes * 60_000);
const NOW = at(200); // after the scheduled end (at(120))
const T1 = "teacher-1";
const T2 = "teacher-2";
const C1 = "class-1";
const C2 = "class-2";
const L1 = "lecture-1";
const APPROVED_AT = new Date("2026-08-01T00:00:00.000Z");
const local = (date) => new Date(date.getTime() + (5 * 60 + 30) * 60_000);
let visitSeq = 0;

function reset({ date = START, endDate = at(120), classStatus = "SCHEDULED" } = {}) {
  state.model = createPgModel();
  state.pg = state.model.pg;
  state.session = { role: "TEACHER", userId: T1 };
  state.calls.session = 0;
  errorLog.length = 0;
  visitSeq = 0;
  const pg = state.pg;
  pg.committed.classes[C1] = { id: C1, teacherId: T1, status: 0, attendanceGraceMinutes: 10 };
  pg.committed.classes[C2] = { id: C2, teacherId: T2, status: 0, attendanceGraceMinutes: 10 };
  pg.committed.lectures[L1] = { id: L1, classId: C1, title: "Kinematics", status: 0, classStatus, date, endDate, createdAt: at(-1000) };
  pg.committed.sessions["sess-a"] = { id: "sess-a", lectureId: L1, isActive: false, startedAt: at(-5) };
  return pg;
}

function student(id, { teacherId = T1, classId = C1, status = 0, confirmationStatus = "APPROVED", broken = false, enrolledAt = new Date("2026-08-05T00:00:00Z") } = {}) {
  const pg = state.pg;
  pg.committed.students[id] = {
    id, name: `Name of ${id}`, registrationNumber: `REG-${id}`, teacherId, status, confirmationStatus,
    confirmedAt: confirmationStatus === "PENDING" ? null : broken ? new Date("2026-08-02T00:00:00Z") : APPROVED_AT,
    approvedAt: confirmationStatus === "PENDING" ? null : APPROVED_AT,
  };
  if (confirmationStatus !== "PENDING") {
    pg.committed.history.push({ id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: confirmationStatus, decidedAt: APPROVED_AT, previousConfirmedAt: null });
  }
  if (enrolledAt) {
    pg.committed.enrolments.push({ id: `e-${id}`, studentId: id, classId, assignedAt: local(enrolledAt), removedAt: null, isActive: true });
  }
}

function visit(studentId, joinedAt, session = "sess-a") {
  const id = `visit-${String(++visitSeq).padStart(4, "0")}`;
  state.pg.committed.visits[id] = { id, studentId, joinedAt, classSessionId: session };
  return id;
}

function register(extra = {}) {
  const l = state.pg.committed.lectures[L1];
  state.pg.committed.registers[L1] = {
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
  state.model.checkRecord(row);
  state.pg.committed.records[`${L1}:${studentId}`] = row;
  state.pg.committed.recordAudits.push({ id: `seed-${studentId}`, lectureAttendanceId: row.id, version: 1, lectureId: L1, studentId,
    action: row.statusSource === "TEACHER" ? "TEACHER_SET" : "CREATED_AUTO", toStatus: row.status });
  return row;
}

const teacherRecord = (status, extra = {}) => ({ status, statusSource: "TEACHER", teacherStatus: status, teacherDecidedAt: at(130), teacherDecidedById: T1, ...extra });

// ---- Requests -------------------------------------------------------------------------------

const ctx = (id) => ({ params: { id } });
const get = (url, headers = {}) => new Request(`${APP_ORIGIN}${url}`, { headers });
const post = (url, { body, headers = {} } = {}) =>
  new Request(`${APP_ORIGIN}${url}`, {
    method: "POST",
    headers: { Origin: APP_ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const attendanceState = () =>
  JSON.stringify([state.pg.committed.registers, state.pg.committed.registerAudits, state.pg.committed.records, state.pg.committed.recordAudits, state.pg.committed.lectures]);

function assertNoStore(assert, response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("vary"), "Cookie");
}

/** Bad lecture ids (D2): blank, whitespace, over 191 characters. */
const BAD_IDS = ["", "   ", "x".repeat(192)];

/** Runs `fn` with the settings removed / replaced; restores them after. */
async function withEnv(patch, fn) {
  const saved = { ...ENV };
  const warn = console.warn;
  console.warn = () => {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    Object.assign(process.env, saved);
    console.warn = warn;
  }
}

module.exports = {
  root, state, errorLog, reset, student, visit, register, seedRecord, teacherRecord,
  START, NOW, at, T1, T2, C1, C2, L1, APP_ORIGIN, ENV, ctx, get, post, attendanceState, assertNoStore, BAD_IDS, withEnv,
};
