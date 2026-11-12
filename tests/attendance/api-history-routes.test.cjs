/*
 * GET /api/lectures/[id]/attendance/history and
 * GET /api/lectures/[id]/attendance/students/[studentId]/history (Stage
 * 5.6b), in-process with the real routes, history service, error handler and
 * middleware; faked edges: session and Prisma (helpers/attendance-route-env.cjs,
 * the in-memory PostgreSQL model's read-only history queries). A second copy
 * of each route runs against a recording fake of the history service to
 * check the exact arguments. No database; not a PostgreSQL integration test.
 *
 *   npm run test:attendance-api
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { NextRequest } = require("next/server");

const env = require("./helpers/attendance-route-env.cjs");
const { state, reset, student, register, seedRecord, teacherRecord, at, NOW, T1, T2, C2, L1, get, assertNoStore, BAD_IDS, root, APP_ORIGIN } = env;

const registerRoutePath = path.join(root, "app", "api", "lectures", "[id]", "attendance", "history", "route.ts");
const studentRoutePath = path.join(root, "app", "api", "lectures", "[id]", "attendance", "students", "[studentId]", "history", "route.ts");
const registerRoute = require(registerRoutePath);
const studentRoute = require(studentRoutePath);
const { middleware } = require(path.join(root, "middleware.ts"));

test.mock.timers.enable({ apis: ["Date"], now: NOW });

const json = async (response) => ({ status: response.status, body: await response.json(), response });
const REGISTER = (query = "", { id = L1, route = registerRoute } = {}) =>
  route.GET(get(`/api/lectures/${encodeURIComponent(id)}/attendance/history${query}`), { params: { id } });
const STUDENT = (studentId, query = "", { id = L1, route = studentRoute } = {}) =>
  route.GET(get(`/api/lectures/${encodeURIComponent(id)}/attendance/students/${encodeURIComponent(studentId)}/history${query}`), { params: { id, studentId } });

const writesState = () => JSON.stringify([state.pg.committed.registers, state.pg.committed.registerAudits, state.pg.committed.records, state.pg.committed.recordAudits, state.pg.committed.students]);

// ---- Fixtures ------------------------------------------------------------------------------

/** n register audit rows (version 1 = CREATED, the last = FINALIZED when finalized), stored out of order. */
function registerAudits(n, { finalized = false } = {}) {
  const rows = [];
  for (let v = 1; v <= n; v += 1) {
    const action = v === 1 ? "CREATED" : finalized && v === n ? "FINALIZED" : v % 2 === 0 ? "GRACE_CHANGED" : "SCHEDULE_SYNCED";
    rows.push({
      id: `ra-${v}`, lectureId: L1, version: v, action, createdAt: at(v), actorRole: action === "SCHEDULE_SYNCED" ? "SYSTEM" : "TEACHER",
      actorId: action === "SCHEDULE_SYNCED" ? null : T1, reason: action === "GRACE_CHANGED" ? `grace ${v}` : null,
      fromGraceMinutes: action === "GRACE_CHANGED" ? 10 : null, toGraceMinutes: action === "GRACE_CHANGED" ? 15 : action === "CREATED" ? 10 : null,
      fromScheduledStartAt: action === "SCHEDULE_SYNCED" ? at(0) : null, toScheduledStartAt: action === "SCHEDULE_SYNCED" ? at(5) : action === "CREATED" ? at(0) : null,
      fromScheduledEndAt: null, toScheduledEndAt: action === "CREATED" ? at(120) : null,
      finalizedAt: action === "FINALIZED" ? at(150) : null, eligibleCount: action === "FINALIZED" ? 30 : null,
      unknownEligibilityCount: action === "FINALIZED" ? 2 : null, absentCreatedCount: action === "FINALIZED" ? 4 : null,
      recalculatedCount: action === "SCHEDULE_SYNCED" ? 3 : null, secretField: "never-returned",
    });
  }
  state.pg.committed.registerAudits.push(...rows.reverse());
  state.pg.committed.registers[L1].version = n;
}

