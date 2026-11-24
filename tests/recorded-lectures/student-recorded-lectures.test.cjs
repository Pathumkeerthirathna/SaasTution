/*
 * Recorded Lectures RL-4.2: the student list and metadata APIs, through the
 * REAL routes, service, session check (requireStudentSession, signed student
 * cookie) and error handler, with an in-memory Prisma double that evaluates
 * the queries (helpers/fake-student-db.cjs) and a controllable server clock.
 *
 *   GET /api/student/recorded-lectures
 *   GET /api/student/recorded-lectures/[recordingId]
 *
 * Real PostgreSQL checks of the same queries are deferred (RL-3.6;
 * localhost only, never Neon).
 */

"use strict";

require("../helpers/no-class-access-restrictions.cjs"); // this suite does not model class fees (tests/class-access covers access control)

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const F = require("./helpers/student-fixture.cjs");

const {
  root, state, DAY, NOW, id, TEACHER_A, TEACHER_B, STUDENT, CLASSMATE, CLASS_A, CLASS_A_OTHER,
  LECTURE, LECTURE_DELETED, LECTURE_TEACHER_B, STORED, ORIGINAL_NAME, R, recording, lecture, seed, signIn, signInTeacher,
} = F;

const service = require(path.join(root, "services", "recorded-lecture-student-service.ts"));
const listRoute = require(path.join(root, "app", "api", "student", "recorded-lectures", "route.ts"));
const detailRoute = require(path.join(root, "app", "api", "student", "recorded-lectures", "[recordingId]", "route.ts"));

const savedDays = process.env.RECORDED_LECTURE_DASHBOARD_DAYS;
test.beforeEach(() => {
  seed();
  state.cookie = null;
  state.clock = NOW;
  delete process.env.RECORDED_LECTURE_DASHBOARD_DAYS;
});
test.after(() => {
  if (savedDays === undefined) delete process.env.RECORDED_LECTURE_DASHBOARD_DAYS;
  else process.env.RECORDED_LECTURE_DASHBOARD_DAYS = savedDays;
});

async function call(handler, url, params) {
  const request = new Request(`http://localhost${url}`, { method: "GET" });
  const response = await handler(request, { params });
  return { status: response.status, body: await response.json(), text: null };
}
const list = (query = "") => call(listRoute.GET, `/api/student/recorded-lectures${query}`);
const detail = (recordingId) => call(detailRoute.GET, `/api/student/recorded-lectures/${recordingId}`, { recordingId });
const ids = (res) => res.body.data.recordedLectures.map((r) => r.id);
const recordingQueries = () => state.fake.queries.filter((q) => q.model === "recordedLecture");

// ---- Authentication ------------------------------------------------------------------------------

test("auth: no session is 401 on both routes, before any recording query", async () => {
  for (const res of [await list(), await detail(R.ok)]) {
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  }
  assert.equal(recordingQueries().length, 0);
});

test("auth: a teacher session is 401 (students only)", async () => {
  await signInTeacher();
  assert.equal((await list()).status, 401);
  assert.equal((await detail(R.ok)).status, 401);
  assert.equal(recordingQueries().length, 0);
});

test("auth: an inactive student is 403 STUDENT_ACCOUNT_INACTIVE; a deleted one 401", async () => {
  await signIn();
  state.fake.db.students[0].status = 1;
  for (const res of [await list(), await detail(R.ok)]) {
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "STUDENT_ACCOUNT_INACTIVE");
  }
  state.fake.db.students[0].status = 2;
  assert.equal((await list()).status, 401);
  assert.equal(recordingQueries().length, 0);
});

test("auth: a stale session version is 401", async () => {
  await signIn(STUDENT, 0);
  state.fake.db.students[0].sessionVersion = 1;
  assert.equal((await list()).status, 401);
  assert.equal((await detail(R.ok)).status, 401);
});

test("auth: the student id comes only from the token (query parameters naming another student are ignored)", async () => {
  await signIn(CLASSMATE);
  const res = await list(`?studentId=${STUDENT}`);
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), [R.otherClass, R.otherTeacher].sort((a, b) => (a < b ? -1 : 1)));
  assert.ok(!ids(res).includes(R.ok));
});

