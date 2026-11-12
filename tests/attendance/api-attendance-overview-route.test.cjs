/*
 * GET /api/lectures/attendance-overview (Stage 5.5d-5a): the route, the
 * overview service and the REAL listLecturesForTeacher (services/
 * lecture-service.ts) in-process. Faked edges: the session and Prisma
 * (helpers/attendance-route-env.cjs: the in-memory model, plus the
 * lecture-list and grouping reads this endpoint needs, layered on below and
 * recording every database call). No database; query counts are counted
 * calls, not a real-PostgreSQL performance validation.
 *
 *   npm run test:attendance-api
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const env = require("./helpers/attendance-route-env.cjs");
const { state, reset: baseReset, student, at, NOW, T1, T2, L1, get, assertNoStore, withEnv, root, APP_ORIGIN } = env;

const { NextRequest } = require("next/server");
const route = require(path.join(root, "app", "api", "lectures", "attendance-overview", "route.ts"));
const { middleware } = require(path.join(root, "middleware.ts"));

test.mock.timers.enable({ apis: ["Date"], now: NOW });

// ---- The reads of the lecture list and the overview, over the model's committed data ------------

let calls;

function withOverviewReads(base, pg) {
  const record = (name, fn) => async (args) => {
    calls.push({ name, args });
    return fn(args);
  };
  const lectureMatches = (l, where) => {
    const cls = pg.committed.classes[l.classId];
    if (l.status !== where.status || !cls) return false;
    if (cls.teacherId !== where.class.teacherId || cls.status !== where.class.status) return false;
    if (where.id && l.id !== where.id) return false;
    if (where.classId && l.classId !== where.classId) return false;
    if (where.title && !l.title.toLowerCase().includes(where.title.contains.toLowerCase())) return false;
    if (where.date?.gte && l.date.getTime() < where.date.gte.getTime()) return false;
    if (where.date?.lte && l.date.getTime() > where.date.lte.getTime()) return false;
    return true;
  };
  return new Proxy(base, {
    get(target, key) {
      if (key === "class") {
        return {
          findFirst: record("class.findFirst", async ({ where }) => {
            const c = pg.committed.classes[where.id];
            return c && c.teacherId === where.teacherId && c.status === where.status ? { id: c.id, name: c.name, schedule: null } : null;
          }),
        };
      }
      if (key === "lecture") {
        return {
          ...target.lecture,
          findMany: record("lecture.findMany", async ({ where, skip, take, orderBy }) =>
            Object.values(pg.committed.lectures)
              .filter((l) => lectureMatches(l, where))
              .sort((a, b) => (orderBy.date === "asc" ? 1 : -1) * (a.date.getTime() - b.date.getTime()) || (a.id < b.id ? -1 : 1))
              .slice(skip, skip + take)
              .map((l) => {
                const c = pg.committed.classes[l.classId];
                return {
                  id: l.id, title: l.title, date: l.date, endDate: l.endDate ?? null, classStatus: l.classStatus, createdAt: l.createdAt,
                  class: { id: c.id, name: c.name, schedule: "Mon 9:00" },
                  _count: { notes: 3, assignments: 2, quizzes: 1, whiteboards: 4 },
                };
              })
          ),
          count: record("lecture.count", async ({ where }) => Object.values(pg.committed.lectures).filter((l) => lectureMatches(l, where)).length),
        };
      }
      if (key === "lectureAttendanceRegister") {
        return {
          ...target.lectureAttendanceRegister,
          findMany: record("lectureAttendanceRegister.findMany", async ({ where, select }) =>
            where.lectureId.in.map((id) => pg.committed.registers[id]).filter(Boolean)
              .map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])))
          ),
        };
      }
      if (key === "lectureAttendance") {
        return {
          ...target.lectureAttendance,
          groupBy: record("lectureAttendance.groupBy", async ({ by, where }) => {
            const groups = new Map();
            for (const r of Object.values(pg.committed.records)) {
              if (!where.lectureId.in.includes(r.lectureId)) continue;
              if (where.pendingReviewSince && r.pendingReviewSince === null) continue;
              const k = by.map((field) => r[field]).join("|");
              const group = groups.get(k) ?? { ...Object.fromEntries(by.map((field) => [field, r[field]])), _count: { _all: 0 } };
              group._count._all += 1;
              groups.set(k, group);
            }
            return [...groups.values()];
          }),
        };
      }
      return target[key];
    },
  });
}

// ---- Fixtures --------------------------------------------------------------------------------------

// Class ids are UUIDs here: the lecture list validates the classId filter as a UUID.
const C1 = "0b1d2c3e-4f50-4a61-8b72-93a4b5c6d7e8"; // the teacher's class
const C2 = "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5"; // another teacher's class
const C3 = "2d3e4f5a-6b7c-4d8e-9fa0-b1c2d3e4f5a6"; // the teacher's deleted class
let seq = 0;

function lecture(id, { classId = C1, date = at(0), status = 0, classStatus = "COMPLETED", endDate = null, title = `Lecture ${id}` } = {}) {
  state.pg.committed.lectures[id] = { id, classId, title, status, classStatus, date, endDate, createdAt: at(-1000) };
}

function rec(lectureId, studentId, status, { pending = false } = {}) {
  const teacher = status === "ABSENT" || status === "EXCUSED";
  const row = {
    id: `rec-${++seq}`, lectureId, classId: state.pg.committed.lectures[lectureId].classId, studentId, status,
    statusSource: teacher ? "TEACHER" : "AUTO", firstOnlineAt: teacher ? null : at(1), firstQrAt: null, autoStatus: teacher ? null : status,
    teacherStatus: teacher ? status : null, teacherDecidedAt: teacher ? at(130) : null, teacherDecidedById: teacher ? T1 : null,
    pendingReviewSince: pending ? at(140) : null, version: 1, createdAt: at(1), updatedAt: at(1),
  };
  if (pending && !teacher) Object.assign(row, { statusSource: "TEACHER", teacherStatus: status, teacherDecidedAt: at(130), teacherDecidedById: T1 });
  state.model.checkRecord(row);
  state.pg.committed.records[`${lectureId}:${studentId}`] = row;
}

function reset() {
  baseReset();
  seq = 0;
  calls = [];
  const pg = state.pg;
  state.model.prisma = withOverviewReads(state.model.prisma, pg);
  pg.committed.classes[C1] = { id: C1, teacherId: T1, status: 0, attendanceGraceMinutes: 10, name: "Physics A" };
  pg.committed.classes[C2] = { id: C2, teacherId: T2, status: 0, attendanceGraceMinutes: 10, name: "Chemistry (other teacher)" };
  pg.committed.classes[C3] = { id: C3, teacherId: T1, status: 1, attendanceGraceMinutes: 10, name: "Deleted class" };
  return pg;
}

/** A mixed set: open, finalized, no register, cancelled, historical; plus excluded lectures. */
function mixed() {
  reset();
  delete state.pg.committed.lectures[L1];
  lecture("L-open", { date: at(0), endDate: at(120), title: "Kinematics" });
  const reg = (lectureId, extra = {}) => {
    const l = state.pg.committed.lectures[lectureId];
    state.pg.committed.registers[lectureId] = {
      lectureId, classId: l.classId, scheduledStartAt: l.date, scheduledEndAt: l.endDate, graceMinutes: 10,
      finalizedAt: null, finalizedByTeacherId: null, version: 3, createdAt: at(-30), updatedAt: at(-30), ...extra,
    };
  };
  reg("L-open");
  for (const id of ["s1", "s2", "s3", "s4", "s5", "s6"]) student(id);
  rec("L-open", "s1", "PRESENT");
  rec("L-open", "s2", "PRESENT");
  rec("L-open", "s3", "LATE");
  rec("L-open", "s4", "ABSENT", { pending: true });
  rec("L-open", "s5", "EXCUSED");
  rec("L-open", "s6", "PRESENT", { pending: true });

  lecture("L-final", { date: at(-60 * 24), title: "Vectors" });
  reg("L-final", { finalizedAt: at(-60 * 20), finalizedByTeacherId: T1, version: 6 });
  rec("L-final", "s1", "ABSENT");

  lecture("L-none", { date: at(60 * 24 * 7), classStatus: "SCHEDULED", title: "Upcoming optics" });
  lecture("L-cancel", { date: at(60 * 24 * 2), classStatus: "CANCELLED", title: "Cancelled waves" });
  lecture("L-hist", { date: new Date("2026-08-10T12:30:00Z"), title: "Historical motion" });

  // Never shown: deleted lecture, deleted class, another teacher's lecture.
  lecture("L-deleted", { status: 1, title: "Deleted lecture" });
  lecture("L-deleted-class", { classId: C3, title: "In a deleted class" });
  lecture("L-other", { classId: C2, title: "Other teacher" });
  state.pg.committed.registers["L-other"] = { lectureId: "L-other", classId: C2, scheduledStartAt: at(0), scheduledEndAt: null, graceMinutes: 10, finalizedAt: at(5), finalizedByTeacherId: T2, version: 9, createdAt: at(0), updatedAt: at(0) };
}