/** A record for the student with n audit rows (TEACHER_SET then alternating changes). */
function recordWithAudits(studentId, n) {
  seedRecord(studentId, teacherRecord("PRESENT", { version: n }));
  const rec = state.pg.committed.records[`${L1}:${studentId}`];
  state.pg.committed.recordAudits = state.pg.committed.recordAudits.filter((a) => a.lectureAttendanceId !== rec.id);
  for (let v = 1; v <= n; v += 1) {
    const evidence = v % 3 === 2;
    state.pg.committed.recordAudits.push({
      id: `audit-${studentId}-${v}`, lectureAttendanceId: rec.id, version: v, lectureId: L1, studentId,
      action: v === 1 ? "TEACHER_SET" : evidence ? "EVIDENCE_RECORDED" : "TEACHER_SET",
      fromStatus: v === 1 ? null : "ABSENT", toStatus: v === 1 ? "ABSENT" : evidence ? "ABSENT" : "PRESENT",
      fromTeacherStatus: v === 1 ? null : "ABSENT", toTeacherStatus: v === 1 || evidence ? "ABSENT" : "PRESENT",
      fromAutoStatus: null, toAutoStatus: evidence ? "LATE" : null,
      actorRole: evidence ? "SYSTEM" : "TEACHER", actorId: evidence ? null : T1, reason: v === 1 || evidence ? null : `reason ${v}`,
      afterFinalization: false, scanEventId: evidence ? `scan-${v}` : null, attendanceVisitId: null, registerAuditId: null, createdAt: at(10 + v),
    });
  }
  return rec;
}

function fixture() {
  reset();
  student("s1");
  student("s-inactive", { status: 1 });
  student("s-deleted", { status: 2 });
  student("s-other", { teacherId: T2, classId: C2 });
  register();
}

const ROW_ID = /"(ra-\d+|audit-[^"]+|rec-[^"]+|seed-[^"]+|scan-\d+)"/;

// ======================================================================================
// Register history
// ======================================================================================

test("register history: first page (default 50), oldest first; the mapped contract; no row or teacher ids; no-store", async () => {
  fixture();
  registerAudits(60, { finalized: true });
  state.pg.committed.qrClosures[L1] = { lectureId: L1, classId: "class-1", closedAt: at(100), closedByTeacherId: T1 };
  const { status, body, response } = await json(await REGISTER());
  assert.equal(status, 200, JSON.stringify(body));
  assertNoStore(assert, response);
  const data = body.data;
  assert.deepEqual(Object.keys(data).sort(), ["entries", "lectureId", "nextCursor", "qrClosure", "registerExists", "registerVersion"]);
  assert.deepEqual([data.lectureId, data.registerExists, data.registerVersion, data.entries.length, data.nextCursor], [L1, true, 60, 50, "50"]);
  assert.deepEqual(data.entries.map((e) => e.version), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.deepEqual(data.qrClosure, { closedAt: at(100).toISOString(), actor: { role: "TEACHER", isCurrentTeacher: true } });
  assert.deepEqual(data.entries[0], {
    version: 1, action: "CREATED", at: at(1).toISOString(), actor: { role: "TEACHER", isCurrentTeacher: true }, reason: null,
    graceMinutes: { from: null, to: 10 }, scheduledStartAt: { from: null, to: at(0).toISOString() }, scheduledEndAt: { from: null, to: at(120).toISOString() },
    finalization: null, recalculatedCount: null,
  });
  assert.deepEqual(data.entries[2].actor, { role: "SYSTEM", isCurrentTeacher: false });
  assert.equal(data.entries[2].recalculatedCount, 3);
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, ROW_ID);
  for (const secret of [T1, "never-returned", "closedByTeacherId", "actorId"]) assert.ok(!text.includes(secret), secret);
});

test("register history: the next page with the cursor; every entry exactly once; the last page has nextCursor null", async () => {
  fixture();
  registerAudits(60, { finalized: true });
  const first = (await json(await REGISTER())).body.data;
  const second = await json(await REGISTER(`?cursor=${first.nextCursor}`));
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.data.entries.map((e) => e.version), Array.from({ length: 10 }, (_, i) => i + 51));
  assert.equal(second.body.data.nextCursor, null);
  const finalized = second.body.data.entries.at(-1);
  assert.deepEqual([finalized.action, finalized.finalization], ["FINALIZED", { finalizedAt: at(150).toISOString(), eligibleCount: 30, unknownEligibilityCount: 2, absentCreatedCount: 4 }]);
  // Small pages: every version once, in order.
  const seen = [];
  let cursor = null;
  for (let i = 0; i < 100; i += 1) {
    const page = (await json(await REGISTER(`?limit=7${cursor ? `&cursor=${cursor}` : ""}`))).body.data;
    seen.push(...page.entries.map((e) => e.version));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, Array.from({ length: 60 }, (_, i) => i + 1));
});