test("auth: pending and rejected students get no recordings (empty list, 404 like a missing id)", async () => {
  for (const confirmation of ["PENDING", "REJECTED"]) {
    seed();
    await signIn();
    state.fake.db.students[0].confirmationStatus = confirmation;
    const l = await list();
    assert.equal(l.status, 200, confirmation);
    assert.deepEqual(ids(l), [], confirmation);
    const d = await detail(R.ok);
    const missing = await detail(id(999));
    assert.equal(d.status, 404, confirmation);
    assert.deepEqual(d.body, missing.body, confirmation);
  }
});

test("auth: approval and enrollment are checked again on every request", async () => {
  await signIn();
  assert.equal((await detail(R.ok)).status, 200);
  state.fake.db.classStudents[0].isActive = false; // removed from the class
  assert.equal((await detail(R.ok)).status, 404);
  assert.deepEqual(ids(await list()), []);
  state.fake.db.classStudents[0].isActive = true;
  assert.equal((await detail(R.ok)).status, 200);
  state.fake.db.students[0].confirmationStatus = "REJECTED"; // rejected after signing in
  assert.equal((await detail(R.ok)).status, 404);
});

// ---- Authorisation -------------------------------------------------------------------------------

test("authorisation: an approved, enrolled student lists exactly the eligible READY recordings", async () => {
  await signIn();
  const res = await list();
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), [R.ok, R.okPart2]);
  assert.equal(res.body.data.scope, "all");
  assert.equal(res.body.data.nextCursor, null);
});

const EXCLUDED = [
  ["removed enrollment (isActive false)", "removedEnrollment"],
  ["inactive class", "inactiveClass"],
  ["inactive (deleted) lecture", "deletedLecture"],
  ["UPLOADING recording", "uploading"],
  ["VERIFYING recording", "verifying"],
  ["FAILED recording", "failed"],
  ["status 1 (removed) recording", "removed"],
  ["status 2 (purge pending) recording", "purgePending"],
  ["missing stored file name", "noStoredName"],
  ["cross-class (same teacher, not enrolled)", "otherClass"],
  ["cross-teacher (another teacher's class)", "otherTeacher"],
];

test("authorisation: every ineligible recording is a 404 identical to a missing id", async () => {
  await signIn();
  const missing = await detail(id(999));
  const malformed = await detail("not-a-uuid");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "RECORDED_LECTURE_NOT_FOUND");
  assert.deepEqual(malformed, missing);
  for (const [name, key] of EXCLUDED) {
    const res = await detail(R[key]);
    assert.deepEqual(res, missing, name);
  }
  const listed = ids(await list());
  for (const [name, key] of EXCLUDED) assert.ok(!listed.includes(R[key]), name);
});

test("authorisation: the excluded rows are reachable for an eligible student (the fixture is sound)", async () => {
  // The cross-class and cross-teacher rows ARE visible to the classmate enrolled there,
  // so the 404s above are about enrollment, not broken fixture rows.
  await signIn(CLASSMATE);
  assert.equal((await detail(R.otherClass)).status, 200);
  assert.equal((await detail(R.otherTeacher)).status, 200);
  assert.equal((await detail(R.ok)).status, 404);
});

test("authorisation: a malformed id never reaches the database", async () => {
  await signIn();
  for (const bad of ["x", "../../etc/passwd", `${R.ok}x`, "ABCDEF00-0000-4000-8000-000000000501", "%00"]) {
    assert.equal((await detail(bad)).status, 404, bad);
  }
  assert.equal(recordingQueries().length, 0);
});

// ---- DTO -----------------------------------------------------------------------------------------

test("dto: metadata returns only the allow-listed fields; sizeBytes is a string", async () => {
  await signIn();
  const res = await detail(R.ok);
  assert.equal(res.status, 200);
  const r = res.body.data.recordedLecture;
  assert.deepEqual(Object.keys(r).sort(), [
    "class", "dashboard", "durationSeconds", "height", "id", "isGeneral", "lecture", "partNumber", "readyAt", "sizeBytes", "streamUrl", "title", "width",
  ]);
  assert.equal(r.sizeBytes, "5000000000");
  assert.equal(r.streamUrl, `/api/student/recorded-lectures/${R.ok}/stream`);
  assert.deepEqual(r.class, { id: CLASS_A, name: "Grade 10 Maths" });
  assert.deepEqual(r.lecture, { id: LECTURE, title: `Lecture ${LECTURE.slice(-3)}`, date: new Date(NOW - DAY).toISOString(), endDate: null });
});

