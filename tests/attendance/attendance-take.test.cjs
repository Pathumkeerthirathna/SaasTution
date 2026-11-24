/*
 * Taking attendance from the Attendance page:
 *  - services/class-attendance-matrix-service.ts and
 *    GET /api/classes/[id]/attendance-matrix (one Sri Lankan month, students
 *    × actual lectures, read only, fixed query count);
 *  - services/attendance-lecture-create-service.ts and
 *    POST /api/classes/[id]/attendance-lectures (the existing
 *    createLectureForTeacher behind a transaction-safe duplicate check).
 *
 *   npm run test:attendance
 *
 * Real routes, services, validation, same-origin check and error handler.
 * Faked edges: the session, Prisma (an in-memory store that counts calls,
 * rolls a failed transaction back and serializes transactions on the same
 * advisory-lock key like pg_advisory_xact_lock), live-update events and the
 * fee-waiver hooks. No database.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

// ---- Fixtures --------------------------------------------------------------------------------------

const T1 = "teacher-1";
const T2 = "teacher-2";
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const C_DELETED = "33333333-3333-4333-8333-333333333333";
const APP_ORIGIN = "https://app.example.test";
process.env.APP_URL = APP_ORIGIN;

/** Sri Lankan wall clock "YYYY-MM-DDTHH:MM" → the real instant. */
const sl = (wall) => new Date(new Date(`${wall}:00.000Z`).getTime() - 330 * 60_000);
/** A real instant → Sri Lankan wall-clock digits (how ClassStudent.assignedAt / removedAt are stored). */
const digits = (instant) => new Date(instant.getTime() + 330 * 60_000);

let store;
let calls;
let emitted;
let currentSession;
let createDelayMs = 0;
/**
 * Simulated cost of one statement inside a transaction (virtual ms; no real
 * waiting). On the remote, pooled testing database each statement took about
 * 1.4 s at a 700 ms round trip (measured on a real PostgreSQL behind a delay
 * proxy), so 4 statements exceed Prisma's 5 s default transaction timeout.
 */
let txStatementCostMs = 0;
/** Set to make the lock statement fail like PostgreSQL's lock_timeout (P2010 / 55P03). */
let lockTimesOut = false;
/** Set to make the INSERT fail with a database error (a failed transaction). */
let createFails = false;
/** The options each $transaction call received. */
let transactionOptions = [];

function resetStore() {
  store = {
    classes: {
      [C1]: { id: C1, name: "Physics", teacherId: T1, status: 0, schedule: "Mon 09:00", attendanceGraceMinutes: 10 },
      [C2]: { id: C2, name: "Chemistry", teacherId: T2, status: 0, schedule: "Tue", attendanceGraceMinutes: 10 },
      [C_DELETED]: { id: C_DELETED, name: "Old", teacherId: T1, status: 1, schedule: "", attendanceGraceMinutes: 10 },
    },
    schedules: [
      { id: "s-mon-2", classId: C1, dayOfWeek: "MONDAY", startTime: "14:00", endTime: "16:00" },
      { id: "s-mon-1", classId: C1, dayOfWeek: "MONDAY", startTime: "09:00", endTime: "11:00" },
      { id: "s-fri", classId: C1, dayOfWeek: "FRIDAY", startTime: "16:00", endTime: "18:00" },
    ],
    lectures: [],
    enrolments: [],
    students: [],
    records: [],
    registers: [],
    closures: [],
  };
  calls = [];
  emitted = [];
  currentSession = { teacherId: T1 };
  createDelayMs = 0;
  txStatementCostMs = 0;
  lockTimesOut = false;
  createFails = false;
  transactionOptions = [];
}

let lectureSeq = 0;
function lecture(fields) {
  const row = { id: `lec-${String(++lectureSeq).padStart(3, "0")}`, classId: C1, title: "L", status: 0, classStatus: "SCHEDULED", endDate: null, createdAt: new Date(0), ...fields };
  store.lectures.push(row);
  return row;
}
function student(id, { name = `Student ${id}`, teacherId = T1, status = 0, enrol = [] } = {}) {
  store.students.push({ id, name, registrationNumber: `REG-${id}`, teacherId, status });
  enrol.forEach(([from, to, classId = C1], i) => {
    store.enrolments.push({
      id: `e-${id}-${i}`, classId, studentId: id, assignedAt: digits(from), removedAt: to ? digits(to) : null, isActive: to === null,
    });
  });
}

// ---- Fake Prisma -------------------------------------------------------------------------------------

const matchDate = (value, filter) =>
  (filter.gte === undefined || value.getTime() >= filter.gte.getTime()) &&
  (filter.lt === undefined || value.getTime() < filter.lt.getTime()) &&
  (filter.lte === undefined || value.getTime() <= filter.lte.getTime());

function lectureMatches(row, where) {
  if (where.classId !== undefined && row.classId !== where.classId) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.classStatus?.not !== undefined && row.classStatus === where.classStatus.not) return false;
  if (where.date && !matchDate(row.date, where.date)) return false;
  if (where.id?.in && !where.id.in.includes(row.id)) return false;
  if (where.class) {
    const cls = store.classes[row.classId];
    if (where.class.teacherId !== undefined && cls.teacherId !== where.class.teacherId) return false;
    if (where.class.status !== undefined && cls.status !== where.class.status) return false;
  }
  return true;
}

function pick(row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const [key, value] of Object.entries(select)) {
    if (key === "schedules") {
      out.schedules = store.schedules.filter((s) => s.classId === row.id).map((s) => pick(s, value.select));
    } else if (key === "class") {
      out.class = pick(store.classes[row.classId], value.select);
    } else {
      out[key] = row[key];
    }
  }
  return out;
}

const sortLectures = (rows) => [...rows].sort((a, b) => a.date.getTime() - b.date.getTime() || (a.id < b.id ? -1 : 1));

/** Advisory locks: one chain per key; a transaction holds its keys until it ends. */
const lockChains = new Map();
function acquire(key) {
  const previous = lockChains.get(key) ?? Promise.resolve();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  lockChains.set(key, previous.then(() => held));
  return previous.then(() => release);
}