test("register history: limit 1 and 100 accepted; 0, 101, negative, fractional, blank, non-numeric and repeated rejected (400 field limit)", async () => {
  fixture();
  registerAudits(120);
  const one = (await json(await REGISTER("?limit=1"))).body.data;
  assert.deepEqual([one.entries.length, one.nextCursor], [1, "1"]);
  const max = (await json(await REGISTER("?limit=100"))).body.data;
  assert.deepEqual([max.entries.length, max.nextCursor], [100, "100"]);
  for (const query of ["?limit=0", "?limit=101", "?limit=-1", "?limit=1.5", "?limit=", "?limit=ten", "?limit=1e2", "?limit=%201", "?limit=99999", "?limit=1&limit=2"]) {
    const { status, body, response } = await json(await REGISTER(query));
    assert.deepEqual([status, body.error.code, body.error.details], [400, "VALIDATION_ERROR", { field: "limit" }], query);
    assertNoStore(assert, response);
  }
});

test("register history: invalid cursors are 400 field cursor (blank, zero, leading zero, sign, text, too long, repeated)", async () => {
  fixture();
  registerAudits(3);
  for (const query of ["?cursor=", "?cursor=0", "?cursor=01", "?cursor=-1", "?cursor=abc", "?cursor=1.5", "?cursor=1234567890", "?cursor=1&cursor=2"]) {
    const { status, body } = await json(await REGISTER(query));
    assert.deepEqual([status, body.error.code, body.error.details], [400, "VALIDATION_ERROR", { field: "cursor" }], query);
  }
  // A cursor past the end is a valid, empty last page.
  const past = (await json(await REGISTER("?cursor=99"))).body.data;
  assert.deepEqual([past.entries, past.nextCursor], [[], null]);
});

test("register history: no register yet is an empty, read-only answer (nothing created)", async () => {
  fixture();
  delete state.pg.committed.registers[L1];
  const before = writesState();
  const { status, body } = await json(await REGISTER());
  assert.equal(status, 200);
  assert.deepEqual(body.data, { lectureId: L1, registerExists: false, registerVersion: 0, qrClosure: null, entries: [], nextCursor: null });
  assert.equal(writesState(), before);
});

test("register history: invalid lecture ids 400; unknown, deleted and another teacher's lecture 404 (no audit read)", async () => {
  fixture();
  registerAudits(3);
  for (const id of BAD_IDS) {
    const { status, body } = await json(await REGISTER("", { id }));
    assert.deepEqual([status, body.error.details], [400, { field: "lectureId" }], JSON.stringify(id));
  }
  state.pg.log.length = 0;
  for (const id of ["unknown-lecture"]) {
    const { status, body } = await json(await REGISTER("", { id }));
    assert.deepEqual([status, body.error.code], [404, "LECTURE_NOT_FOUND"]);
  }
  state.session = { role: "TEACHER", userId: T2 };
  const foreign = await json(await REGISTER());
  assert.deepEqual([foreign.status, foreign.body.error.code], [404, "LECTURE_NOT_FOUND"]);
  state.session = { role: "TEACHER", userId: T1 };
  state.pg.committed.lectures[L1].status = 1;
  const deleted = await json(await REGISTER());
  assert.deepEqual([deleted.status, deleted.body.error.code], [404, "LECTURE_NOT_FOUND"]);
  assert.ok(!state.pg.log.includes("read:registerAudits"), "the authorization boundary is before any history read");
});

// ======================================================================================
// Student history
// ======================================================================================

test("student history: first page (default 50) and the next page; the mapped contract; no row or teacher ids; no-store", async () => {
  fixture();
  recordWithAudits("s1", 55);
  const first = await json(await STUDENT("s1"));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assertNoStore(assert, first.response);
  const data = first.body.data;
  assert.deepEqual(Object.keys(data).sort(), ["entries", "lectureId", "nextCursor", "record", "recordExists", "studentId"]);
  assert.deepEqual([data.lectureId, data.studentId, data.recordExists, data.entries.length, data.nextCursor], [L1, "s1", true, 50, "50"]);
  assert.deepEqual(data.record, { status: "PRESENT", statusSource: "TEACHER", version: 55, pendingReview: false });
  assert.deepEqual(data.entries[0], {
    version: 1, action: "TEACHER_SET", at: at(11).toISOString(), actor: { role: "TEACHER", isCurrentTeacher: true }, reason: null, afterFinalization: false,
    status: { from: null, to: "ABSENT" }, teacherStatus: { from: null, to: "ABSENT" }, autoStatus: { from: null, to: null }, cause: null,
  });
  assert.deepEqual([data.entries[1].action, data.entries[1].actor, data.entries[1].cause], ["EVIDENCE_RECORDED", { role: "SYSTEM", isCurrentTeacher: false }, "QR_SCAN"]);
  const text = JSON.stringify(first.body);
  assert.doesNotMatch(text, ROW_ID);
  for (const secret of [T1, "actorId", "scanEventId", "lectureAttendanceId", "Name of", "REG-"]) assert.ok(!text.includes(secret), secret);

  const second = (await json(await STUDENT("s1", `?cursor=${data.nextCursor}`))).body.data;
  assert.deepEqual(second.entries.map((e) => e.version), [51, 52, 53, 54, 55]);
  assert.equal(second.nextCursor, null);
});

