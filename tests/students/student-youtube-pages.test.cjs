/*
 * Student Recordings > Live Recordings / YouTube Live Sessions: the two
 * read-only student APIs.
 *  - GET /api/student/classes/[id]/youtube-recordings[?lectureId=]
 *  - GET /api/student/classes/[id]/youtube-lives[?lectureId=]
 * (services/student-class-youtube-service.ts, the student scope from
 * services/class-notes-service.ts resolveStudentClassScope).
 *
 * Covered: active enrolment only (404 otherwise); the optional lecture is a
 * NORMAL active lecture of that class (404 for another class's, a default or
 * a removed lecture); recordings: teacher visibility PUBLIC and never a
 * YouTube-PRIVATE video, each with its monthly lock (a locked month carries
 * no link); live sessions: PUBLIC / UNLISTED broadcasts that went live (LIVE
 * or COMPLETE), never PRIVATE; a payment-restricted class is 403; no teacher
 * field is ever sent; pagination. Faked: Prisma (records the queries and
 * applies the filters it is given), the session, the monthly access resolver
 * and the class access check.
 *
 *   npm run test:students
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

const { AppError } = require(path.join(root, "lib", "error-handler.ts"));

// ---- Fixtures --------------------------------------------------------------------------------------

const S1 = "student-1";
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const D1 = "aaaaaaaa-0000-4000-8000-00000000000d";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const L1B = "aaaaaaaa-0000-4000-8000-000000000003";
const L1_REMOVED = "aaaaaaaa-0000-4000-8000-000000000002";
const L2 = "bbbbbbbb-0000-4000-8000-000000000001";
const utc = (iso) => new Date(iso);

let state;
function reset() {
  state = {
    student: S1,
    restricted: new Set(), // classIds restricted for payment
    lockedMonths: new Set(), // "classId:YYYY-M"
    queries: [],
    classes: [
      { id: C1, name: "Physics", status: 0, enrolled: true },
      { id: C2, name: "Chemistry", status: 0, enrolled: false },
    ],
    lectures: [
      { id: D1, classId: C1, title: "General Notes", date: utc("2026-01-05T00:00:00Z"), status: 0, isDefault: true },
      { id: L1, classId: C1, title: "Kinematics", date: utc("2026-10-10T03:30:00Z"), status: 0, isDefault: false },
      { id: L1B, classId: C1, title: "Dynamics", date: utc("2026-11-10T03:30:00Z"), status: 0, isDefault: false },
      { id: L1_REMOVED, classId: C1, title: "Removed", date: utc("2026-10-11T03:30:00Z"), status: 1, isDefault: false },
      { id: L2, classId: C2, title: "Organic", date: utc("2026-10-12T03:30:00Z"), status: 0, isDefault: false },
    ],
    recordings: [
      rec("r-oct", L1, "2026-10-10T05:00:00Z"),
      rec("r-nov", L1B, "2026-11-10T05:00:00Z"),
      rec("r-hidden", L1, "2026-10-11T05:00:00Z", { visibility: "PRIVATE" }),
      rec("r-yt-private", L1, "2026-10-12T05:00:00Z", { privacy: "PRIVATE" }),
      rec("r-removed-lecture", L1_REMOVED, "2026-10-12T05:00:00Z"),
      rec("r-default", D1, "2026-10-13T05:00:00Z"),
      rec("r-other-class", L2, "2026-10-14T05:00:00Z"),
    ],
    lives: [
      live("b-live", L1B, "LIVE", "2026-11-10T03:30:00Z", null),
      live("b-done", L1, "COMPLETE", "2026-10-10T03:30:00Z", "2026-10-10T05:00:00Z"),
      live("b-private", L1, "COMPLETE", "2026-10-09T03:30:00Z", "2026-10-09T05:00:00Z", { privacy: "PRIVATE" }),
      live("b-ready", L1, "READY", "2026-10-08T03:30:00Z", null),
      live("b-revoked", L1, "REVOKED", "2026-10-07T03:30:00Z", null),
      live("b-other-class", L2, "COMPLETE", "2026-10-06T03:30:00Z", "2026-10-06T05:00:00Z"),
    ],
  };
}
function rec(id, lectureId, createdAt, extra = {}) {
  return {
    id, lectureId, broadcastId: `bc-${id}`, videoId: `v-${id}`, youtubeUrl: `https://www.youtube.com/watch?v=v-${id}`,
    privacy: "UNLISTED", status: "COMPLETE", visibility: "PUBLIC", access: "LOCKED",
    startedAt: utc(createdAt), endedAt: utc(createdAt), createdAt: utc(createdAt), ...extra,
  };
}
function live(id, lectureId, status, startedAt, endedAt, extra = {}) {
  return {
    id, lectureId, broadcastId: `bc-${id}`, videoId: `v-${id}`, youtubeUrl: `https://www.youtube.com/watch?v=v-${id}`,
    privacy: "UNLISTED", status, startedAt: utc(startedAt), endedAt: endedAt ? utc(endedAt) : null, createdAt: utc(startedAt),
    stopReason: "TEACHER", version: 3, autoStopError: "x", ...extra,
  };
}
reset();

// ---- Fake Prisma -----------------------------------------------------------------------------------

function lectureMatches(l, where) {
  for (const key of Object.keys(where)) if (!["id", "classId", "status", "isDefault"].includes(key)) throw new Error(`fake: lecture filter ${key}`);
  return (where.id === undefined || l.id === where.id) && (where.classId === undefined || l.classId === where.classId) &&
    (where.status === undefined || l.status === where.status) && (where.isDefault === undefined || l.isDefault === where.isDefault);
}
function inFilter(value, filter) {
  if (filter === undefined) return true;
  if (typeof filter === "string") return value === filter;
  return filter.in.includes(value);
}
function itemMatches(row, where) {
  for (const key of Object.keys(where)) if (!["visibility", "privacy", "status", "lecture"].includes(key)) throw new Error(`fake: item filter ${key}`);
  const lecture = state.lectures.find((l) => l.id === row.lectureId);
  return inFilter(row.visibility, where.visibility) && inFilter(row.privacy, where.privacy) && inFilter(row.status, where.status) && lectureMatches(lecture, where.lecture);
}
function project(row, select) {
  const out = {};
  for (const key of Object.keys(select)) {
    if (key === "lecture") {
      const l = state.lectures.find((x) => x.id === row.lectureId);
      out.lecture = { id: l.id, title: l.title, date: l.date };
    } else out[key] = row[key];
  }
  return out;
}
function itemDelegate(name, list) {
  return {
    count: async ({ where }) => {
      state.queries.push([`${name}.count`, where]);
      return list().filter((r) => itemMatches(r, where)).length;
    },
    findMany: async ({ where, orderBy, skip, take, select }) => {
      state.queries.push([`${name}.findMany`, { where, orderBy, skip, take }]);
      const rows = list().filter((r) => itemMatches(r, where)).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
      return rows.slice(skip, skip + take).map((r) => project(r, select));
    },
  };
}
const prisma = {
  class: {
    findFirst: async ({ where }) => {
      state.queries.push(["class.findFirst", where]);
      const c = state.classes.find((x) => x.id === where.id && x.status === where.status);
      const some = where.students?.some;
      if (!c || !some || some.studentId !== state.student || some.isActive !== true || !c.enrolled) return null;
      return { id: c.id, name: c.name };
    },
  },
  lecture: {
    findFirst: async ({ where, select }) => {
      state.queries.push(["lecture.findFirst", where]);
      const l = state.lectures.find((x) => lectureMatches(x, where));
      return l ? Object.fromEntries(Object.keys(select).map((k) => [k, l[k]])) : null;
    },
  },
  youTubeRecording: itemDelegate("youTubeRecording", () => state.recordings),
  youTubeLiveBroadcast: itemDelegate("youTubeLiveBroadcast", () => state.lives),
};
fake("lib/prisma.ts", { prisma });
fake("lib/auth-session.ts", {
  requireStudentSession: async () => {
    if (!state.student) throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { studentId: state.student, role: "STUDENT" };
  },
  requireTeacherSession: async () => { throw new AppError("no", 401, "UNAUTHORIZED"); },
  requireAppSession: async () => { throw new AppError("no", 401, "UNAUTHORIZED"); },
  requireAdminSession: async () => { throw new AppError("no", 401, "UNAUTHORIZED"); },
  requireTeacherSessionForbiddingOtherRoles: async () => { throw new AppError("no", 401, "UNAUTHORIZED"); },
  getOptionalSession: async () => null,
});
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });
const realAccess = require(path.join(root, "services", "resource-access-service.ts"));
fake("services/resource-access-service.ts", {
  ...realAccess,
  loadStudentResourceAccess: async (studentId) => ({
    studentId,
    decide: (classId, month) => ({ accessible: !state.lockedMonths.has(`${classId}:${month.year}-${month.month}`), year: month.year, month: month.month }),
  }),
});
const realClassAccess = require(path.join(root, "services", "class-access-service.ts"));
fake("services/class-access-service.ts", {
  ...realClassAccess,
  assertClassAccessForStudent: async (studentId, classId) => {
    state.queries.push(["assertClassAccessForStudent", { studentId, classId }]);
    if (state.restricted.has(classId)) throw new AppError("Your access to this class is paused until the fee is paid.", 403, "CLASS_ACCESS_RESTRICTED");
  },
});

const route = (...p) => require(path.join(root, "app", "api", "student", "classes", "[id]", ...p, "route.ts"));
const recordingsRoute = route("youtube-recordings");
const livesRoute = route("youtube-lives");

test.beforeEach(() => reset());

async function get(handler, classId, query = "") {
  const response = await handler(new Request(`http://x/api/student/classes/${classId}/x${query}`), { params: { id: classId } });
  return { status: response.status, body: await response.json() };
}
const ids = (list) => list.map((item) => item.id);
const code = (result) => result.body.error?.code;
const TEACHER_FIELDS = /broadcastId|stopReason|autoStop|"version"|"visibility"|"privacy"|teacherId/;

// ---- Live Recordings ----------------------------------------------------------------------------------

test("recordings: the class's student-visible YouTube recordings, newest first; only active normal lectures; never hidden or YouTube-private ones", async () => {
  const result = await get(recordingsRoute.GET, C1);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.data.class, { id: C1, name: "Physics" });
  assert.equal(result.body.data.lecture, null, "the whole class");
  assert.deepEqual(ids(result.body.data.recordings), ["r-nov", "r-oct"]);
  const [first] = result.body.data.recordings;
  assert.deepEqual(Object.keys(first).sort(), ["access", "createdAt", "endedAt", "id", "lecture", "resourceAccess", "startedAt", "status", "videoId", "youtubeUrl"]);
  assert.deepEqual(first.lecture, { id: L1B, title: "Dynamics", date: "2026-11-10T03:30:00.000Z" });
  assert.doesNotMatch(JSON.stringify(result.body), TEACHER_FIELDS);
  const where = state.queries.find(([q]) => q === "youTubeRecording.findMany")[1].where;
  assert.deepEqual(where, { visibility: "PUBLIC", privacy: { in: ["PUBLIC", "UNLISTED"] }, lecture: { classId: C1, status: 0, isDefault: false } });
});

test("recordings: a lecture filters to it; another class's, a default or a removed lecture is 404; malformed is 400", async () => {
  const one = await get(recordingsRoute.GET, C1, `?lectureId=${L1}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.data.lecture, { id: L1, title: "Kinematics", date: "2026-10-10T03:30:00.000Z" });
  assert.deepEqual(ids(one.body.data.recordings), ["r-oct"]);
  for (const lectureId of [L2, D1, L1_REMOVED]) {
    const result = await get(recordingsRoute.GET, C1, `?lectureId=${lectureId}`);
    assert.deepEqual([result.status, code(result)], [404, "LECTURE_NOT_FOUND"], lectureId);
  }
  assert.equal((await get(recordingsRoute.GET, C1, "?lectureId=bad%20id")).status, 400);
});

test("recordings: a locked month's recording is listed with its lock and without its link (as on the lecture page)", async () => {
  state.lockedMonths.add(`${C1}:2026-10`);
  const result = await get(recordingsRoute.GET, C1);
  const byId = Object.fromEntries(result.body.data.recordings.map((r) => [r.id, r]));
  assert.deepEqual(byId["r-oct"].resourceAccess, { locked: true, year: 2026, month: 10 });
  assert.equal(byId["r-oct"].videoId, null);
  assert.equal(byId["r-oct"].youtubeUrl, null);
  assert.deepEqual(byId["r-nov"].resourceAccess, { locked: false, year: 2026, month: 11 });
  assert.equal(byId["r-nov"].videoId, "v-r-nov");
});

test("recordings and live sessions: not enrolled (another class), unknown class or no session", async () => {
  for (const handler of [recordingsRoute.GET, livesRoute.GET]) {
    const other = await get(handler, C2);
    assert.deepEqual([other.status, code(other)], [404, "CLASS_NOT_FOUND"]);
    assert.equal((await get(handler, "99999999-9999-4999-8999-999999999999")).status, 404);
  }
  state.student = null;
  assert.equal((await get(recordingsRoute.GET, C1)).status, 401);
  assert.equal((await get(livesRoute.GET, C1)).status, 401);
});

test("recordings and live sessions: pagination (page / pageSize) and the totals", async () => {
  const page1 = await get(recordingsRoute.GET, C1, "?page=1&pageSize=1");
  const page2 = await get(recordingsRoute.GET, C1, "?page=2&pageSize=1");
  assert.deepEqual([ids(page1.body.data.recordings), ids(page2.body.data.recordings)], [["r-nov"], ["r-oct"]]);
  assert.equal(page1.body.data.pagination.totalItems, 2);
  assert.equal(page1.body.data.pagination.totalPages, 2);
  const lives = await get(livesRoute.GET, C1, "?page=1&pageSize=1");
  assert.equal(lives.body.data.pagination.totalItems, 2);
});

// ---- YouTube Live Sessions -----------------------------------------------------------------------------

test("live sessions: PUBLIC / UNLISTED broadcasts that went live (live now, or finished), newest first; never private, scheduled or revoked ones", async () => {
  const result = await get(livesRoute.GET, C1);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(ids(result.body.data.broadcasts), ["b-live", "b-done"]);
  const [live, done] = result.body.data.broadcasts;
  assert.equal(live.isLive, true);
  assert.equal(done.isLive, false);
  assert.deepEqual(Object.keys(live).sort(), ["createdAt", "endedAt", "id", "isLive", "lecture", "startedAt", "videoId", "youtubeUrl"]);
  assert.doesNotMatch(JSON.stringify(result.body), TEACHER_FIELDS);
  const where = state.queries.find(([q]) => q === "youTubeLiveBroadcast.findMany")[1].where;
  assert.deepEqual(where, { privacy: { in: ["PUBLIC", "UNLISTED"] }, status: { in: ["LIVE", "COMPLETE"] }, lecture: { classId: C1, status: 0, isDefault: false } });
  const lecture = await get(livesRoute.GET, C1, `?lectureId=${L1}`);
  assert.deepEqual(ids(lecture.body.data.broadcasts), ["b-done"]);
});

test("live sessions: a payment-restricted class is 403 before anything is listed (no watch links)", async () => {
  state.restricted.add(C1);
  const result = await get(livesRoute.GET, C1);
  assert.deepEqual([result.status, code(result)], [403, "CLASS_ACCESS_RESTRICTED"]);
  assert.ok(!state.queries.some(([q]) => q.startsWith("youTubeLiveBroadcast")));
  assert.deepEqual(state.queries.find(([q]) => q === "assertClassAccessForStudent")[1], { studentId: S1, classId: C1 });
});