test("dto: no response contains storage, teacher, upload or failure information", async () => {
  await signIn();
  const bodies = [JSON.stringify((await list()).body), JSON.stringify((await detail(R.ok)).body), JSON.stringify((await list("?scope=dashboard")).body)];
  for (const text of bodies) {
    for (const secret of [STORED, "0123456789abcdef", ORIGINAL_NAME, TEACHER_A, TEACHER_B, "avc1", "mp4a", "storedFileName", "displayFileName", "teacherId", "failureCode", "Teachers/", "RecordedLectures/", "TemporaryUploads"]) {
      assert.ok(!text.includes(secret), secret);
    }
  }
});

test("dto: the service selects no storage, teacher or upload column", async () => {
  await signIn();
  await list();
  await detail(R.ok);
  for (const q of recordingQueries()) {
    const selected = JSON.stringify(q.args.select);
    for (const column of ["storedFileName", "displayFileName", "teacherId", "failureCode", "videoCodec", "deletedByTeacherId"]) {
      assert.ok(!selected.includes(`"${column}"`), column);
    }
  }
});

// ---- Dashboard window and scopes -----------------------------------------------------------------

function addLecture(lectureId, dateMs, recId, part = 1) {
  state.fake.db.lectures.push(lecture(lectureId, CLASS_A, { date: new Date(dateMs) }));
  state.fake.db.recordings.push(recording(recId, lectureId, CLASS_A, TEACHER_A, { partNumber: part }));
}

test("scope: dashboard returns only lectures that started within the last 7 days; all returns every one", async () => {
  await signIn();
  addLecture(id(221), NOW, id(621)); // started exactly now: inside
  addLecture(id(222), NOW - 7 * DAY + 1, id(622)); // inside by 1 ms
  addLecture(id(223), NOW - 7 * DAY, id(623)); // exactly 7 days: outside
  addLecture(id(224), NOW - 30 * DAY, id(624)); // old: outside
  addLecture(id(225), NOW + 2 * DAY, id(625)); // not started yet: outside the dashboard, still in "all" (D-2)
  addLecture(id(226), NOW + 1, id(626)); // starts in 1 ms: outside

  const dash = await list("?scope=dashboard");
  assert.equal(dash.status, 200);
  assert.equal(dash.body.data.scope, "dashboard");
  assert.equal(dash.body.data.dashboardDays, 7);
  assert.deepEqual(ids(dash), [id(621), R.ok, R.okPart2, id(622)]);
  for (const r of dash.body.data.recordedLectures) assert.equal(r.dashboard.visible, true);

  const all = await list();
  assert.deepEqual(ids(all), [id(625), id(626), id(621), R.ok, R.okPart2, id(622), id(623), id(624)]);
  const visible = Object.fromEntries(all.body.data.recordedLectures.map((r) => [r.id, r.dashboard.visible]));
  assert.deepEqual(visible, {
    [id(625)]: false, [id(626)]: false, [id(621)]: true, [R.ok]: true, [R.okPart2]: true, [id(622)]: true, [id(623)]: false, [id(624)]: false,
  });
  assert.deepEqual(ids(await list("?scope=all")), ids(all));
});

test("scope: the dashboard follows the server clock (serverNow) across the 7-day boundary", async () => {
  await signIn();
  state.clock = NOW - DAY + 7 * DAY - 1; // lecture started at NOW - DAY
  assert.deepEqual(ids(await list("?scope=dashboard")), [R.ok, R.okPart2]);
  state.clock = NOW - DAY + 7 * DAY;
  assert.deepEqual(ids(await list("?scope=dashboard")), []);
  assert.deepEqual(ids(await list()), [R.ok, R.okPart2]);
});

test("scope: Sri Lankan midnight lecture leaves the dashboard at Sri Lankan midnight 7 days later", async () => {
  await signIn();
  const { parseSriLankaLocalDateTime } = require(path.join(root, "lib", "time.ts"));
  const start = parseSriLankaLocalDateTime("2026-11-14T00:00").getTime();
  state.fake.db.lectures[0].date = new Date(start);
  state.clock = Date.parse("2026-11-20T18:29:59.999Z");
  assert.deepEqual(ids(await list("?scope=dashboard")), [R.ok, R.okPart2]);
  state.clock = Date.parse("2026-11-20T18:30:00.000Z"); // 2026-11-21 00:00 Sri Lanka
  assert.deepEqual(ids(await list("?scope=dashboard")), []);
});