/** Prisma's interactive-transaction expiry, on a virtual clock (see txStatementCostMs). */
function prismaTimeoutError(timeout, elapsed) {
  const error = new Error(
    `Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was ${timeout} ms, however ${elapsed} ms passed since the start of the transaction.`
  );
  error.name = "PrismaClientKnownRequestError";
  error.code = "P2028";
  return error;
}

function client(tx, inserted = null, clock = null) {
  const log = (name) => {
    calls.push(tx ? `tx.${name}` : name);
    if (clock) {
      clock.elapsed += txStatementCostMs;
      if (clock.elapsed > clock.timeout) throw prismaTimeoutError(clock.timeout, clock.elapsed);
    }
  };
  return {
    class: {
      findFirst: async ({ where, select }) => {
        log("class.findFirst");
        const cls = store.classes[where.id];
        if (!cls || cls.teacherId !== where.teacherId || cls.status !== where.status) return null;
        return pick(cls, select);
      },
    },
    lecture: {
      findMany: async ({ where, select, skip = 0, take, orderBy }) => {
        log("lecture.findMany");
        let rows = sortLectures(store.lectures.filter((row) => lectureMatches(row, where)));
        if (orderBy && !Array.isArray(orderBy) && orderBy.date === "desc") rows = rows.reverse();
        rows = rows.slice(skip, take === undefined ? undefined : skip + take);
        return rows.map((row) => pick(row, select));
      },
      count: async ({ where }) => {
        log("lecture.count");
        return store.lectures.filter((row) => lectureMatches(row, where)).length;
      },
      create: async ({ data, select }) => {
        log("lecture.create");
        if (tx) calls.push(`tx.lecture.create.select:${Object.keys(select).join(",")}`);
        if (createFails) throw Object.assign(new Error("insert failed"), { name: "PrismaClientUnknownRequestError" });
        if (createDelayMs) await new Promise((resolve) => setTimeout(resolve, createDelayMs));
        const row = { id: `new-${String(++lectureSeq).padStart(3, "0")}`, status: 0, classStatus: "SCHEDULED", endDate: null, createdAt: new Date(), ...data };
        store.lectures.push(row);
        inserted?.push(row.id);
        return pick(row, select);
      },
    },
    classStudent: {
      findMany: async ({ where, select }) => {
        log("classStudent.findMany");
        return store.enrolments
          .filter((e) => e.classId === where.classId && store.students.find((s) => s.id === e.studentId)?.teacherId === where.student.teacherId)
          .map((e) => pick(e, select));
      },
    },
    student: {
      findMany: async ({ where, select }) => {
        log("student.findMany");
        return store.students.filter((s) => where.id.in.includes(s.id) && s.teacherId === where.teacherId).map((s) => pick(s, select));
      },
    },
    lectureAttendance: {
      findMany: async ({ where, select }) => {
        log("lectureAttendance.findMany");
        return store.records.filter((r) => r.classId === where.classId && where.lectureId.in.includes(r.lectureId)).map((r) => pick(r, select));
      },
    },
    lectureAttendanceRegister: {
      findMany: async ({ where, select }) => {
        log("lectureAttendanceRegister.findMany");
        return store.registers.filter((r) => where.lectureId.in.includes(r.lectureId)).map((r) => pick(r, select));
      },
    },
    lectureQrAttendanceClosure: {
      findMany: async ({ where, select }) => {
        log("lectureQrAttendanceClosure.findMany");
        return store.closures.filter((r) => where.lectureId.in.includes(r.lectureId)).map((r) => pick(r, select));
      },
    },
  };
}

const fakePrisma = {
  ...client(false),
  $transaction: async (fn, options) => {
    calls.push("$transaction");
    transactionOptions.push(options);
    const inserted = [];
    const held = [];
    // Prisma's defaults when no options are given: timeout 5000 ms.
    const clock = { elapsed: 0, timeout: options?.timeout ?? 5_000 };
    const tx = {
      ...client(true, inserted, clock),
      $executeRaw: async (strings, ...values) => {
        const sql = strings.join("?");
        calls.push(`tx.$executeRaw:${sql}`);
        clock.elapsed += txStatementCostMs;
        if (clock.elapsed > clock.timeout) throw prismaTimeoutError(clock.timeout, clock.elapsed);
        assert.match(
          sql,
          /^SELECT pg_advisory_xact_lock\(hashtextextended\(\?, 0\)\) FROM \(SELECT set_config\('lock_timeout', '8000ms', true\) OFFSET 0\) AS bounded$/
        );
        if (lockTimesOut) {
          const error = new Error("Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`");
          error.name = "PrismaClientKnownRequestError";
          error.code = "P2010";
          error.meta = { code: "55P03" };
          throw error;
        }
        held.push(await acquire(values[0]));
        calls.push(`lock:${values[0]}`);
        return 1;
      },
    };
    try {
      const result = await fn(tx);
      calls.push("commit");
      return result;
    } catch (error) {
      calls.push("rollback");
      store.lectures = store.lectures.filter((row) => !inserted.includes(row.id)); // rollback: only this transaction's rows
      throw error;
    } finally {
      held.forEach((release) => release()); // the transaction-scoped locks end with it
    }
  },
};

fake("lib/prisma.ts", { prisma: fakePrisma });
fake("lib/session-events.ts", {
  emitStudentDataChange: (event) => {
    calls.push("event");
    emitted.push(event);
  },
  emitLiveChange: () => {},
});
fake("services/fee-waiver-events.ts", { readLectureWaiverState: async () => null, recalculateAfterLectureChange: async () => {} });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    calls.push("session");
    if (!currentSession) {
      const { AppError } = require(path.join(root, "lib", "error-handler.ts"));
      throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    }
    return { teacherId: currentSession.teacherId, role: "TEACHER" };
  },
});

const serverLogger = require(path.join(root, "lib", "error-logging", "server-logger.ts"));
serverLogger.setErrorLogSinkForTests({ write: async () => {}, writeSync: () => {}, flush: async () => {} });