const URL_BASE = "/api/lectures/attendance-overview";
const GET = (query = "") => route.GET(get(`${URL_BASE}${query}`));
const json = async (response) => ({ status: response.status, body: await response.json() });
const byId = (items) => Object.fromEntries(items.map((i) => [i.lectureId, i]));
const ZERO = { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 };

// ---- Authentication and ownership -------------------------------------------------------------------

test("401: middleware without a cookie or with an invalid token; the route without a teacher session", async () => {
  for (const headers of [{}, { cookie: "teacher_session=not-a-jwt" }]) {
    const response = await middleware(new NextRequest(`${APP_ORIGIN}${URL_BASE}`, { headers }));
    assert.equal(response.status, 401);
  }
  mixed();
  for (const session of [null, { role: "STUDENT", userId: "s1" }, { role: "ADMIN", userId: "a1" }]) {
    state.session = session;
    const response = await GET();
    assert.equal(response.status, 401);
    assertNoStore(assert, response);
  }
  assert.deepEqual(calls, [], "no database read before authentication");
});

test("ownership: only the teacher's non-deleted lectures in non-deleted classes; another teacher sees only theirs", async () => {
  mixed();
  const { status, body } = await json(await GET("?pageSize=100"));
  assert.equal(status, 200);
  assert.deepEqual(body.data.map((i) => i.lectureId).sort(), ["L-cancel", "L-final", "L-hist", "L-none", "L-open"]);
  assert.equal(body.pagination.totalItems, 5);

  state.session = { role: "TEACHER", userId: T2 };
  const other = await json(await GET());
  assert.deepEqual(other.body.data.map((i) => i.lectureId), ["L-other"]);
  assert.equal(other.body.data[0].register.version, 9, "their own register only");
});

