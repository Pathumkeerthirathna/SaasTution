/*
 * Recorded Lectures redesign, Stage 1 (backend): students' General
 * Recordings (the class's default lecture) through the existing student
 * service and API (services/recorded-lecture-student-service.ts,
 * lib/recorded-lectures/student-dto.ts):
 *   - section=general | lecture | (absent: both, as before);
 *   - isGeneral, the "General Recordings" title and the recording's own date
 *     (readyAt, else createdAt), never the default lecture's (class creation) date;
 *   - General order readyAt DESC NULLS LAST, createdAt DESC, id DESC, with its own cursor;
 *   - the dashboard window from readyAt (else createdAt) for General Recordings;
 *   - enrolment, class status and monthly locks unchanged;
 *   - public pages never list General Recordings.
 *
 *   npm run test:recorded-lectures
 *
 * The in-memory student database (helpers/student-fixture.cjs) evaluates the
 * real where / orderBy / select. Class fees are not modelled: the class-level
 * payment check reports no restriction; monthly resource access keeps its
 * real month rules with a resolver that locks state.lockedMonths.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..", "..");
function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

// The class-level payment check: no restriction (fees are not modelled here; tests/class-access covers it).
fake("services/class-access-service.ts", {
  CLASS_ACCESS_RESTRICTED: "CLASS_ACCESS_RESTRICTED",
  getClassAccessRestrictions: async () => [],
  assertContentAccessForStudent: async () => {},
  assertClassAccessForStudent: async () => {},
});

const F = require("./helpers/student-fixture.cjs");
const { state, DAY, NOW, id, TEACHER_A, STUDENT, CLASS_A, LECTURE, R, recording, lecture, seed, signIn } = F;

// Monthly resource access: the real month rules, a resolver that locks state.lockedMonths ("classId:YYYY-M").
const realAccess = require(path.join(root, "services", "resource-access-service.ts"));
const lockedDecision = (classId, month) => ({ ...month, accessible: !state.lockedMonths?.has(`${classId}:${month.year}-${month.month}`) });
fake("services/resource-access-service.ts", {
  ...realAccess,
  loadStudentResourceAccess: async () => ({ decide: (classId, month) => lockedDecision(classId, month) }),
  assertResourceAccessForStudent: async (_studentId, ref) => {
    const row = state.fake.db.recordings.find((r) => r.id === ref.recordingId);
    if (!row) return;
    const decision = lockedDecision(row.classId, realAccess.billingMonthOf(row.createdAt));
    if (!decision.accessible) throw realAccess.lockedResourceError(decision);
  },
});

const D = require(path.join(root, "lib", "recorded-lectures", "student-dto.ts"));
const service = require(path.join(root, "services", "recorded-lecture-student-service.ts"));
const publicService = require(path.join(root, "services", "recorded-lecture-public-service.ts"));
const listRoute = require(path.join(root, "app", "api", "student", "recorded-lectures", "route.ts"));
const detailRoute = require(path.join(root, "app", "api", "student", "recorded-lectures", "[recordingId]", "route.ts"));
const streamRoute = require(path.join(root, "app", "api", "student", "recorded-lectures", "[recordingId]", "stream", "route.ts"));

const DEFAULT_A = id(290); // CLASS_A's default lecture (created with the class, long ago)
const DEFAULT_INACTIVE = id(291); // the deactivated class's
const DEFAULT_REMOVED = id(292); // the class the student left
const CLASS_CREATED = new Date("2026-01-05T00:00:00.000Z");
const G = { newest: id(601), middle: id(602), old: id(603), noReadyAt: id(604), inactive: id(605), removed: id(606), sameReady: id(607) };
const H = 60 * 60 * 1000;

test.beforeEach(() => {
  seed();
  state.cookie = null;
  state.clock = NOW;
  state.lockedMonths = new Set();
  delete process.env.RECORDED_LECTURE_DASHBOARD_DAYS;
  const { db } = state.fake;
  db.lectures.push(
    lecture(DEFAULT_A, CLASS_A, { title: "General Notes", date: CLASS_CREATED, isDefault: true }),
    lecture(DEFAULT_INACTIVE, id(103), { title: "General Notes", date: CLASS_CREATED, isDefault: true }),
    lecture(DEFAULT_REMOVED, id(104), { title: "General Notes", date: CLASS_CREATED, isDefault: true })
  );
  const general = (recId, extra) => recording(recId, DEFAULT_A, CLASS_A, TEACHER_A, extra);
  db.recordings.push(
    general(G.newest, { title: "Course intro", partNumber: 1, createdAt: new Date(NOW - 4 * H), readyAt: new Date(NOW - 3 * H) }),
    general(G.middle, { title: "Revision tips", partNumber: 2, createdAt: new Date(NOW - 3 * DAY), readyAt: new Date(NOW - 2 * DAY) }),
    general(G.sameReady, { title: "Same time", partNumber: 5, createdAt: new Date(NOW - 3 * DAY - H), readyAt: new Date(NOW - 2 * DAY) }),
    general(G.old, { title: "Old one", partNumber: 3, createdAt: new Date(NOW - 11 * DAY), readyAt: new Date(NOW - 10 * DAY) }),
    // Not a state the database allows for READY (readyAt is required then); defence in depth for the order.
    general(G.noReadyAt, { title: "No readyAt", partNumber: 4, createdAt: new Date(NOW - H), readyAt: null }),
    recording(G.inactive, DEFAULT_INACTIVE, id(103), TEACHER_A, { createdAt: new Date(NOW - H), readyAt: new Date(NOW - H) }),
    recording(G.removed, DEFAULT_REMOVED, id(104), TEACHER_A, { createdAt: new Date(NOW - H), readyAt: new Date(NOW - H) })
  );
});

async function call(handler, url, params) {
  const response = await handler(new Request(`http://localhost${url}`), { params });
  return { status: response.status, body: response.status < 300 && response.headers.get("content-type")?.includes("video") ? null : await response.json().catch(() => null) };
}
const list = (query = "") => call(listRoute.GET, `/api/student/recorded-lectures${query}`);
const ids = (res) => res.body.data.recordedLectures.map((r) => r.id);

// ---- Sections and the DTO -----------------------------------------------------------------------------

// Part numbers: newest 1, middle 2, old 3, noReadyAt 4, sameReady 5.
const PART_ORDER = () => [G.newest, G.middle, G.old, G.noReadyAt, G.sameReady];

test("section=general (the class page): only General Recordings, part number ascending (the player's order)", async () => {
  await signIn();
  const res = await list("?section=general");
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), PART_ORDER());
  assert.deepEqual(res.body.data.recordedLectures.map((r) => r.partNumber), [1, 2, 3, 4, 5]);
  assert.ok(res.body.data.recordedLectures.every((r) => r.isGeneral === true));
});

test("section=general on the dashboard: newest available first (readyAt), ties by createdAt then id, no readyAt last", async () => {
  await signIn();
  const res = await list("?scope=dashboard&section=general");
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), [G.newest, G.middle, G.sameReady, G.noReadyAt], "G.old (10 days) is outside the window");
  // The dashboard limit keeps the most recent General Recordings (not the lowest part numbers).
  assert.deepEqual(ids(await list("?scope=dashboard&section=general&limit=2")), [G.newest, G.middle]);
});

test("General Recordings carry isGeneral, the 'General Recordings' title and their own date; never the class's creation date", async () => {
  await signIn();
  const [first] = (await list("?section=general")).body.data.recordedLectures;
  assert.deepEqual(first.lecture, { id: DEFAULT_A, title: "General Recordings", date: new Date(NOW - 3 * H).toISOString(), endDate: null });
  assert.equal(first.isGeneral, true);
  const all = JSON.stringify((await list("?section=general")).body);
  assert.ok(!all.includes(CLASS_CREATED.toISOString()), "the default lecture's date is never sent");
  assert.ok(!all.includes("General Notes"), "nor its internal title");
  const fallback = (await list("?section=general")).body.data.recordedLectures.find((r) => r.id === G.noReadyAt);
  assert.equal(fallback.lecture.date, new Date(NOW - H).toISOString(), "no readyAt: createdAt");
});

test("section=lecture: only normal lecture recordings, exactly as before; no section: both (existing callers unchanged)", async () => {
  await signIn();
  const lectures = await list("?section=lecture");
  assert.deepEqual(ids(lectures).sort(), [R.ok, R.okPart2].sort());
  for (const r of lectures.body.data.recordedLectures) {
    assert.equal(r.isGeneral, false);
    assert.deepEqual(r.lecture, { id: LECTURE, title: `Lecture ${LECTURE.slice(-3)}`, date: new Date(NOW - DAY).toISOString(), endDate: null });
  }
  const all = await list();
  assert.deepEqual(new Set(ids(all)), new Set([R.ok, R.okPart2, G.newest, G.middle, G.sameReady, G.old, G.noReadyAt]));
  assert.deepEqual(ids(all).slice(0, 2), [R.ok, R.okPart2], "the existing order: lecture date desc (the default lecture's old date last)");
  const invalid = await list("?section=everything");
  assert.deepEqual([invalid.status, invalid.body.error.code], [400, "INVALID_SECTION"]);
});

async function pageThrough(query, limit) {
  const seen = [];
  let cursor = null;
  for (let i = 0; i < 10; i += 1) {
    const res = await list(`${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(res.status, 200);
    seen.push(...ids(res));
    cursor = res.body.data.nextCursor;
    if (!cursor) break;
  }
  return seen;
}

test("General pagination: every page size gives the same sequence, in both orders; the dashboard's own cursor is never mixed with the lecture cursor", async () => {
  await signIn();
  for (const limit of [1, 2, 3]) {
    assert.deepEqual(await pageThrough("?section=general", limit), PART_ORDER(), `class page, limit ${limit}`);
    assert.deepEqual(await pageThrough("?scope=dashboard&section=general", limit), [G.newest, G.middle, G.sameReady, G.noReadyAt], `dashboard, limit ${limit}`);
  }
  const dashboardCursor = (await list("?scope=dashboard&section=general&limit=1")).body.data.nextCursor;
  const classPageCursor = (await list("?section=general&limit=1")).body.data.nextCursor;
  const lectureCursor = (await list("?section=lecture&limit=1")).body.data.nextCursor;
  // The dashboard General cursor ("g") only works on the dashboard General list, and vice versa.
  assert.equal((await list(`?section=general&cursor=${dashboardCursor}`)).status, 400);
  assert.equal((await list(`?section=lecture&cursor=${dashboardCursor}`)).status, 400);
  assert.equal((await list(`?scope=dashboard&section=general&cursor=${classPageCursor}`)).status, 400);
  assert.equal((await list(`?scope=dashboard&section=general&cursor=${lectureCursor}`)).status, 400);
  assert.deepEqual(Object.keys(service.decodeGeneralListCursor(dashboardCursor)).sort(), ["createdAt", "id", "readyAt"]);
  assert.equal(service.decodeGeneralListCursor(classPageCursor), null, "the class page uses the lecture cursor (part order)");
  assert.notEqual(service.decodeListCursor(classPageCursor), null);
});

// ---- Dashboard ----------------------------------------------------------------------------------------

test("dashboard: General Recordings from when they became available (7 days); normal lectures from their start, as before", async () => {
  await signIn();
  const res = await list("?scope=dashboard");
  assert.deepEqual(new Set(ids(res)), new Set([R.ok, R.okPart2, G.newest, G.middle, G.sameReady, G.noReadyAt]), "G.old (10 days) is outside");
  const first = res.body.data.recordedLectures.find((r) => r.id === G.newest);
  assert.deepEqual(first.dashboard, { visible: true, visibleFrom: new Date(NOW - 3 * H).toISOString(), visibleUntil: new Date(NOW - 3 * H + 7 * DAY).toISOString() });
  const old = (await list("?section=general")).body.data.recordedLectures.find((r) => r.id === G.old);
  assert.equal(old.dashboard.visible, false);
});

test("dashboard: a NEW class's old General Recording does not appear just because the default lecture is recent", async () => {
  await signIn();
  // The class was created yesterday (its default lecture's date), but the recording became available 20 days ago.
  state.fake.db.lectures.find((l) => l.id === DEFAULT_A).date = new Date(NOW - DAY);
  state.fake.db.recordings.find((r) => r.id === G.old).readyAt = new Date(NOW - 20 * DAY);
  const res = await list("?scope=dashboard&section=general");
  assert.ok(!ids(res).includes(G.old));
});

// ---- Access ---------------------------------------------------------------------------------------------

test("enrolment and class status: General Recordings of a deactivated class or a left class are never listed or readable", async () => {
  await signIn();
  const all = ids(await list("?section=general"));
  assert.ok(!all.includes(G.inactive) && !all.includes(G.removed));
  for (const recId of [G.inactive, G.removed]) {
    const res = await call(detailRoute.GET, `/api/student/recorded-lectures/${recId}`, { recordingId: recId });
    assert.equal(res.status, 404, recId);
  }
  const mine = await call(detailRoute.GET, `/api/student/recorded-lectures/${G.newest}`, { recordingId: G.newest });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.recordedLecture.isGeneral, true);
});

test("monthly locks: a General Recording of a locked month is listed without its stream; its metadata and stream are 403", async () => {
  await signIn();
  const month = realAccess.billingMonthOf(new Date(NOW - 4 * H)); // G.newest's createdAt (the upload start)
  state.lockedMonths.add(`${CLASS_A}:${month.year}-${month.month}`);
  const res = await list("?section=general");
  const newest = res.body.data.recordedLectures.find((r) => r.id === G.newest);
  assert.equal(newest.streamUrl, null);
  assert.equal(newest.resourceAccess.locked, true);
  assert.equal((await call(detailRoute.GET, `/api/student/recorded-lectures/${G.newest}`, { recordingId: G.newest })).status, 403);
  assert.equal((await call(streamRoute.GET, `/api/student/recorded-lectures/${G.newest}/stream`, { recordingId: G.newest })).status, 403);
});

test("the playback filter is the existing one (no default-lecture exclusion): General Recordings play through the same stream route", () => {
  const where = service.studentRecordedLectureAccessWhere(STUDENT);
  assert.deepEqual(where.lecture, { status: 0 });
  const fs = require("node:fs");
  const stream = fs.readFileSync(path.join(root, "services", "recorded-lecture-stream-service.ts"), "utf8");
  assert.match(stream, /where: \{ AND: \[\{ id: recordingId \}, studentRecordedLectureAccessWhere\(studentId\)\] \}/);
});

test("the DTO: isGeneral on every recording; a General Recording without readyAt or createdAt is refused (never the lecture's date)", () => {
  const base = {
    id: R.ok, title: "x", partNumber: 1, sizeBytes: BigInt(1), durationSeconds: 1, width: null, height: null,
    lecture: { id: DEFAULT_A, title: "General Notes", date: CLASS_CREATED, endDate: null, isDefault: true }, class: { id: CLASS_A, name: "c" },
  };
  assert.equal(D.buildStudentRecordedLectureDto({ ...base, readyAt: null, createdAt: new Date(NOW) }, { now: new Date(NOW), dashboardDays: 7 }).lecture.date, new Date(NOW).toISOString());
  assert.throws(() => D.buildStudentRecordedLectureDto({ ...base, readyAt: null, createdAt: null }, { now: new Date(NOW), dashboardDays: 7 }), TypeError);
  const normal = D.buildStudentRecordedLectureDto({ ...base, readyAt: new Date(NOW), lecture: { ...base.lecture, isDefault: false } }, { now: new Date(NOW), dashboardDays: 7 });
  assert.equal(normal.isGeneral, false);
  assert.equal(normal.lecture.title, "General Notes", "a normal lecture keeps its own title");
});

// ---- Public pages ---------------------------------------------------------------------------------------

test("public pages: General Recordings are never listed, playable or in the restricted-student fallback (one shared rule)", () => {
  assert.deepEqual(publicService.publicRecordedLectureWhere().lecture, { status: 0, isDefault: false });
  assert.deepEqual(publicService.publicPlayableRecordedLectureWhere().AND[0].lecture, { status: 0, isDefault: false });
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(root, "services", "recorded-lecture-public-service.ts"), "utf8");
  // Listing, playback and the restricted fallback all read through publicRecordedLectureWhere().
  assert.match(src, /where: publicRecordedLectureWhere\(\)|publicRecordedLectureWhere\(\)/);
  assert.match(src, /playablePublicSessions\(await getPublicClassSessionsWithUploads\(classId\)\)/);
});

// ---- Stage 3: the page loaders (class page sections, player) ---------------------------------------------

const pages = require(path.join(root, "services", "recorded-lecture-student-pages.ts"));

test("class page loader: General Recordings first page (section general, part order) and the lecture recordings (section lecture), never mixed", async () => {
  const page = await pages.loadClassRecordings(STUDENT, CLASS_A);
  assert.equal(page.ok, true);
  assert.deepEqual(page.general.recordedLectures.map((r) => r.id), PART_ORDER());
  assert.ok(page.general.recordedLectures.every((r) => r.isGeneral === true));
  assert.equal(page.general.nextCursor, null);
  assert.deepEqual(page.recordedLectures.map((r) => r.id).sort(), [R.ok, R.okPart2].sort());
  assert.ok(page.recordedLectures.every((r) => r.isGeneral === false));
  const generalQueries = state.fake.queries.filter((q) => q.model === "recordedLecture" && JSON.stringify(q.args?.where ?? q.where ?? {}).includes('"isDefault":true'));
  assert.ok(generalQueries.length >= 1, "the General section asked for the default lecture only");
});

test("class page loader: another class, a left class or a deactivated class is NOT_FOUND (General Recordings included)", async () => {
  for (const classId of [id(102), id(103), id(104)]) {
    assert.deepEqual(await pages.loadClassRecordings(STUDENT, classId), { ok: false, reason: "NOT_FOUND" }, classId);
  }
});

test("class page loader: monthly locks mark General parts (no stream) and lecture parts alike", async () => {
  const month = realAccess.billingMonthOf(new Date(NOW - 4 * H));
  state.lockedMonths.add(`${CLASS_A}:${month.year}-${month.month}`);
  const page = await pages.loadClassRecordings(STUDENT, CLASS_A);
  const newest = page.general.recordedLectures.find((r) => r.id === G.newest);
  assert.deepEqual([newest.resourceAccess.locked, newest.streamUrl], [true, null]);
});

test("player loader: the class's General Recordings play as one list in part order, flagged isGeneral; a normal lecture is unchanged", async () => {
  const general = await pages.loadLecturePlayer(STUDENT, DEFAULT_A);
  assert.equal(general.ok, true);
  assert.equal(general.isGeneral, true);
  assert.deepEqual(general.parts.map((p) => p.partNumber), [1, 2, 3, 4, 5], "sequential part numbers");
  const classPage = await pages.loadClassRecordings(STUDENT, CLASS_A);
  assert.deepEqual(general.parts.map((p) => p.id), classPage.general.recordedLectures.map((r) => r.id), "the class page and the player list the same order");
  assert.equal(general.lecture.title, "General Recordings");
  const normal = await pages.loadLecturePlayer(STUDENT, LECTURE);
  assert.equal(normal.isGeneral, false);
  assert.equal(normal.lecture.title, `Lecture ${LECTURE.slice(-3)}`);
  assert.equal(normal.lecture.date, new Date(NOW - DAY).toISOString());
  assert.deepEqual(await pages.loadLecturePlayer(STUDENT, DEFAULT_INACTIVE), { ok: false, reason: "NOT_FOUND" }, "a deactivated class's General Recordings");
});
