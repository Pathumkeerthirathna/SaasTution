/*
 * Student YouTube privacy consistency: a YouTube PRIVATE recording or live
 * broadcast never reaches a student (or a public visitor): not listed, not
 * counted, no video id / URL / playback. Every student entry point filters it
 * in its database query (lib/youtube-student-privacy.ts):
 *  - GET /api/student/lectures/[lectureId]      (a lecture's recordings)
 *  - GET /api/student/lectures                   (recording counts)
 *  - GET /api/student/classes/[id]/youtube-recordings | youtube-lives
 *       (tests/students/student-youtube-pages.test.cjs; checked here once more)
 *  - lib/youtube-live-status.ts getActiveYouTubeLives({ studentId })
 *       (student dashboard and GET /api/student/live/stream)
 *  - lib/youtube-live-snapshot.ts getLiveSnapshot(lectureId, "student") (live classroom)
 *  - services/class-service.ts getPublicClassSessions (public class pages)
 * PUBLIC and UNLISTED content keeps the existing rules (teacher visibility,
 * enrolment, payment restriction, monthly lock); the teacher's own views
 * keep every privacy. Faked: Prisma (applies the filters it is given, so a
 * missing filter shows as a leak), the sessions, the access resolvers.
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
const T1 = "teacher-1";
const C1 = "11111111-1111-4111-8111-111111111111";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const utc = (iso) => new Date(iso);

let state;
function recording(id, privacy, extra = {}) {
  return {
    id, lectureId: L1, broadcastId: `bc-${id}`, videoId: `v-${id}`, youtubeUrl: `https://www.youtube.com/watch?v=v-${id}`,
    privacy, status: "COMPLETE", visibility: "PUBLIC", access: "FREE",
    startedAt: utc("2026-10-10T05:00:00Z"), endedAt: utc("2026-10-10T06:00:00Z"), createdAt: utc("2026-10-10T05:00:00Z"), ...extra,
  };
}
function broadcast(id, privacy, extra = {}) {
  return {
    id, lectureId: L1, broadcastId: `bc-${id}`, videoId: `v-${id}`, youtubeUrl: `https://www.youtube.com/watch?v=v-${id}`,
    privacy, status: "LIVE", startedAt: utc("2026-11-24T05:00:00Z"), endedAt: null, createdAt: new Date(), ...extra,
  };
}
function reset() {
  state = {
    student: S1,
    restrictedClassIds: [],
    lockedMonths: new Set(),
    queries: [],
    recordings: [
      recording("r-public", "PUBLIC"),
      recording("r-unlisted", "UNLISTED"),
      recording("r-private", "PRIVATE"),
      recording("r-hidden", "UNLISTED", { visibility: "PRIVATE" }), // the teacher's own visibility: never for students
    ],
    broadcasts: [broadcast("b-public", "PUBLIC"), broadcast("b-unlisted", "UNLISTED"), broadcast("b-private", "PRIVATE")],
  };
}
reset();

// ---- Fake Prisma (applies the filters it is given) ----------------------------------------------------

function fieldMatches(value, filter) {
  if (filter === undefined) return true;
  if (filter && typeof filter === "object" && !(filter instanceof Date)) {
    if ("in" in filter) return filter.in.includes(value);
    if ("gte" in filter) return value >= filter.gte;
    if ("notIn" in filter) return !filter.notIn.includes(value);
    throw new Error(`fake: operator ${Object.keys(filter)}`);
  }
  return value === filter;
}
const YOUTUBE_FIELDS = ["visibility", "privacy", "status", "endedAt", "createdAt", "lectureId", "id"];
function youtubeMatches(row, where = {}) {
  for (const [key, filter] of Object.entries(where)) {
    if (key === "lecture") continue; // scope filters are covered by the page tests
    if (!YOUTUBE_FIELDS.includes(key)) throw new Error(`fake: youtube filter ${key}`);
    if (!fieldMatches(row[key], filter)) return false;
  }
  return true;
}
function pick(row, select) {
  return Object.fromEntries(Object.keys(select).filter((k) => k !== "lecture").map((k) => [k, row[k]]));
}
const LECTURE_FOR_LIVE = { title: "Kinematics", class: { name: "Physics", teacherId: T1, teacher: { name: "Teacher" } } };

const prisma = {
  lecture: {
    // The lecture detail route: the lecture with its relations; recordings filtered by the route's where.
    findFirst: async ({ where, select }) => {
      state.queries.push(["lecture.findFirst", where, select]);
      const recordings = state.recordings.filter((r) => youtubeMatches(r, select.youtubeRecordings?.where));
      return {
        id: L1, title: "Kinematics", date: utc("2026-10-10T03:30:00Z"), class: { id: C1, name: "Physics" },
        notes: [], assignments: [], whiteboards: [],
        youtubeRecordings: recordings.map((r) => pick(r, select.youtubeRecordings.select)),
      };
    },
    // The student lecture list (counts) and the public class pages (lectures with recordings).
    findMany: async (args) => {
      state.queries.push(["lecture.findMany", args.where, args.select]);
      if (args.select?.youtubeRecordings) {
        const some = args.where.youtubeRecordings?.some;
        const recordings = state.recordings.filter((r) => youtubeMatches(r, args.select.youtubeRecordings.where));
        if (some && !state.recordings.some((r) => youtubeMatches(r, some))) return [];
        return [{ id: L1, title: "Kinematics", date: utc("2026-10-10T03:30:00Z"), createdAt: utc("2026-10-01T00:00:00Z"), youtubeRecordings: recordings.map((r) => pick(r, args.select.youtubeRecordings.select)) }];
      }
      return [];
    },
  },
  youTubeLiveBroadcast: {
    findMany: async ({ where, select }) => {
      state.queries.push(["youTubeLiveBroadcast.findMany", where]);
      return state.broadcasts.filter((b) => youtubeMatches(b, where)).map((b) => ({ ...pick(b, select), lecture: LECTURE_FOR_LIVE }));
    },
    findFirst: async ({ where }) => {
      state.queries.push(["youTubeLiveBroadcast.findFirst", where]);
      const b = state.broadcasts.find((x) => youtubeMatches(x, where));
      return b ? { ...b, lecture: { class: { teacherId: T1 } } } : null;
    },
    updateMany: async () => ({ count: 0 }),
  },
  youTubeConnection: { findMany: async () => [], findUnique: async () => null },
};
const any = new Proxy(prisma, {
  get: (target, model) =>
    target[model] ??
    new Proxy({}, { get: (_t, method) => async (args) => (state.queries.push([`${String(model)}.${String(method)}`, args?.where]), method === "count" ? 0 : method.startsWith("findFirst") || method === "findUnique" ? null : []) }),
});
fake("lib/prisma.ts", { prisma: any });
fake("lib/auth-session.ts", {
  requireStudentSession: async () => ({ studentId: state.student, role: "STUDENT" }),
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
  getClassAccessRestrictions: async () => state.restrictedClassIds.map((classId) => ({ classId, kind: "OVERDUE" })),
});

const lectureDetail = require(path.join(root, "app", "api", "student", "lectures", "[lectureId]", "route.ts"));
const lectureList = require(path.join(root, "app", "api", "student", "lectures", "route.ts"));
const { getActiveYouTubeLives } = require(path.join(root, "lib", "youtube-live-status.ts"));
const { getLiveSnapshot } = require(path.join(root, "lib", "youtube-live-snapshot.ts"));
const { getPublicClassSessions } = require(path.join(root, "services", "class-service.ts"));
const privacy = require(path.join(root, "lib", "youtube-student-privacy.ts"));

test.beforeEach(() => reset());

const PRIVATE_LEAK = /r-private|b-private|v-r-private|v-b-private/;
const STUDENT_FILTER = { privacy: { in: ["PUBLIC", "UNLISTED"] } };

// ---- Recordings ------------------------------------------------------------------------------------

test("lecture page (GET /api/student/lectures/[id]): no YouTube-PRIVATE recording; PUBLIC and UNLISTED kept with their links", async () => {
  const response = await lectureDetail.GET(new Request("http://x/api/student/lectures/" + L1), { params: { lectureId: L1 } });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.data.lecture.recordings.map((r) => r.id), ["r-public", "r-unlisted"]);
  assert.ok(body.data.lecture.recordings.every((r) => r.videoId && r.youtubeUrl), "authorized and unlocked: playable");
  assert.doesNotMatch(JSON.stringify(body), PRIVATE_LEAK);
  const select = state.queries.find(([q]) => q === "lecture.findFirst")[2];
  assert.deepEqual(select.youtubeRecordings.where, { visibility: "PUBLIC", ...STUDENT_FILTER }, "filtered in the query, with the teacher's visibility kept");
});

test("lecture page: the monthly lock and the class restriction still apply (a locked month's recording has no link; assignments withheld)", async () => {
  state.lockedMonths.add(`${C1}:2026-10`);
  state.restrictedClassIds = [C1];
  const body = await (await lectureDetail.GET(new Request("http://x"), { params: { lectureId: L1 } })).json();
  for (const r of body.data.lecture.recordings) {
    assert.deepEqual(r.resourceAccess, { locked: true, year: 2026, month: 10 });
    assert.equal(r.videoId, null);
    assert.equal(r.youtubeUrl, null);
  }
  assert.equal(body.data.lecture.assignmentsRestricted, true);
});

test("lecture list (GET /api/student/lectures): recording counts never include a YouTube-PRIVATE recording", async () => {
  const response = await lectureList.GET(new Request("http://x/api/student/lectures?scheduled=1"));
  assert.equal(response.status, 200);
  const select = state.queries.find(([q, , s]) => q === "lecture.findMany" && s?._count)[2];
  assert.deepEqual(select._count.select.youtubeRecordings.where, { visibility: "PUBLIC", ...STUDENT_FILTER });
});

test("public class pages (getPublicClassSessions): no YouTube-PRIVATE recording (listed or as a reason to list a lecture); FREE ones keep their links", async () => {
  const sessions = await getPublicClassSessions(C1);
  assert.deepEqual(sessions[0].recordings.map((r) => r.id), ["r-public", "r-unlisted"]);
  assert.ok(sessions[0].recordings.every((r) => r.videoId), "FREE recordings stay playable");
  assert.doesNotMatch(JSON.stringify(sessions), PRIVATE_LEAK);
  const [, where, select] = state.queries.find(([q]) => q === "lecture.findMany");
  assert.deepEqual(where.youtubeRecordings.some, { visibility: "PUBLIC", ...STUDENT_FILTER });
  assert.deepEqual(select.youtubeRecordings.where, { visibility: "PUBLIC", ...STUDENT_FILTER });
  // A lecture whose only recording is PRIVATE is not listed at all.
  state.recordings = [recording("r-private", "PRIVATE")];
  assert.deepEqual(await getPublicClassSessions(C1), []);
});

// ---- Live broadcasts ---------------------------------------------------------------------------------

test("student dashboard / live feed (getActiveYouTubeLives, student): PRIVATE broadcasts are not even candidates; PUBLIC and UNLISTED shown", async () => {
  const lives = await getActiveYouTubeLives({ studentId: S1 });
  assert.deepEqual(lives.map((l) => l.id).sort(), ["b-public", "b-unlisted"]);
  assert.doesNotMatch(JSON.stringify(lives), PRIVATE_LEAK);
  const where = state.queries.find(([q]) => q === "youTubeLiveBroadcast.findMany")[1];
  assert.deepEqual(where.privacy, STUDENT_FILTER.privacy);
});

test("student live feed: a payment-restricted class's broadcasts are still excluded", async () => {
  state.restrictedClassIds = [C1];
  await getActiveYouTubeLives({ studentId: S1 });
  const where = state.queries.find(([q]) => q === "youTubeLiveBroadcast.findMany")[1];
  assert.deepEqual(where.lecture.class.id, { notIn: [C1] });
});

test("teachers keep every privacy (their own dashboard is unchanged)", async () => {
  const lives = await getActiveYouTubeLives({ teacherId: T1 });
  assert.deepEqual(lives.map((l) => l.id).sort(), ["b-private", "b-public", "b-unlisted"]);
  const where = state.queries.find(([q]) => q === "youTubeLiveBroadcast.findMany")[1];
  assert.equal(where.privacy, undefined);
});

test("live classroom status (getLiveSnapshot, student): PRIVATE broadcasts are filtered in the query; teachers unchanged", async () => {
  state.broadcasts = [broadcast("b-private", "PRIVATE")];
  const snapshot = await getLiveSnapshot(L1, "student");
  assert.deepEqual(snapshot, { isLive: false, youtubeUrl: null });
  assert.deepEqual(state.queries.find(([q]) => q === "youTubeLiveBroadcast.findFirst")[1].privacy, STUDENT_FILTER.privacy);
  state.queries = [];
  await getLiveSnapshot(L1, "teacher");
  assert.equal(state.queries.find(([q]) => q === "youTubeLiveBroadcast.findFirst")[1].privacy, undefined);
});

// ---- One shared rule ---------------------------------------------------------------------------------------

test("one shared rule: PUBLIC and UNLISTED only, used by every student entry point", () => {
  assert.deepEqual(privacy.STUDENT_VISIBLE_YOUTUBE_PRIVACIES, ["PUBLIC", "UNLISTED"]);
  assert.deepEqual(privacy.STUDENT_VISIBLE_PRIVACY_WHERE, STUDENT_FILTER);
  assert.equal(privacy.isStudentVisibleYouTubePrivacy("PRIVATE"), false);
  assert.equal(privacy.isStudentVisibleYouTubePrivacy("UNLISTED"), true);
  const fs = require("node:fs");
  const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
  for (const file of [
    ["app", "api", "student", "lectures", "route.ts"],
    ["app", "api", "student", "lectures", "[lectureId]", "route.ts"],
    ["services", "student-class-youtube-service.ts"],
    ["services", "class-service.ts"],
    ["lib", "youtube-live-status.ts"],
    ["lib", "youtube-live-snapshot.ts"],
  ]) {
    assert.match(read(...file), /from "@\/lib\/youtube-student-privacy"/, file.join("/"));
  }
});