const M = require(path.join(root, "services", "class-attendance-matrix-service.ts"));
const CREATE = require(path.join(root, "services", "attendance-lecture-create-service.ts"));
const matrixRoute = require(path.join(root, "app", "api", "classes", "[id]", "attendance-matrix", "route.ts"));
const createRoute = require(path.join(root, "app", "api", "classes", "[id]", "attendance-lectures", "route.ts"));
const lecturesRoute = require(path.join(root, "app", "api", "lectures", "route.ts"));
const { classMonthLecturesQuery } = require(path.join(root, "components", "attendance", "attendance-ui.ts"));

const ctx = (id) => ({ params: { id } });
const json = async (response) => ({ status: response.status, headers: response.headers, body: await response.json() });
const getMatrix = (classId, month) =>
  matrixRoute.GET(new Request(`${APP_ORIGIN}/api/classes/${classId}/attendance-matrix${month === undefined ? "" : `?month=${month}`}`), ctx(classId)).then(json);
const SAME_ORIGIN = { Origin: APP_ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
const postLecture = (classId, body, headers = SAME_ORIGIN) =>
  createRoute
    .POST(
      new Request(`${APP_ORIGIN}/api/classes/${classId}/attendance-lectures`, {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      ctx(classId)
    )
    .then(json);

function assertNoStore(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
}

const dataCalls = () => calls.filter((c) => c !== "session" && !c.startsWith("lock:"));

// =========================================================================================================
// Month helpers
// =========================================================================================================

test("month: YYYY-MM parsed; absent = the current Sri Lankan month (Colombo, not UTC); bad values refused", () => {
  // 30 Nov 18:30 UTC is already 1 Dec in Colombo.
  assert.deepEqual(M.parseMatrixMonth(null, new Date("2026-11-30T18:30:00.000Z")), { year: 2026, month: 12 });
  assert.deepEqual(M.parseMatrixMonth("", new Date("2026-11-30T18:29:59.999Z")), { year: 2026, month: 11 });
  assert.deepEqual(M.parseMatrixMonth("2026-02", new Date()), { year: 2026, month: 2 });
  for (const bad of ["2026-13", "2026-00", "26-01", "2026-1", "1999-12", "2101-01", "abc", "2026-01-01"]) {
    assert.equal(M.parseMatrixMonth(bad, new Date()), null, bad);
  }
  assert.deepEqual(M.shiftMonth({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 });
  assert.deepEqual(M.shiftMonth({ year: 2026, month: 1 }, -1), { year: 2025, month: 12 });
  const range = M.colomboMonthRange({ year: 2026, month: 11 });
  assert.equal(range.start.toISOString(), "2026-10-31T18:30:00.000Z");
  assert.equal(range.end.toISOString(), "2026-11-30T18:30:00.000Z");
});

// =========================================================================================================
// Matrix
// =========================================================================================================

function seedMonth() {
  resetStore();
  const before = lecture({ title: "Before (Oct, Colombo)", date: sl("2026-10-31T23:59") });
  const l1 = lecture({ title: "Kinematics", date: sl("2026-11-02T09:00"), endDate: sl("2026-11-02T11:00") });
  const l2 = lecture({ title: "Dynamics", date: sl("2026-11-09T09:00"), endDate: sl("2026-11-09T11:00") });
  const l3 = lecture({ title: "Cancelled", date: sl("2026-11-16T09:00"), classStatus: "CANCELLED" });
  const l4 = lecture({ title: "Month end", date: sl("2026-11-30T23:59") });
  const after = lecture({ title: "After (Dec, Colombo)", date: sl("2026-12-01T00:00") });
  lecture({ title: "Deleted", date: sl("2026-11-03T09:00"), status: 1 });
  lecture({ title: "Other class", date: sl("2026-11-03T09:00"), classId: C2 });

  student("s-amal", { name: "Amal", enrol: [[sl("2026-09-01T00:00"), null]] });
  student("s-bimal", { name: "Bimal", enrol: [[sl("2026-11-05T12:00"), null]] }); // joined after l1
  student("s-chamari", { name: "Chamari", enrol: [[sl("2026-09-01T00:00"), sl("2026-11-10T00:00")]] }); // removed after l2
  student("s-old", { name: "Old", enrol: [[sl("2025-01-01T00:00"), sl("2025-06-01T00:00")]] }); // not in this month
  student("s-other-teacher", { name: "Other", teacherId: T2, enrol: [[sl("2026-09-01T00:00"), null]] });

  store.registers.push(
    { lectureId: l1.id, classId: C1, scheduledStartAt: l1.date, graceMinutes: 10, finalizedAt: sl("2026-11-02T12:00") },
    { lectureId: l2.id, classId: C1, scheduledStartAt: l2.date, graceMinutes: 15, finalizedAt: null }
  );
  store.closures.push({ lectureId: l1.id, classId: C1 });
  store.records.push(
    { lectureId: l1.id, classId: C1, studentId: "s-amal", status: "PRESENT", firstQrAt: sl("2026-11-02T09:05"), firstOnlineAt: sl("2026-11-02T09:03"), pendingReviewSince: null },
    { lectureId: l2.id, classId: C1, studentId: "s-amal", status: "LATE", firstQrAt: sl("2026-11-09T09:40"), firstOnlineAt: null, pendingReviewSince: null },
    { lectureId: l2.id, classId: C1, studentId: "s-chamari", status: "ABSENT", firstQrAt: null, firstOnlineAt: null, pendingReviewSince: sl("2026-11-09T12:00") },
    { lectureId: l1.id, classId: C1, studentId: "s-chamari", status: "EXCUSED", firstQrAt: null, firstOnlineAt: null, pendingReviewSince: null },
    { lectureId: before.id, classId: C1, studentId: "s-old", status: "PRESENT", firstQrAt: before.date, firstOnlineAt: null, pendingReviewSince: null }
  );
  return { before, l1, l2, l3, l4, after };
}

test("matrix: columns are the month's actual lectures (Colombo month bounds, oldest first); not schedules, deleted lectures or other classes", async () => {
  const { l1, l2, l3, l4 } = seedMonth();
  const matrix = await M.getClassAttendanceMatrixForTeacher({ teacherId: T1, classId: C1, month: { year: 2026, month: 11 } });
  assert.deepEqual(matrix.lectures.map((l) => l.id), [l1.id, l2.id, l3.id, l4.id]);
  assert.deepEqual(matrix.month, { year: 2026, month: 11, key: "2026-11", previous: "2026-10", next: "2026-12" });
  assert.deepEqual(matrix.class, { id: C1, name: "Physics", attendanceGraceMinutes: 10 });
  assert.deepEqual(matrix.schedules.map((s) => s.id), ["s-mon-1", "s-mon-2", "s-fri"], "weekly schedules for the dialog, weekday then time");
  assert.deepEqual(matrix.lectures[0].register, { finalized: true, finalizedAt: sl("2026-11-02T12:00").toISOString(), graceMinutes: 10 });
  assert.equal(matrix.lectures[0].qrClosed, true);
  assert.deepEqual(matrix.lectures[1].register, { finalized: false, finalizedAt: null, graceMinutes: 15 });
  assert.equal(matrix.lectures[2].register, null);
  assert.equal(matrix.lectures[2].classStatus, "CANCELLED");
});

test("matrix: cells show the stored record (status, earliest evidence time, review) or the register state; ABSENT is never inferred", async () => {
  const { l1, l2, l3, l4 } = seedMonth();
  const matrix = await M.getClassAttendanceMatrixForTeacher({ teacherId: T1, classId: C1, month: { year: 2026, month: 11 } });
  assert.deepEqual(matrix.students.map((s) => s.name), ["Amal", "Bimal", "Chamari"], "this teacher's students enrolled during the month, by name");
  const [amal, bimal, chamari] = matrix.students;
  const ix = (lecture) => matrix.lectures.findIndex((l) => l.id === lecture.id);

  assert.deepEqual(amal.cells[ix(l1)], { state: "RECORD", status: "PRESENT", attendedAt: sl("2026-11-02T09:03").toISOString(), pendingReview: false }, "earliest of QR and online");
  assert.deepEqual(amal.cells[ix(l2)], { state: "RECORD", status: "LATE", attendedAt: sl("2026-11-09T09:40").toISOString(), pendingReview: false }, "LATE as stored by the grace rule");
  assert.equal(amal.cells[ix(l3)].state, "LECTURE_CANCELLED");
  assert.equal(amal.cells[ix(l4)].state, "NOT_RECORDED_YET", "no register: not recorded yet");

  assert.equal(bimal.cells[ix(l1)].state, "NOT_ENROLLED", "joined after the lecture");
  assert.equal(bimal.cells[ix(l2)].state, "NOT_RECORDED_YET", "open register, no record: never ABSENT");
  assert.equal(bimal.cells[ix(l2)].status, null);

  assert.deepEqual(chamari.cells[ix(l1)], { state: "RECORD", status: "EXCUSED", attendedAt: null, pendingReview: false });
  assert.deepEqual(chamari.cells[ix(l2)], { state: "RECORD", status: "ABSENT", attendedAt: null, pendingReview: true });
  assert.equal(chamari.cells[ix(l4)].state, "NOT_ENROLLED", "removed before the lecture");
  assert.equal(chamari.enrolled, false, "flagged as removed, still shown");
  assert.equal(amal.enrolled, true);
  assert.equal(amal.active, true);
});

test("matrix: a finalized register without a record is NO_RECORD; with a record the record wins", async () => {
  const { l1 } = seedMonth();
  student("s-dinesh", { name: "Dinesh", enrol: [[sl("2026-09-01T00:00"), null]] });
  const matrix = await M.getClassAttendanceMatrixForTeacher({ teacherId: T1, classId: C1, month: { year: 2026, month: 11 } });
  const dinesh = matrix.students.find((s) => s.id === "s-dinesh");
  assert.equal(dinesh.cells[matrix.lectures.findIndex((l) => l.id === l1.id)].state, "NO_RECORD");
});

test("matrix: a student with a record in the month is shown even without an overlapping enrolment row", async () => {
  seedMonth();
  const { l2 } = { l2: store.lectures.find((l) => l.title === "Dynamics") };
  student("s-legacy", { name: "Legacy" }); // no enrolment row at all
  store.records.push({ lectureId: l2.id, classId: C1, studentId: "s-legacy", status: "PRESENT", firstQrAt: l2.date, firstOnlineAt: null, pendingReviewSince: null });
  const matrix = await M.getClassAttendanceMatrixForTeacher({ teacherId: T1, classId: C1, month: { year: 2026, month: 11 } });
  const legacy = matrix.students.find((s) => s.id === "s-legacy");
  assert.ok(legacy);
  assert.equal(legacy.cells[matrix.lectures.findIndex((l) => l.id === l2.id)].status, "PRESENT");
});

test("matrix: ownership: another teacher's, a deleted or an unknown class is 404 CLASS_NOT_FOUND, and nothing else is read", async () => {
  seedMonth();
  for (const [teacherId, classId] of [[T1, C2], [T1, C_DELETED], [T1, "44444444-4444-4444-8444-444444444444"], [T2, C1]]) {
    calls = [];
    await assert.rejects(M.getClassAttendanceMatrixForTeacher({ teacherId, classId, month: { year: 2026, month: 11 } }), (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "CLASS_NOT_FOUND");
      return true;
    });
    assert.deepEqual(calls, ["class.findFirst"]);
  }
});

test("matrix: a fixed number of queries (7) whatever the number of students and lectures; read only; 4 when the month has no lectures", async () => {
  const counts = [];
  for (const size of [1, 40]) {
    resetStore();
    for (let i = 0; i < size; i += 1) {
      const l = lecture({ date: sl(`2026-11-${String((i % 28) + 1).padStart(2, "0")}T${String(6 + (i % 12)).padStart(2, "0")}:00`) });
      store.registers.push({ lectureId: l.id, classId: C1, scheduledStartAt: l.date, graceMinutes: 10, finalizedAt: null });
    }
    for (let i = 0; i < size * 5; i += 1) student(`s-${i}`, { enrol: [[sl("2026-09-01T00:00"), null]] });
    const before = JSON.stringify(store);
    calls = [];
    const matrix = await M.getClassAttendanceMatrixForTeacher({ teacherId: T1, classId: C1, month: { year: 2026, month: 11 } });
    assert.equal(matrix.lectures.length, size);
    assert.equal(matrix.students.length, size * 5);
    counts.push(calls.length);
    assert.equal(JSON.stringify(store), before, "nothing written");
    assert.ok(!calls.some((c) => /create|update|delete|\$transaction|\$executeRaw/.test(c)));
  }
  assert.deepEqual(counts, [7, 7]);
  assert.deepEqual(calls.slice().sort(), [
    "class.findFirst", "classStudent.findMany", "lecture.findMany", "lectureAttendance.findMany",
    "lectureAttendanceRegister.findMany", "lectureQrAttendanceClosure.findMany", "student.findMany",
  ]);

  resetStore();
  student("s-1", { enrol: [[sl("2026-09-01T00:00"), null]] });
  calls = [];
  const empty = await M.getClassAttendanceMatrixForTeacher({ teacherId: T1, classId: C1, month: { year: 2026, month: 11 } });
  assert.deepEqual(empty.lectures, []);
  assert.equal(calls.length, 4, "no record / register / closure query without lectures");
});

test("GET /api/classes/[id]/attendance-matrix: 401 without a session; 400 bad id / month; 404 not owned; no-store; current month by default", async (t) => {
  seedMonth();
  currentSession = null;
  const unauth = await getMatrix(C1, "2026-11");
  assert.equal(unauth.status, 401);
  assertNoStore(unauth);

  currentSession = { teacherId: T1 };
  const badId = await getMatrix("not-a-uuid", "2026-11");
  assert.equal(badId.status, 400);
  assert.equal(badId.body.error.code, "VALIDATION_ERROR");
  const badMonth = await getMatrix(C1, "2026-13");
  assert.equal(badMonth.status, 400);
  const other = await getMatrix(C2, "2026-11");
  assert.equal(other.status, 404);
  assert.equal(other.body.error.code, "CLASS_NOT_FOUND");
  assertNoStore(other);

  const ok = await getMatrix(C1, "2026-11");
  assert.equal(ok.status, 200);
  assertNoStore(ok);
  assert.equal(ok.body.data.month.key, "2026-11");
  assert.equal(ok.body.data.lectures.length, 4);

  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-30T18:30:00.000Z") }); // 1 Dec in Colombo
  const current = await getMatrix(C1);
  t.mock.timers.reset();
  assert.equal(current.body.data.month.key, "2026-12");
  assert.deepEqual(current.body.data.lectures.map((l) => l.title), ["After (Dec, Colombo)"]);
});

// =========================================================================================================
// Lecture creation with duplicate protection
// =========================================================================================================

const input = (over = {}) => ({ classId: C1, title: "Physics – 23 Nov 2026", date: sl("2026-11-23T09:00"), endDate: sl("2026-11-23T11:00"), allowAdditionalSession: false, ...over });

test("create: the existing createLectureForTeacher inside one transaction, after the advisory lock on (class, Colombo day); event after commit", async () => {
  resetStore();
  const created = await CREATE.createAttendanceLectureForTeacher(T1, input());
  assert.equal(created.title, "Physics – 23 Nov 2026");
  assert.equal(created.date.toISOString(), sl("2026-11-23T09:00").toISOString());
  assert.equal(created.class.id, C1, "the existing service's response shape");
  assert.deepEqual(dataCalls(), [
    "$transaction",
    "tx.$executeRaw:SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) FROM (SELECT set_config('lock_timeout', '8000ms', true) OFFSET 0) AS bounded",
    "tx.lecture.findMany",
    "tx.class.findFirst", // createLectureForTeacher's ownership check, on the transaction
    "tx.lecture.create",
    "tx.lecture.create.select:id,title,date,endDate,classStatus,createdAt", // one INSERT ... RETURNING: no re-read of the lecture or its class
    "commit",
    "event", // after the commit
  ]);
  assert.deepEqual(transactionOptions, [{ maxWait: 5_000, timeout: 15_000 }]);
  assert.ok(calls.includes(`lock:attendance-lecture:${C1}:2026-11-23`));
  assert.deepEqual(emitted, [{ classId: C1 }], "one live update, after the commit");
  assert.equal(store.lectures.length, 1);
});

test("create: the lock key is the Sri Lankan day (a 00:30 Colombo start belongs to that day, not the UTC one)", async () => {
  resetStore();
  await CREATE.createAttendanceLectureForTeacher(T1, input({ date: sl("2026-11-24T00:30"), endDate: null }));
  assert.ok(calls.includes(`lock:attendance-lecture:${C1}:2026-11-24`), calls.join("\n"));
});

test("create: an overlapping lecture on the same day is 409 ATTENDANCE_LECTURE_EXISTS and nothing is created or emitted", async () => {
  resetStore();
  const existing = lecture({ title: "Already there", date: sl("2026-11-23T09:00"), endDate: sl("2026-11-23T11:00") });
  for (const over of [
    {}, // same start
    { date: sl("2026-11-23T10:00"), endDate: sl("2026-11-23T12:00") }, // overlaps
    { date: sl("2026-11-23T08:00"), endDate: sl("2026-11-23T09:00") }, // touches the start
    { date: sl("2026-11-23T09:00"), endDate: null }, // same start, no end
  ]) {
    emitted = [];
    await assert.rejects(CREATE.createAttendanceLectureForTeacher(T1, input(over)), (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "ATTENDANCE_LECTURE_EXISTS");
      assert.deepEqual(error.details.lectures, [
        { id: existing.id, title: "Already there", date: existing.date.toISOString(), endDate: existing.endDate.toISOString() },
      ]);
      return true;
    });
    assert.equal(store.lectures.length, 1);
    assert.deepEqual(emitted, []);
  }
});

test("create: legitimate sessions are never blocked: another time of day, another day, another class, a cancelled or deleted lecture", async () => {
  resetStore();
  lecture({ title: "Morning", date: sl("2026-11-23T09:00"), endDate: sl("2026-11-23T11:00") });
  lecture({ title: "Cancelled", date: sl("2026-11-23T14:00"), endDate: sl("2026-11-23T16:00"), classStatus: "CANCELLED" });
  lecture({ title: "Deleted", date: sl("2026-11-23T17:00"), endDate: sl("2026-11-23T18:00"), status: 1 });
  lecture({ title: "Other class", date: sl("2026-11-23T19:00"), classId: C2 });
  const created = [];
  created.push(await CREATE.createAttendanceLectureForTeacher(T1, input({ date: sl("2026-11-23T11:30"), endDate: sl("2026-11-23T12:30") })));
  created.push(await CREATE.createAttendanceLectureForTeacher(T1, input({ date: sl("2026-11-23T14:00"), endDate: sl("2026-11-23T16:00") })));
  created.push(await CREATE.createAttendanceLectureForTeacher(T1, input({ date: sl("2026-11-23T17:00"), endDate: sl("2026-11-23T18:00") })));
  created.push(await CREATE.createAttendanceLectureForTeacher(T1, input({ date: sl("2026-11-23T19:00"), endDate: null })));
  created.push(await CREATE.createAttendanceLectureForTeacher(T1, input({ date: sl("2026-11-24T09:00") })));
  assert.equal(created.length, 5);
});

test("create: an explicitly confirmed additional session is created despite the overlap", async () => {
  resetStore();
  lecture({ title: "Already there", date: sl("2026-11-23T09:00"), endDate: sl("2026-11-23T11:00") });
  const created = await CREATE.createAttendanceLectureForTeacher(T1, input({ allowAdditionalSession: true }));
  assert.ok(created.id);
  assert.equal(store.lectures.length, 2);
});

test("create: concurrent requests are serialized by the lock: exactly one lecture, the other gets 409", async () => {
  resetStore();
  createDelayMs = 25; // the first insert is slow: without the lock both checks would see no lecture
  const results = await Promise.allSettled([
    CREATE.createAttendanceLectureForTeacher(T1, input()),
    CREATE.createAttendanceLectureForTeacher(T1, input()),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.equal(rejected.reason.code, "ATTENDANCE_LECTURE_EXISTS");
  assert.equal(store.lectures.length, 1);
  assert.deepEqual(emitted, [{ classId: C1 }]);
});

test("create: another teacher's or a deleted class is 404 CLASS_NOT_FOUND (existing ownership check); the other teacher's lectures are never reported", async () => {
  resetStore();
  lecture({ title: "Chemistry lecture", classId: C2, date: sl("2026-11-23T09:00"), endDate: sl("2026-11-23T11:00") });
  for (const classId of [C2, C_DELETED]) {
    await assert.rejects(CREATE.createAttendanceLectureForTeacher(T1, input({ classId })), (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "CLASS_NOT_FOUND");
      return true;
    });
  }
  assert.equal(store.lectures.length, 1);
  assert.deepEqual(emitted, []);
});

test("create: overlap rule (closed intervals; no end = the start instant)", () => {
  const at = (wall) => sl(`2026-11-23T${wall}`);
  const o = CREATE.lectureTimesOverlap;
  assert.equal(o({ date: at("09:00"), endDate: at("11:00") }, { date: at("11:00"), endDate: at("12:00") }), true);
  assert.equal(o({ date: at("09:00"), endDate: at("11:00") }, { date: at("11:01"), endDate: null }), false);
  assert.equal(o({ date: at("09:00"), endDate: null }, { date: at("09:00"), endDate: null }), true);
  assert.equal(o({ date: at("09:00"), endDate: null }, { date: at("08:00"), endDate: at("10:00") }), true);
});

test("POST /api/classes/[id]/attendance-lectures: same-origin first (403, no session read), then 401, then the body", async () => {
  resetStore();
  const body = { title: "Physics", date: "2026-11-23T09:00", endDate: "2026-11-23T11:00" };
  for (const headers of [{}, { Origin: "https://evil.example" }, { Origin: APP_ORIGIN, "Sec-Fetch-Site": "cross-site" }]) {
    calls = [];
    const res = await postLecture(C1, body, headers);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "CROSS_ORIGIN_REQUEST_REJECTED");
    assertNoStore(res);
    assert.deepEqual(calls, [], "neither the session nor the database is reached");
  }
  currentSession = null;
  const unauth = await postLecture(C1, body);
  assert.equal(unauth.status, 401);
  assert.equal(store.lectures.length, 0);
});

test("POST /api/classes/[id]/attendance-lectures: the existing lecture validation (Sri Lankan times, end after start, 12 h); class from the path", async () => {
  resetStore();
  const bad = [
    [{ title: "P", date: "2026-11-23T09:00" }, "Lecture title must be at least 2 characters long."],
    [{ title: "Physics", date: "2026-02-30T09:00" }, null],
    [{ title: "Physics", date: "2026-11-23T09:00", endDate: "2026-11-23T09:00" }, "The end time must be after the start time."],
    [{ title: "Physics", date: "2026-11-23T09:00", endDate: "2026-11-23T22:00" }, null],
    [{ title: "Physics", date: "2026-11-23T09:00", allowAdditionalSession: "yes" }, "allowAdditionalSession must be true or false."],
    [[], null],
  ];
  for (const [body, message] of bad) {
    const res = await postLecture(C1, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, "VALIDATION_ERROR");
    if (message) assert.equal(res.body.error.message, message);
  }
  const notJson = await postLecture(C1, "{");
  assert.equal(notJson.status, 400);
  assert.equal(notJson.body.error.code, "INVALID_JSON");
  const badId = await postLecture("not-a-uuid", { title: "Physics", date: "2026-11-23T09:00" });
  assert.equal(badId.status, 400);
  assert.equal(store.lectures.length, 0);

  // A classId in the body is ignored: the path decides (another teacher's class in the body cannot be targeted).
  const ok = await postLecture(C1, { classId: C2, title: "Physics", date: "2026-11-23T09:00", endDate: "2026-11-23T11:00" });
  assert.equal(ok.status, 201);
  assertNoStore(ok);
  assert.equal(ok.body.data.lecture.date, sl("2026-11-23T09:00").toISOString(), "read as Sri Lankan time");
  assert.equal(store.lectures[0].classId, C1);
});

test("POST /api/classes/[id]/attendance-lectures: 409 with the existing lecture, then 201 only with allowAdditionalSession: true; 404 for another teacher's class", async () => {
  resetStore();
  const body = { title: "Physics", date: "2026-11-23T09:00", endDate: "2026-11-23T11:00" };
  assert.equal((await postLecture(C1, body)).status, 201);
  const duplicate = await postLecture(C1, body);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "ATTENDANCE_LECTURE_EXISTS");
  assert.equal(duplicate.body.error.details.lectures.length, 1);
  assert.equal(store.lectures.length, 1);
  const additional = await postLecture(C1, { ...body, allowAdditionalSession: true });
  assert.equal(additional.status, 201);
  assert.equal(store.lectures.length, 2);
  const other = await postLecture(C2, body);
  assert.equal(other.status, 404);
  assert.equal(other.body.error.code, "CLASS_NOT_FOUND");
});

test("nothing new is persisted beyond the Lecture row: no hidden lecture, no attendance or schedule rows", async () => {
  resetStore();
  const before = { records: store.records.length, registers: store.registers.length, schedules: JSON.stringify(store.schedules) };
  await postLecture(C1, { title: "Physics", date: "2026-11-23T09:00" });
  await getMatrix(C1, "2026-11");
  assert.equal(store.lectures.length, 1);
  assert.equal(store.records.length, before.records);
  assert.equal(store.registers.length, before.registers);
  assert.equal(JSON.stringify(store.schedules), before.schedules);
});

// =========================================================================================================
// Transaction timeout (P2028 on the remote, pooled database)
// =========================================================================================================

const SLOW = 1_400; // virtual ms per statement: measured at a 700 ms round trip on real PostgreSQL

test("the fake enforces Prisma's 5 s default: 4 slow statements without options expire (P2028), as in production", async () => {
  resetStore();
  txStatementCostMs = SLOW;
  await assert.rejects(
    fakePrisma.$transaction(async (tx) => {
      await tx.lecture.findMany({ where: {}, select: { id: true } });
      await tx.lecture.findMany({ where: {}, select: { id: true } });
      await tx.lecture.findMany({ where: {}, select: { id: true } });
      await tx.lecture.findMany({ where: {}, select: { id: true } });
    }),
    (error) => error.code === "P2028"
  );
});

test("create: succeeds when the transaction takes longer than 5 s (15 s timeout, 5 s maxWait); event once, after the commit", async () => {
  resetStore();
  txStatementCostMs = SLOW; // 4 statements = 5.6 s of transaction time
  const created = await CREATE.createAttendanceLectureForTeacher(T1, input());
  assert.ok(created.id);
  assert.deepEqual(transactionOptions, [{ maxWait: 5_000, timeout: 15_000 }]);
  assert.equal(store.lectures.length, 1);
  assert.deepEqual(emitted, [{ classId: C1 }]);
  assert.ok(calls.indexOf("event") > calls.indexOf("commit"), "the event follows the commit");
  const inTx = calls.slice(calls.indexOf("$transaction"), calls.indexOf("commit")).filter((c) => /^tx\.[a-zA-Z$]+(\.[a-zA-Z]+)?(:|$)/.test(c) && !c.includes(".select:"));
  assert.equal(inTx.length, 4, `4 statements inside the lock: ${inTx.join(", ")}`);
});

test("create (slow transactions): concurrent overlapping requests still create exactly one lecture; the other gets 409", async () => {
  resetStore();
  txStatementCostMs = SLOW;
  createDelayMs = 25;
  const results = await Promise.allSettled([CREATE.createAttendanceLectureForTeacher(T1, input()), CREATE.createAttendanceLectureForTeacher(T1, input())]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "ATTENDANCE_LECTURE_EXISTS");
  assert.equal(store.lectures.length, 1);
  assert.deepEqual(emitted, [{ classId: C1 }], "the refused request emits nothing");
});

test("create (slow transactions): a duplicate is still 409 and an explicitly confirmed additional session is still created", async () => {
  resetStore();
  txStatementCostMs = SLOW;
  await CREATE.createAttendanceLectureForTeacher(T1, input());
  emitted = [];
  await assert.rejects(CREATE.createAttendanceLectureForTeacher(T1, input()), (error) => error.statusCode === 409 && error.code === "ATTENDANCE_LECTURE_EXISTS");
  assert.deepEqual(emitted, []);
  const additional = await CREATE.createAttendanceLectureForTeacher(T1, input({ allowAdditionalSession: true }));
  assert.ok(additional.id);
  assert.equal(store.lectures.length, 2);
  assert.deepEqual(emitted, [{ classId: C1 }]);
});

test("create: a lock wait beyond lock_timeout (P2010 / 55P03) is 409 ATTENDANCE_BUSY; nothing created, no event", async () => {
  resetStore();
  lockTimesOut = true;
  await assert.rejects(CREATE.createAttendanceLectureForTeacher(T1, input()), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "ATTENDANCE_BUSY");
    return true;
  });
  assert.equal(store.lectures.length, 0);
  assert.deepEqual(emitted, []);
  assert.ok(calls.includes("rollback"));

  const res = await postLecture(C1, { title: "Physics", date: "2026-11-23T09:00" });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "ATTENDANCE_BUSY");
});