test("scope: the configured RECORDED_LECTURE_DASHBOARD_DAYS is used; an invalid value is 503", async () => {
  await signIn();
  process.env.RECORDED_LECTURE_DASHBOARD_DAYS = "1";
  state.clock = NOW; // lecture started 1 day ago: exactly the end of a 1-day window
  const res = await list("?scope=dashboard");
  assert.equal(res.body.data.dashboardDays, 1);
  assert.deepEqual(ids(res), []);
  process.env.RECORDED_LECTURE_DASHBOARD_DAYS = "2";
  assert.deepEqual(ids(await list("?scope=dashboard")), [R.ok, R.okPart2]);
  process.env.RECORDED_LECTURE_DASHBOARD_DAYS = "99";
  const bad = await list();
  assert.equal(bad.status, 503);
  assert.equal(bad.body.error.code, "RECORDED_LECTURES_NOT_CONFIGURED");
  assert.equal((await detail(R.ok)).status, 503);
});

test("scope: metadata and the full list are never limited by the window (old and future lectures)", async () => {
  await signIn();
  addLecture(id(231), NOW - 365 * DAY, id(631));
  addLecture(id(232), NOW + 3 * DAY, id(632));
  for (const recId of [id(631), id(632)]) {
    const res = await detail(recId);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.recordedLecture.dashboard.visible, false);
  }
  const all = ids(await list());
  assert.ok(all.includes(id(631)) && all.includes(id(632)));
});

test("lectureId: narrows to that lecture; an invisible lecture gives no rows", async () => {
  await signIn();
  addLecture(id(241), NOW - 2 * DAY, id(641));
  assert.deepEqual(ids(await list(`?lectureId=${LECTURE}`)), [R.ok, R.okPart2]);
  assert.deepEqual(ids(await list(`?lectureId=${id(241)}&scope=dashboard`)), [id(641)]);
  assert.deepEqual(ids(await list(`?lectureId=${LECTURE_TEACHER_B}`)), []);
  assert.deepEqual(ids(await list(`?lectureId=${LECTURE_DELETED}`)), []);
});

// ---- Query validation ----------------------------------------------------------------------------

test("query: invalid scope, limit, lectureId and cursor are 400 with a stable code", async () => {
  await signIn();
  const cases = [
    ["?scope=everything", "INVALID_SCOPE"],
    ["?scope=DASHBOARD", "INVALID_SCOPE"],
    ["?limit=0", "INVALID_LIMIT"],
    ["?limit=51", "INVALID_LIMIT"],
    ["?limit=abc", "INVALID_LIMIT"],
    ["?limit=-1", "INVALID_LIMIT"],
    ["?limit=1.5", "INVALID_LIMIT"],
    ["?lectureId=abc", "INVALID_LECTURE_ID"],
    ["?cursor=not*base64", "INVALID_CURSOR"],
    [`?cursor=${Buffer.from("{}").toString("base64url")}`, "INVALID_CURSOR"],
    [`?cursor=${Buffer.from("[1,2,3,4]").toString("base64url")}`, "INVALID_CURSOR"],
    [`?cursor=${Buffer.from(JSON.stringify([NOW, LECTURE, 0, R.ok])).toString("base64url")}`, "INVALID_CURSOR"],
    [`?cursor=${Buffer.from(JSON.stringify([NOW, "x", 1, R.ok])).toString("base64url")}`, "INVALID_CURSOR"],
    [`?cursor=${Buffer.from(JSON.stringify([1e20, LECTURE, 1, R.ok])).toString("base64url")}`, "INVALID_CURSOR"],
    [`?cursor=${"A".repeat(600)}`, "INVALID_CURSOR"],
  ];
  for (const [query, code] of cases) {
    const res = await list(query);
    assert.equal(res.status, 400, query);
    assert.equal(res.body.error.code, code, query);
  }
  assert.equal(recordingQueries().length, 0);
});

// ---- Pagination ----------------------------------------------------------------------------------

function seedMany() {
  // 3 lectures on the SAME date (ties broken by lecture id), 2 older, several parts each.
  const sameDate = NOW - 2 * DAY;
  let n = 700;
  for (const [lec, dateMs, parts] of [
    [id(251), sameDate, 3],
    [id(252), sameDate, 2],
    [id(253), sameDate, 1],
    [id(254), NOW - 3 * DAY, 4],
    [id(255), NOW - 40 * DAY, 2],
  ]) {
    state.fake.db.lectures.push(lecture(lec, CLASS_A, { date: new Date(dateMs) }));
    // Insert parts in reverse so the fixture order is not already the sorted order.
    for (let part = parts; part >= 1; part -= 1) {
      n += 1;
      state.fake.db.recordings.push(recording(id(n), lec, CLASS_A, TEACHER_A, { partNumber: part }));
    }
  }
}