test("student history: limits 1 / 100 and default; invalid limit and cursor are 400", async () => {
  fixture();
  recordWithAudits("s1", 120);
  assert.equal((await json(await STUDENT("s1", "?limit=1"))).body.data.entries.length, 1);
  assert.equal((await json(await STUDENT("s1", "?limit=100"))).body.data.entries.length, 100);
  assert.equal((await json(await STUDENT("s1"))).body.data.entries.length, 50);
  for (const [query, field] of [["?limit=0", "limit"], ["?limit=101", "limit"], ["?limit=x", "limit"], ["?limit=", "limit"], ["?cursor=0", "cursor"], ["?cursor=x", "cursor"], ["?cursor=", "cursor"], ["?cursor=1&cursor=1", "cursor"]]) {
    const { status, body } = await json(await STUDENT("s1", query));
    assert.deepEqual([status, body.error.code, body.error.details], [400, "VALIDATION_ERROR", { field }], query);
  }
});

test("student history: invalid lecture and student ids are 400 before any read", async () => {
  fixture();
  state.pg.log.length = 0;
  for (const id of BAD_IDS) {
    assert.deepEqual((await json(await STUDENT("s1", "", { id }))).body.error.details, { field: "lectureId" });
    assert.deepEqual((await json(await STUDENT(id))).body.error.details, { field: "studentId" });
  }
  assert.deepEqual(state.pg.log, [], "nothing read");
});

test("student history: unknown student and another teacher's student are the same 404, before the record is read", async () => {
  fixture();
  // Another teacher's student with a record on the teacher's own lecture: still not readable.
  recordWithAudits("s-other", 3);
  state.pg.log.length = 0;
  for (const id of ["s-other", "missing"]) {
    const { status, body } = await json(await STUDENT(id));
    assert.deepEqual([status, body.error.code, body.error.message], [404, "STUDENT_NOT_FOUND", "Student not found."], id);
  }
  assert.ok(!state.pg.log.includes("read:record") && !state.pg.log.includes("read:recordAudits"), JSON.stringify(state.pg.log));
});

test("student history: another teacher's (or a deleted / unknown) lecture is 404 LECTURE_NOT_FOUND, even for that teacher's own student", async () => {
  fixture();
  recordWithAudits("s1", 3);
  state.session = { role: "TEACHER", userId: T2 };
  state.pg.log.length = 0;
  for (const id of ["s1", "s-other"]) {
    const { status, body } = await json(await STUDENT(id));
    assert.deepEqual([status, body.error.code], [404, "LECTURE_NOT_FOUND"], id);
  }
  assert.ok(!state.pg.log.includes("read:record") && !state.pg.log.includes("read:recordAudits"));
  state.session = { role: "TEACHER", userId: T1 };
  state.pg.committed.lectures[L1].status = 1;
  assert.equal((await json(await STUDENT("s1"))).status, 404);
  assert.equal((await json(await STUDENT("s1", "", { id: "unknown-lecture" }))).body.error.code, "LECTURE_NOT_FOUND");
});

test("student history: inactive and deleted students' history stays readable for their teacher (read only)", async () => {
  fixture();
  recordWithAudits("s-inactive", 4);
  recordWithAudits("s-deleted", 2);
  const before = writesState();
  const inactive = await json(await STUDENT("s-inactive"));
  assert.deepEqual([inactive.status, inactive.body.data.recordExists, inactive.body.data.entries.length], [200, true, 4]);
  const deleted = await json(await STUDENT("s-deleted"));
  assert.deepEqual([deleted.status, deleted.body.data.recordExists, deleted.body.data.entries.length], [200, true, 2]);
  assert.equal(writesState(), before, "nothing changed");
  // A student of the teacher with no record: an empty answer.
  const none = (await json(await STUDENT("s1"))).body.data;
  assert.deepEqual(none, { lectureId: L1, studentId: "s1", recordExists: false, record: null, entries: [], nextCursor: null });
});

