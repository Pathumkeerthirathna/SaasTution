/*
 * Recorded Lectures RL-5.1: the server-side loaders of the student pages
 * (services/recorded-lecture-student-pages.ts), with the shared fixture and
 * the evaluating Prisma double. Recordings always come through the RL-4.2
 * service (its access filter); the loaders add the class page's enrollment
 * check and the player's multi-page part loading.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Monthly resource access is not modelled by this fixture: every month open
// (the real rule: tests/class-access/resource-access.test.cjs).
require("../helpers/no-class-access-restrictions.cjs");
const F = require("./helpers/student-fixture.cjs");

const { root, state, NOW, DAY, id, TEACHER_A, STUDENT, CLASSMATE, CLASS_A, CLASS_A_OTHER, CLASS_A_INACTIVE, CLASS_A_REMOVED, CLASS_B, LECTURE, LECTURE_DELETED, LECTURE_TEACHER_B, R, recording, lecture, seed } = F;

const pages = require(path.join(root, "services", "recorded-lecture-student-pages.ts"));
const service = require(path.join(root, "services", "recorded-lecture-student-service.ts"));
const listRoute = require(path.join(root, "app", "api", "student", "recorded-lectures", "route.ts"));

const savedDays = process.env.RECORDED_LECTURE_DASHBOARD_DAYS;
test.beforeEach(() => {
  seed();
  state.clock = NOW;
  state.cookie = null;
  delete process.env.RECORDED_LECTURE_DASHBOARD_DAYS;
});
test.after(() => {
  if (savedDays === undefined) delete process.env.RECORDED_LECTURE_DASHBOARD_DAYS;
  else process.env.RECORDED_LECTURE_DASHBOARD_DAYS = savedDays;
});

const recordingQueries = () => state.fake.queries.filter((q) => q.model === "recordedLecture");

// ---- Class picker ----------------------------------------------------------------------------------

test("classes: only ACTIVE enrollments in ACTIVE classes, by name", async () => {
  const classes = await pages.loadStudentRecordingClasses(STUDENT);
  assert.deepEqual(classes, [{ id: CLASS_A, name: "Grade 10 Maths" }]);
  const classmate = await pages.loadStudentRecordingClasses(CLASSMATE);
  assert.deepEqual(classmate.map((c) => c.id), [CLASS_A_OTHER, CLASS_B].sort((a, b) => {
    const name = (x) => state.fake.db.classes.find((c) => c.id === x).name;
    return name(a) < name(b) ? -1 : 1;
  }));
  assert.equal(recordingQueries().length, 0, "the picker reads no recordings");
});

// ---- Class page ------------------------------------------------------------------------------------

test("class page: the class's recordings through the RL-4.2 filter, with classId", async () => {
  const page = await pages.loadClassRecordings(STUDENT, CLASS_A);
  assert.equal(page.ok, true);
  assert.deepEqual(page.class, { id: CLASS_A, name: "Grade 10 Maths" });
  assert.deepEqual(page.recordedLectures.map((r) => r.id), [R.ok, R.okPart2]);
  assert.equal(page.nextCursor, null);
  const query = recordingQueries().pop();
  assert.deepEqual(query.args.where.AND[0], service.studentRecordedLectureAccessWhere(STUDENT));
  assert.ok(query.args.where.AND.some((w) => w.classId === CLASS_A));
});

test("class page: NOT_FOUND for a class not actively joined (other, inactive, left, other teacher) — no recording query", async () => {
  for (const classId of [CLASS_A_OTHER, CLASS_A_INACTIVE, CLASS_A_REMOVED, CLASS_B, id(999)]) {
    assert.deepEqual(await pages.loadClassRecordings(STUDENT, classId), { ok: false, reason: "NOT_FOUND" }, classId);
  }
  assert.equal(recordingQueries().length, 0);
});

test("class page: a malformed class id is NOT_FOUND without any database query", async () => {
  const before = state.fake.queries.length;
  for (const bad of ["x", "../etc", "ABCDEF00-0000-4000-8000-000000000101"]) {
    assert.deepEqual(await pages.loadClassRecordings(STUDENT, bad), { ok: false, reason: "NOT_FOUND" });
  }
  assert.equal(state.fake.queries.length, before);
});

test("class page: a pending student sees the class but no recordings (approval decided by the filter)", async () => {
  state.fake.db.students[0].confirmationStatus = "PENDING";
  const page = await pages.loadClassRecordings(STUDENT, CLASS_A);
  assert.equal(page.ok, true);
  assert.deepEqual(page.recordedLectures, []);
});

test("class page: invalid recorded-lecture settings give UNAVAILABLE (not an error page)", async () => {
  process.env.RECORDED_LECTURE_DASHBOARD_DAYS = "99";
  assert.deepEqual(await pages.loadClassRecordings(STUDENT, CLASS_A), { ok: false, reason: "UNAVAILABLE" });
  assert.deepEqual(await pages.loadLecturePlayer(STUDENT, LECTURE), { ok: false, reason: "UNAVAILABLE" });
});

test("class page: the first page is 50 rows; the rest pages through the API with classId + cursor", async () => {
  for (let i = 0; i < 30; i += 1) {
    const lec = id(600 + i);
    state.fake.db.lectures.push(lecture(lec, CLASS_A, { date: new Date(NOW - (2 + i) * DAY) }));
    for (let part = 1; part <= 2; part += 1) state.fake.db.recordings.push(recording(id(6000 + i * 10 + part), lec, CLASS_A, TEACHER_A, { partNumber: part }));
  }
  const page = await pages.loadClassRecordings(STUDENT, CLASS_A);
  assert.equal(page.recordedLectures.length, 50);
  assert.ok(page.nextCursor);
  await F.signIn();
  const res = await listRoute.GET(new Request(`http://localhost/api/student/recorded-lectures?classId=${CLASS_A}&cursor=${page.nextCursor}&limit=50`));
  const more = (await res.json()).data;
  assert.equal(more.recordedLectures.length, 12);
  assert.equal(more.nextCursor, null);
  const all = [...page.recordedLectures, ...more.recordedLectures].map((r) => r.id);
  assert.equal(new Set(all).size, 62);
});

// ---- Player ----------------------------------------------------------------------------------------

test("player: every visible part of the lecture, in part order, with its class", async () => {
  const page = await pages.loadLecturePlayer(STUDENT, LECTURE);
  assert.equal(page.ok, true);
  assert.equal(page.lecture.id, LECTURE);
  assert.deepEqual(page.class, { id: CLASS_A, name: "Grade 10 Maths" });
  assert.deepEqual(page.parts.map((p) => p.id), [R.ok, R.okPart2]);
  assert.equal(page.nextCursor, null);
  for (const part of page.parts) assert.equal(part.streamUrl, `/api/student/recorded-lectures/${part.id}/stream`);
});

test("player: NOT_FOUND for a lecture the student cannot see, a deleted lecture or a malformed id", async () => {
  for (const lectureId of [LECTURE_TEACHER_B, LECTURE_DELETED, id(999)]) {
    assert.deepEqual(await pages.loadLecturePlayer(STUDENT, lectureId), { ok: false, reason: "NOT_FOUND" }, lectureId);
  }
  const before = state.fake.queries.length;
  assert.deepEqual(await pages.loadLecturePlayer(STUDENT, "nope"), { ok: false, reason: "NOT_FOUND" });
  assert.equal(state.fake.queries.length, before);
  state.fake.db.classStudents[0].isActive = false; // left the class
  assert.deepEqual(await pages.loadLecturePlayer(STUDENT, LECTURE), { ok: false, reason: "NOT_FOUND" });
});

function seedParts(count) {
  const lec = id(700);
  state.fake.db.lectures.push(lecture(lec, CLASS_A, { date: new Date(NOW - 2 * DAY) }));
  for (let part = 1; part <= count; part += 1) {
    state.fake.db.recordings.push(recording(id(100000 + part), lec, CLASS_A, TEACHER_A, { partNumber: part }));
  }
  return lec;
}

test("player: up to 4 pages (200 parts) on the server; exactly 200 has no 'more' cursor", async () => {
  const lec = seedParts(200);
  const page = await pages.loadLecturePlayer(STUDENT, lec);
  assert.equal(page.parts.length, 200);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(page.parts.map((p) => p.partNumber), Array.from({ length: 200 }, (_, i) => i + 1));
  assert.equal(recordingQueries().length, 4);
});

test("player: more than 200 parts are never hidden: a cursor is returned and the API loads the rest", async () => {
  const lec = seedParts(230);
  const page = await pages.loadLecturePlayer(STUDENT, lec);
  assert.equal(page.parts.length, 200);
  assert.ok(page.nextCursor, "the page knows more parts exist");
  await F.signIn();
  let cursor = page.nextCursor;
  const rest = [];
  while (cursor) {
    const res = await listRoute.GET(new Request(`http://localhost/api/student/recorded-lectures?lectureId=${lec}&cursor=${cursor}&limit=50`));
    const data = (await res.json()).data;
    rest.push(...data.recordedLectures);
    cursor = data.nextCursor;
  }
  const all = [...page.parts, ...rest].map((p) => p.partNumber);
  assert.deepEqual(all, Array.from({ length: 230 }, (_, i) => i + 1));
});

test("player: part numbers with gaps keep their order (navigation follows the list, not the numbers)", async () => {
  const lec = id(701);
  state.fake.db.lectures.push(lecture(lec, CLASS_A));
  for (const part of [5, 1, 3]) state.fake.db.recordings.push(recording(id(200000 + part), lec, CLASS_A, TEACHER_A, { partNumber: part }));
  const page = await pages.loadLecturePlayer(STUDENT, lec);
  assert.deepEqual(page.parts.map((p) => p.partNumber), [1, 3, 5]);
});