function expectedOrder() {
  const lec = new Map(state.fake.db.lectures.map((l) => [l.id, l]));
  return state.fake.db.recordings
    .filter((r) => r.status === 0 && r.state === "READY" && r.storedFileName && r.classId === CLASS_A && lec.get(r.lectureId).status === 0)
    .sort((a, b) => {
      const da = lec.get(a.lectureId).date.getTime();
      const dbb = lec.get(b.lectureId).date.getTime();
      if (da !== dbb) return dbb - da;
      if (a.lectureId !== b.lectureId) return a.lectureId < b.lectureId ? -1 : 1;
      if (a.partNumber !== b.partNumber) return a.partNumber - b.partNumber;
      return a.id < b.id ? -1 : 1;
    })
    .map((r) => r.id);
}

async function walk(query, limit) {
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 100; page += 1) {
    const res = await list(`?limit=${limit}${query}${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.data.recordedLectures.length <= limit);
    seen.push(...ids(res));
    cursor = res.body.data.nextCursor;
    if (!cursor) return seen;
  }
  throw new Error("pagination did not end");
}

test("pagination: date desc, then lecture id, part number and id; every page size gives the same sequence", async () => {
  await signIn();
  seedMany();
  const expected = expectedOrder();
  assert.equal(expected.length, 14);
  const full = await list("?limit=50");
  assert.deepEqual(ids(full), expected);
  assert.equal(full.body.data.nextCursor, null);
  for (const limit of [1, 2, 3, 5, 13, 14]) {
    assert.deepEqual(await walk("", limit), expected, `limit ${limit}`);
  }
});

test("pagination: the default page size is 20 and the last page has no cursor", async () => {
  await signIn();
  seedMany();
  for (let i = 0; i < 10; i += 1) addLecture(id(270 + i), NOW - (5 + i) * DAY, id(800 + i));
  const first = await list();
  assert.equal(first.body.data.recordedLectures.length, 20);
  assert.ok(first.body.data.nextCursor);
  const second = await list(`?cursor=${first.body.data.nextCursor}`);
  assert.equal(second.body.data.recordedLectures.length, 4);
  assert.equal(second.body.data.nextCursor, null);
  assert.deepEqual([...ids(first), ...ids(second)], expectedOrder());
});

test("pagination: stable when rows are added or removed between pages (no duplicates, no skipped survivors)", async () => {
  await signIn();
  seedMany();
  const before = expectedOrder();
  const p1 = await list("?limit=4");
  // Between pages: a new recording for an already-passed position, one for a later position, and a removal ahead.
  addLecture(id(291), NOW - 1, id(901)); // newest: sorts before the cursor, so it is not on later pages
  addLecture(id(292), NOW - 39 * DAY, id(902)); // sorts after the cursor: appears later
  const removedAhead = before[6];
  state.fake.db.recordings.find((r) => r.id === removedAhead).status = 1;
  let cursor = p1.body.data.nextCursor;
  const rest = [];
  while (cursor) {
    const res = await list(`?limit=4&cursor=${cursor}`);
    rest.push(...ids(res));
    cursor = res.body.data.nextCursor;
  }
  const seen = [...ids(p1), ...rest];
  assert.equal(new Set(seen).size, seen.length, "no duplicates");
  for (const recId of before) {
    if (recId !== removedAhead) assert.ok(seen.includes(recId), `kept ${recId}`);
  }
  assert.ok(!rest.includes(removedAhead));
  assert.ok(!seen.includes(id(901)));
  assert.ok(rest.includes(id(902)));
});

test("pagination: the dashboard scope pages with the same cursor rules", async () => {
  await signIn();
  seedMany(); // lectures 2 and 3 days ago are inside, 40 days ago is outside
  const expectedDash = expectedOrder().filter((recId) => {
    const r = state.fake.db.recordings.find((x) => x.id === recId);
    const l = state.fake.db.lectures.find((x) => x.id === r.lectureId);
    return l.date.getTime() > NOW - 7 * DAY && l.date.getTime() <= NOW;
  });
  assert.equal(expectedDash.length, 12);
  assert.deepEqual(await walk("&scope=dashboard", 5), expectedDash);
});

test("pagination: the cursor is opaque base64url holding only values the student already saw", async () => {
  await signIn();
  seedMany();
  const res = await list("?limit=1");
  const cursor = res.body.data.nextCursor;
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  const first = res.body.data.recordedLectures[0];
  assert.deepEqual(decoded, [Date.parse(first.lecture.date), first.lecture.id, first.partNumber, first.id]);
  const round = service.decodeListCursor(cursor);
  assert.equal(service.encodeListCursor(round), cursor);
});

// ---- Route boundaries ----------------------------------------------------------------------------

test("routes: list and metadata are GET only, Node.js runtime, always dynamic", () => {
  for (const route of [listRoute, detailRoute]) {
    assert.equal(route.runtime, "nodejs");
    assert.equal(route.dynamic, "force-dynamic");
    assert.deepEqual(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k)), ["GET"]);
  }
});

test("dto: every listed recording carries its relative streamUrl (no host, no token)", async () => {
  await signIn();
  const res = await list();
  for (const r of res.body.data.recordedLectures) {
    assert.equal(r.streamUrl, `/api/student/recorded-lectures/${r.id}/stream`);
  }
});

// ---- classId filter (RL-5.1, decision D-1) -------------------------------------------------------

test("classId: narrows the list to that class; combined with lectureId and the dashboard scope", async () => {
  await signIn();
  const { CLASS_A } = F;
  assert.deepEqual(ids(await list(`?classId=${CLASS_A}`)), [R.ok, R.okPart2]);
  assert.deepEqual(ids(await list(`?classId=${CLASS_A}&lectureId=${LECTURE}`)), [R.ok, R.okPart2]);
  assert.deepEqual(ids(await list(`?classId=${CLASS_A}&scope=dashboard`)), [R.ok, R.okPart2]);
  assert.deepEqual(ids(await list(`?classId=${CLASS_A}&lectureId=${LECTURE_TEACHER_B}`)), []);
});

test("classId: never widens access (other, inactive, left and other-teacher classes give no rows)", async () => {
  await signIn();
  const { CLASS_A_OTHER, CLASS_A_INACTIVE, CLASS_A_REMOVED, CLASS_B } = F;
  for (const classId of [CLASS_A_OTHER, CLASS_A_INACTIVE, CLASS_A_REMOVED, CLASS_B, id(999)]) {
    const res = await list(`?classId=${classId}`);
    assert.equal(res.status, 200, classId);
    assert.deepEqual(ids(res), [], classId);
  }
  // The same classes ARE visible to the classmate enrolled there: the filter, not the fixture, decides.
  await signIn(CLASSMATE);
  assert.deepEqual(ids(await list(`?classId=${CLASS_B}`)), [R.otherTeacher]);
  assert.deepEqual(ids(await list(`?classId=${CLASS_A_OTHER}`)), [R.otherClass]);
});

test("classId: the access filter is still applied in full (AND), only narrowed", async () => {
  await signIn();
  await list(`?classId=${F.CLASS_A}`);
  const query = recordingQueries().pop();
  assert.deepEqual(query.args.where.AND[0], service.studentRecordedLectureAccessWhere(STUDENT));
  assert.deepEqual(query.args.where.AND[query.args.where.AND.length - 1], { classId: F.CLASS_A });
});

test("classId: an invalid id is 400 INVALID_CLASS_ID before any recording query", async () => {
  await signIn();
  for (const bad of ["abc", "ABCDEF00-0000-4000-8000-000000000101", `${F.CLASS_A}x`]) {
    const res = await list(`?classId=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.error.code, "INVALID_CLASS_ID");
  }
  assert.equal(recordingQueries().length, 0);
});

test("classId: pages across parts of the same class with the cursor (no duplicates, nothing skipped)", async () => {
  await signIn();
  const { CLASS_A } = F;
  for (let i = 0; i < 6; i += 1) {
    const lec = id(400 + i);
    state.fake.db.lectures.push(lecture(lec, CLASS_A, { date: new Date(NOW - (2 + (i % 2)) * DAY) }));
    for (let part = 1; part <= 3; part += 1) state.fake.db.recordings.push(recording(id(4000 + i * 10 + part), lec, CLASS_A, TEACHER_A, { partNumber: part }));
  }
  const all = ids(await list(`?classId=${CLASS_A}&limit=50`));
  assert.equal(all.length, 20);
  const seen = [];
  let cursor = null;
  do {
    const res = await list(`?classId=${CLASS_A}&limit=4${cursor ? `&cursor=${cursor}` : ""}`);
    seen.push(...ids(res));
    cursor = res.body.data.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, all);
});