test("a foreign or unknown class filter is the lecture list's 404; a malformed classId is 400; no register read", async () => {
  mixed();
  const foreign = await json(await GET(`?classId=${C2}`));
  assert.deepEqual([foreign.status, foreign.body.error.code], [404, "CLASS_NOT_FOUND"]);
  const deletedClass = await json(await GET(`?classId=${C3}`));
  assert.equal(deletedClass.status, 404);
  assert.equal((await GET("?classId=not-a-uuid")).status, 400);
  assert.ok(!calls.some((c) => c.name.startsWith("lectureAttendance")), "no attendance read on refusal");
});

// ---- Register states and counts -------------------------------------------------------------------

test("register states: none, open, finalized; record counts by status and pending reviews; cancelled and historical", async () => {
  mixed();
  const { body } = await json(await GET("?pageSize=100"));
  const items = byId(body.data);

  assert.deepEqual(items["L-open"], {
    lectureId: "L-open", title: "Kinematics", date: at(0).toISOString(), endDate: at(120).toISOString(), classStatus: "COMPLETED",
    class: { id: C1, name: "Physics A" },
    register: { finalized: false, finalizedAt: null, version: 3 },
    recordStatus: { PRESENT: 3, LATE: 1, ABSENT: 1, EXCUSED: 1 },
    pendingReviews: 2,
    classification: "LIVE",
  });
  assert.deepEqual(items["L-final"].register, { finalized: true, finalizedAt: at(-60 * 20).toISOString(), version: 6 });
  assert.deepEqual([items["L-final"].recordStatus, items["L-final"].pendingReviews], [{ ...ZERO, ABSENT: 1 }, 0]);
  assert.deepEqual([items["L-none"].register, items["L-none"].recordStatus, items["L-none"].pendingReviews, items["L-none"].classStatus], [null, ZERO, 0, "SCHEDULED"]);
  assert.equal(items["L-cancel"].classStatus, "CANCELLED");
  assert.equal(items["L-hist"].classification, "HISTORICAL");
  assert.equal(items["L-none"].classification, "LIVE");
});