// ======================================================================================
// Both: authentication, read only, query hygiene, exact service arguments
// ======================================================================================

test("both: 401 without a teacher session (middleware and route)", async () => {
  fixture();
  for (const url of [`/api/lectures/${L1}/attendance/history`, `/api/lectures/${L1}/attendance/students/s1/history`]) {
    for (const headers of [{}, { cookie: "teacher_session=not-a-jwt" }]) {
      assert.equal((await middleware(new NextRequest(`${APP_ORIGIN}${url}`, { headers }))).status, 401, url);
    }
  }
  for (const session of [null, { role: "STUDENT", userId: "s1" }, { role: "ADMIN", userId: "a1" }]) {
    state.session = session;
    for (const response of [await REGISTER(), await STUDENT("s1")]) {
      const { status, body } = await json(response);
      assert.deepEqual([status, body.error.code], [401, "UNAUTHORIZED"]);
      assertNoStore(assert, response);
    }
  }
});

test("both: read only (no transaction, lock or write); a teacherId in the query is ignored (the session decides)", async () => {
  fixture();
  registerAudits(3);
  recordWithAudits("s1", 3);
  const before = writesState();
  const ownRegister = await json(await REGISTER(`?teacherId=${T2}`));
  const ownStudent = await json(await STUDENT("s1", `?teacherId=${T2}`));
  assert.deepEqual([ownRegister.status, ownStudent.status], [200, 200]);
  state.session = { role: "TEACHER", userId: T2 };
  assert.equal((await json(await REGISTER(`?teacherId=${T1}`))).status, 404);
  assert.equal((await json(await STUDENT("s1", `?teacherId=${T1}`))).status, 404);
  assert.equal(state.pg.transactions.length, 0, "no transaction (so no locks)");
  assert.equal(writesState(), before);
});

test("both: the exact service arguments (teacher from the session, trimmed ids, parsed cursor / limit, nulls when absent)", async () => {
  const servicePath = path.join(root, "services", "lecture-attendance-history-service.ts");
  const calls = [];
  const fakeService = {
    HISTORY_DEFAULT_LIMIT: 50,
    HISTORY_MAX_LIMIT: 100,
    getRegisterHistory: async (...args) => {
      calls.push(["register", ...args]);
      return { lectureId: args[1], registerExists: false, registerVersion: 0, qrClosure: null, entries: [], nextCursor: null };
    },
    getStudentAttendanceHistory: async (...args) => {
      calls.push(["student", ...args]);
      return { lectureId: args[1], studentId: args[2], recordExists: false, record: null, entries: [], nextCursor: null };
    },
  };
  const saved = { service: require.cache[servicePath], register: require.cache[registerRoutePath], student: require.cache[studentRoutePath] };
  const mod = new Module(servicePath);
  Object.assign(mod, { filename: servicePath, loaded: true, exports: fakeService });
  require.cache[servicePath] = mod;
  delete require.cache[registerRoutePath];
  delete require.cache[studentRoutePath];
  let fakeRegisterRoute;
  let fakeStudentRoute;
  try {
    fakeRegisterRoute = require(registerRoutePath);
    fakeStudentRoute = require(studentRoutePath);
  } finally {
    require.cache[servicePath] = saved.service;
    require.cache[registerRoutePath] = saved.register;
    require.cache[studentRoutePath] = saved.student;
  }
  fixture();
  await REGISTER("", { route: fakeRegisterRoute });
  await REGISTER("?cursor=12&limit=7&teacherId=x", { route: fakeRegisterRoute, id: ` ${L1} ` });
  await STUDENT("s1", "", { route: fakeStudentRoute });
  await STUDENT(" s1 ", "?limit=100&cursor=3", { route: fakeStudentRoute });
  assert.deepEqual(calls, [
    ["register", T1, L1, { cursor: null, limit: null }],
    ["register", T1, L1, { cursor: "12", limit: 7 }],
    ["student", T1, L1, "s1", { cursor: null, limit: null }],
    ["student", T1, L1, "s1", { cursor: "3", limit: 100 }],
  ]);
  assert.notEqual(registerRoute, fakeRegisterRoute, "the real routes stay loaded for the other tests");
});