test("create: a failed transaction (database error on INSERT) is rolled back and dispatches no event; the route answers 500", async () => {
  resetStore();
  createFails = true;
  await assert.rejects(CREATE.createAttendanceLectureForTeacher(T1, input()), /insert failed/);
  assert.equal(store.lectures.length, 0);
  assert.deepEqual(emitted, []);
  assert.ok(calls.includes("rollback"));
  assert.ok(!calls.includes("event"));

  emitted = [];
  const res = await postLecture(C1, { title: "Physics", date: "2026-11-23T09:00" });
  assert.equal(res.status, 500);
  assert.deepEqual(emitted, []);
});

test("the lock_timeout in the SQL is ATTENDANCE_LECTURE_LOCK_TIMEOUT_MS and stays well inside the transaction timeout", () => {
  const source = require("node:fs").readFileSync(path.join(root, "services", "attendance-lecture-create-service.ts"), "utf8");
  assert.ok(source.includes(`set_config('lock_timeout', '${CREATE.ATTENDANCE_LECTURE_LOCK_TIMEOUT_MS}ms', true)`));
  assert.ok(CREATE.ATTENDANCE_LECTURE_LOCK_TIMEOUT_MS + 4 * SLOW < CREATE.ATTENDANCE_LECTURE_TRANSACTION_OPTIONS.timeout);
  assert.deepEqual(CREATE.ATTENDANCE_LECTURE_TRANSACTION_OPTIONS, { maxWait: 5_000, timeout: 15_000 });
  assert.doesNotMatch(source, /\.\$queryRaw/, "the void lock goes through $executeRaw");
  assert.match(source, /tx\.\$executeRaw`SELECT pg_advisory_xact_lock/);
  // Nothing slow inside the transaction: no event, fetch or e-mail before the commit.
  const body = source.slice(source.indexOf("prisma.$transaction("), source.indexOf("ATTENDANCE_LECTURE_TRANSACTION_OPTIONS);"));
  assert.doesNotMatch(body, /emitStudentDataChange|fetch\(|send[A-Z]\w*\(/);
});

test("createLectureForTeacher with a transaction returns the same shape as without one (class from the in-transaction ownership read)", async () => {
  resetStore();
  const LECTURE_SERVICE = require(path.join(root, "services", "lecture-service.ts"));
  const plain = await LECTURE_SERVICE.createLectureForTeacher(T1, { classId: C1, title: "Plain", date: sl("2026-11-25T09:00"), endDate: null });
  assert.deepEqual(emitted, [{ classId: C1 }], "without a transaction: the event, exactly as before");
  emitted = [];
  const inTx = await fakePrisma.$transaction((tx) => LECTURE_SERVICE.createLectureForTeacher(T1, { classId: C1, title: "Tx", date: sl("2026-11-26T09:00"), endDate: null }, { db: tx }));
  assert.deepEqual(emitted, [], "with a transaction: the caller emits after its commit");
  assert.deepEqual(Object.keys(inTx).sort(), Object.keys(plain).sort());
  assert.deepEqual(inTx.class, plain.class);
  assert.deepEqual(inTx.class, { id: C1, name: "Physics", schedule: "Mon 09:00" });
});

// =========================================================================================================
// The Attendance page's lecture selector: one class, one Sri Lankan month (the existing lecture list)
// =========================================================================================================

/** The selector's month bounds: the matrix's [start, end) as the list's inclusive from / to. */
const selectorMonth = (year, month) => {
  const range = M.colomboMonthRange({ year, month });
  return { from: range.start, to: new Date(range.end.getTime() - 1) };
};
const listLectures = async (classId, month, page = 1) => {
  const res = await lecturesRoute.GET(new Request(`${APP_ORIGIN}/api/lectures?${classMonthLecturesQuery(classId, month, page)}`));
  return { status: res.status, body: await res.json() };
};

test("selector: GET /api/lectures with the month query returns exactly the class's lectures of that Colombo month, oldest first (= the matrix's columns)", async () => {
  const { before, l1, l2, l3, l4, after } = seedMonth();
  const month = selectorMonth(2026, 11);
  assert.equal(month.from.toISOString(), "2026-10-31T18:30:00.000Z");
  assert.equal(month.to.toISOString(), "2026-11-30T18:29:59.999Z");
  const listed = await listLectures(C1, month);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data.map((l) => l.id), [l1.id, l2.id, l3.id, l4.id], "no other month, class or deleted lecture");
  assert.ok(!listed.body.data.some((l) => l.id === before.id || l.id === after.id), "Colombo month boundaries, not UTC");
  const matrix = await M.getClassAttendanceMatrixForTeacher({ teacherId: T1, classId: C1, month: { year: 2026, month: 11 } });
  assert.deepEqual(listed.body.data.map((l) => l.id), matrix.lectures.map((l) => l.id), "the selector and the matrix agree");
  // Ownership is the list's own: another teacher's class is 404.
  assert.equal((await listLectures(C2, month)).status, 404);
});

test("selector: month edges (December → January) and pagination (100 per page, then the next page)", async () => {
  resetStore();
  const dec = lecture({ title: "Last of December", date: sl("2026-12-31T23:59") });
  const jan = lecture({ title: "First of January", date: sl("2027-01-01T00:00") });
  assert.deepEqual((await listLectures(C1, selectorMonth(2026, 12))).body.data.map((l) => l.id), [dec.id]);
  assert.deepEqual((await listLectures(C1, selectorMonth(2027, 1))).body.data.map((l) => l.id), [jan.id]);

  resetStore();
  for (let i = 0; i < 105; i += 1) lecture({ date: new Date(sl("2026-11-01T06:00").getTime() + i * 60 * 60 * 1000) });
  const first = await listLectures(C1, selectorMonth(2026, 11), 1);
  assert.equal(first.body.data.length, 100);
  assert.equal(first.body.pagination.hasNextPage, true);
  const second = await listLectures(C1, selectorMonth(2026, 11), 2);
  assert.equal(second.body.data.length, 5);
  assert.equal(second.body.pagination.hasNextPage, false);
});