test("classification follows the register's own (synced / frozen) start, not just the lecture date", async () => {
  mixed();
  // The lecture date moved after the evidence start, but the finalized register kept its historical start.
  state.pg.committed.lectures["L-final"].date = at(0);
  state.pg.committed.registers["L-final"].scheduledStartAt = new Date("2026-08-01T12:30:00Z");
  const { body } = await json(await GET("?pageSize=100"));
  assert.equal(byId(body.data)["L-final"].classification, "HISTORICAL");
});

test("unconfigured attendance settings: classification is null (nothing else changes, no error)", async () => {
  mixed();
  await withEnv({ ATTENDANCE_EVIDENCE_STARTED_AT: undefined }, async () => {
    const { status, body } = await json(await GET("?pageSize=100"));
    assert.equal(status, 200);
    assert.ok(body.data.every((i) => i.classification === null));
    assert.equal(byId(body.data)["L-open"].pendingReviews, 2);
  });
  await withEnv({ ATTENDANCE_EVIDENCE_STARTED_AT: "2026-08-15" }, async () => {
    const { body } = await json(await GET("?pageSize=100"));
    assert.ok(body.data.every((i) => i.classification === null), "invalid setting: null");
  });
});

// ---- Pagination and filters --------------------------------------------------------------------------

test("pagination: page / pageSize with the lecture list's metadata; pageSize capped at 100; default 10", async () => {
  mixed();
  const first = await json(await GET("?page=1&pageSize=2&sortOrder=asc"));
  assert.deepEqual(first.body.data.map((i) => i.lectureId), ["L-hist", "L-final"]);
  assert.deepEqual(first.body.pagination, { page: 1, pageSize: 2, totalItems: 5, totalPages: 3, hasNextPage: true, hasPreviousPage: false });
  const third = await json(await GET("?page=3&pageSize=2&sortOrder=asc"));
  assert.deepEqual(third.body.data.map((i) => i.lectureId), ["L-none"]);

  reset();
  delete state.pg.committed.lectures[L1];
  for (let i = 0; i < 130; i += 1) lecture(`P${String(i).padStart(3, "0")}`, { date: at(i) });
  const capped = await json(await GET("?pageSize=500"));
  assert.deepEqual([capped.body.data.length, capped.body.pagination.pageSize, capped.body.pagination.totalPages], [100, 100, 2]);
  assert.equal((await json(await GET())).body.data.length, 10, "default page size");
});

test("filters: class, title (case-insensitive), from / to (upcoming / previous), sort order; invalid dates are 400", async () => {
  mixed();
  const ids = async (query) => (await json(await GET(query))).body.data.map((i) => i.lectureId);
  assert.deepEqual((await ids(`?classId=${C1}&pageSize=100`)).length, 5);
  assert.deepEqual(await ids("?title=WAVES"), ["L-cancel"]);
  assert.deepEqual(await ids(`?from=${encodeURIComponent(NOW.toISOString())}&sortOrder=asc`), ["L-cancel", "L-none"], "upcoming");
  assert.deepEqual(await ids(`?to=${encodeURIComponent(NOW.toISOString())}&sortOrder=desc`), ["L-open", "L-final", "L-hist"], "previous");
  assert.deepEqual(await ids("?sortOrder=desc&pageSize=100"), ["L-none", "L-cancel", "L-open", "L-final", "L-hist"]);
  const bad = await json(await GET("?from=yesterday"));
  assert.deepEqual([bad.status, bad.body.error.code], [400, "VALIDATION_ERROR"]);
  // A lectureId parameter is not part of this API: ignored (the full page comes back).
  assert.equal((await ids("?lectureId=L-open&pageSize=100")).length, 5);
});

// ---- Contract, headers, queries ---------------------------------------------------------------------------

test("contract: exactly the documented fields; no internal fields; no-store", async () => {
  mixed();
  const response = await GET("?pageSize=100");
  assertNoStore(assert, response);
  const text = await response.text();
  const { data } = JSON.parse(text);
  for (const item of data) {
    assert.deepEqual(Object.keys(item).sort(), ["class", "classStatus", "classification", "date", "endDate", "lectureId", "pendingReviews", "recordStatus", "register", "title"]);
    assert.deepEqual(Object.keys(item.class).sort(), ["id", "name"]);
    if (item.register) assert.deepEqual(Object.keys(item.register).sort(), ["finalized", "finalizedAt", "version"]);
    assert.deepEqual(Object.keys(item.recordStatus).sort(), ["ABSENT", "EXCUSED", "LATE", "PRESENT"]);
  }
  for (const hidden of ["finalizedByTeacherId", T1, "rec-", "_count", "notes", "assignments", "quizzes", "whiteboards", "schedule", "createdAt", "scheduledStartAt", "studentId", "s1"]) {
    assert.ok(!text.includes(hidden), hidden);
  }
});

test("fixed query count (no N+1); the register reads use exactly the ownership-checked page's lecture ids", async () => {
  const countFor = async (n) => {
    reset();
    delete state.pg.committed.lectures[L1];
    for (let i = 0; i < n; i += 1) lecture(`Q${String(i).padStart(3, "0")}`, { date: at(i) });
    lecture("Q-other", { classId: C2 });
    calls = [];
    await GET(`?pageSize=${n}`);
    return calls;
  };
  const small = await countFor(3);
  const large = await countFor(100);
  const names = (c) => c.map((x) => x.name).sort();
  assert.deepEqual(names(small), names(large), "the same queries whatever the page size");
  assert.deepEqual(names(large), ["lecture.count", "lecture.findMany", "lectureAttendance.groupBy", "lectureAttendance.groupBy", "lectureAttendanceRegister.findMany"]);
  const registerRead = large.find((c) => c.name === "lectureAttendanceRegister.findMany");
  assert.equal(registerRead.args.where.lectureId.in.length, 100);
  assert.ok(!registerRead.args.where.lectureId.in.includes("Q-other"), "never another teacher's lecture");
  for (const groupBy of large.filter((c) => c.name === "lectureAttendance.groupBy")) {
    assert.deepEqual(groupBy.args.where.lectureId.in, registerRead.args.where.lectureId.in);
  }

  // An empty page reads no attendance data at all.
  reset();
  delete state.pg.committed.lectures[L1];
  calls = [];
  const empty = await json(await GET());
  assert.deepEqual(empty.body.data, []);
  assert.deepEqual(calls.map((c) => c.name).sort(), ["lecture.count", "lecture.findMany"]);
});

test("the existing lecture list is unchanged: its route still calls listLecturesForTeacher with the same arguments and returns its rows", () => {
  const listRoute = fs.readFileSync(path.join(root, "app", "api", "lectures", "route.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(listRoute, /return apiSuccess\(result\.lectures, \{\s*pagination: buildPaginationMeta\(result\.totalItems, pagination\.page, pagination\.pageSize\),\s*\}\);/);
  assert.doesNotMatch(listRoute, /attendance/i);
  const service = fs.readFileSync(path.join(root, "services", "lecture-attendance-overview-service.ts"), "utf8");
  assert.match(service, /await listLecturesForTeacher\(\{/);
  assert.doesNotMatch(service.replace(/\/\*[\s\S]*?\*\//g, ""), /prisma\.lecture\.|getRegister|planFinalizationAbsences|evidenceRepresentation|attendanceEligibilityAt/, "no own lecture query, no per-student evaluation");
});
