/*
 * Recorded Lectures RL-4.2: the student dashboard window (pure) and the
 * student DTO allow-list.
 *
 *   lecture.date <= now < lecture.date + days * 24 h   (real UTC instants)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const W = require(path.join(root, "lib", "recorded-lectures", "dashboard-window.ts"));
const D = require(path.join(root, "lib", "recorded-lectures", "student-dto.ts"));
const { FORBIDDEN_DTO_KEYS } = require(path.join(root, "lib", "recorded-lectures", "upload-dto.ts"));
const { parseSriLankaLocalDateTime } = require(path.join(root, "lib", "time.ts"));

const DAY = 24 * 60 * 60 * 1000;
const START = new Date("2026-11-10T04:30:00.000Z"); // 10:00 in Sri Lanka
const at = (ms) => new Date(START.getTime() + ms);

// ---- Window boundaries ---------------------------------------------------------------------------

test("window: visible from the exact lecture start, not one millisecond before", () => {
  assert.equal(W.dashboardWindowFor(START, at(0), 7).visible, true);
  assert.equal(W.dashboardWindowFor(START, at(-1), 7).visible, false);
  assert.equal(W.dashboardWindowFor(START, at(-DAY), 7).visible, false);
});

test("window: visible until one millisecond before start + 7 days; the end instant is excluded", () => {
  assert.equal(W.dashboardWindowFor(START, at(7 * DAY - 1), 7).visible, true);
  assert.equal(W.dashboardWindowFor(START, at(7 * DAY), 7).visible, false);
  assert.equal(W.dashboardWindowFor(START, at(30 * DAY), 7).visible, false);
});

test("window: visibleFrom / visibleUntil are the exact instants", () => {
  const w = W.dashboardWindowFor(START, at(DAY), 7);
  assert.equal(w.visibleFrom.toISOString(), "2026-11-10T04:30:00.000Z");
  assert.equal(w.visibleUntil.toISOString(), "2026-11-17T04:30:00.000Z");
});

test("window: the configured day count is used (1 and 30)", () => {
  assert.equal(W.dashboardWindowFor(START, at(DAY - 1), 1).visible, true);
  assert.equal(W.dashboardWindowFor(START, at(DAY), 1).visible, false);
  assert.equal(W.dashboardWindowFor(START, at(30 * DAY - 1), 30).visible, true);
  assert.equal(W.dashboardWindowFor(START, at(30 * DAY), 30).visible, false);
});

test("window: invalid day counts and dates throw (never a silently open or closed window)", () => {
  for (const days of [0, -1, 31, 1.5, Number.NaN, Infinity]) {
    assert.throws(() => W.dashboardWindowFor(START, START, days), RangeError, String(days));
    assert.throws(() => W.dashboardLectureStartRange(START, days), RangeError, String(days));
  }
  assert.throws(() => W.dashboardWindowFor(new Date(Number.NaN), START, 7), TypeError);
  assert.throws(() => W.dashboardWindowFor(START, "2026-11-10", 7), TypeError);
  assert.throws(() => W.dashboardLectureStartRange(new Date(Number.NaN), 7), TypeError);
});

test("window: the database range matches dashboardWindowFor exactly (boundaries and random instants)", () => {
  const now = new Date("2026-11-14T10:00:00.000Z");
  const range = W.dashboardLectureStartRange(now, 7);
  assert.equal(range.lte.toISOString(), "2026-11-14T10:00:00.000Z");
  assert.equal(range.gt.toISOString(), "2026-11-07T10:00:00.000Z");
  const inRange = (d) => d.getTime() > range.gt.getTime() && d.getTime() <= range.lte.getTime();
  const samples = [0, 1, -1, 7 * DAY, 7 * DAY - 1, 7 * DAY + 1, -DAY, 3 * DAY].map((back) => new Date(now.getTime() - back));
  let seed = 42;
  for (let i = 0; i < 2000; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    samples.push(new Date(now.getTime() - 9 * DAY + (seed % (11 * DAY))));
  }
  for (const start of samples) {
    assert.equal(inRange(start), W.dashboardWindowFor(start, now, 7).visible, start.toISOString());
  }
});

// ---- Sri Lankan midnight -------------------------------------------------------------------------

test("window: a lecture at Sri Lankan midnight ends at Sri Lankan midnight seven days later (UTC 18:30)", () => {
  const start = parseSriLankaLocalDateTime("2026-11-14T00:00"); // the real instant
  assert.equal(start.toISOString(), "2026-11-13T18:30:00.000Z");
  const w = W.dashboardWindowFor(start, start, 7);
  assert.equal(w.visibleUntil.toISOString(), "2026-11-20T18:30:00.000Z"); // 2026-11-21 00:00 Sri Lanka
  assert.equal(W.dashboardWindowFor(start, new Date("2026-11-20T18:29:59.999Z"), 7).visible, true);
  assert.equal(W.dashboardWindowFor(start, new Date("2026-11-20T18:30:00.000Z"), 7).visible, false);
  // Before the start: 23:59:59.999 on the previous Sri Lankan day.
  assert.equal(W.dashboardWindowFor(start, new Date("2026-11-13T18:29:59.999Z"), 7).visible, false);
});

test("window: a lecture at 23:59 Sri Lanka (a different UTC date) is still exactly 7 x 24 h", () => {
  const start = parseSriLankaLocalDateTime("2026-11-14T23:59");
  assert.equal(start.toISOString(), "2026-11-14T18:29:00.000Z");
  const w = W.dashboardWindowFor(start, start, 7);
  assert.equal(w.visibleUntil.getTime() - start.getTime(), 7 * DAY);
});

test("window: the server's own timezone never changes the result", () => {
  const saved = process.env.TZ;
  const start = parseSriLankaLocalDateTime("2026-11-14T00:00");
  const results = [];
  try {
    for (const tz of ["UTC", "Asia/Colombo", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      const w = W.dashboardWindowFor(start, new Date("2026-11-20T18:29:59.999Z"), 7);
      const r = W.dashboardLectureStartRange(new Date("2026-11-20T18:29:59.999Z"), 7);
      results.push(JSON.stringify([w.visible, w.visibleUntil.toISOString(), r.gt.toISOString(), r.lte.toISOString()]));
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
  assert.equal(new Set(results).size, 1, results.join("\n"));
});

test("window: the module never reads a clock or Sri Lankan shifted time", () => {
  const src = require("node:fs").readFileSync(path.join(root, "lib", "recorded-lectures", "dashboard-window.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /Date\.now|new Date\(\)|nowInSriLanka|toSriLankaWallClock|getHours|getDate\(|setDate|getTimezoneOffset|toLocale/);
});

// ---- DTO -----------------------------------------------------------------------------------------

function row(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000501",
    title: "Algebra part 1",
    partNumber: 1,
    sizeBytes: BigInt("9007199254740993"), // 2^53 + 1: not exact as a JS number
    durationSeconds: 3600,
    width: 1920,
    height: 1080,
    readyAt: new Date("2026-11-10T06:00:00.000Z"),
    lecture: { id: "00000000-0000-4000-8000-000000000201", title: "Algebra", date: START, endDate: null },
    class: { id: "00000000-0000-4000-8000-000000000101", name: "Grade 10" },
    ...overrides,
  };
}

test("dto: exactly the allow-listed keys, at every level", () => {
  const dto = D.buildStudentRecordedLectureDto(row(), { now: at(DAY), dashboardDays: 7 });
  assert.deepEqual(Object.keys(dto).sort(), [
    "class", "dashboard", "durationSeconds", "height", "id", "lecture", "partNumber", "readyAt", "sizeBytes", "streamUrl", "title", "width",
  ]);
  assert.equal(dto.streamUrl, "/api/student/recorded-lectures/00000000-0000-4000-8000-000000000501/stream");
  assert.deepEqual(Object.keys(dto.lecture).sort(), ["date", "endDate", "id", "title"]);
  assert.deepEqual(Object.keys(dto.class).sort(), ["id", "name"]);
  assert.deepEqual(Object.keys(dto.dashboard).sort(), ["visible", "visibleFrom", "visibleUntil"]);
});

test("dto: sizeBytes is the exact decimal string of the BigInt", () => {
  const dto = D.buildStudentRecordedLectureDto(row(), { now: at(DAY), dashboardDays: 7 });
  assert.equal(dto.sizeBytes, "9007199254740993");
  assert.equal(typeof dto.sizeBytes, "string");
  assert.equal(D.buildStudentRecordedLectureDto(row({ sizeBytes: BigInt(0) }), { now: START, dashboardDays: 7 }).sizeBytes, "0");
  assert.throws(() => D.buildStudentRecordedLectureDto(row({ sizeBytes: 5 }), { now: START, dashboardDays: 7 }), TypeError);
  assert.throws(() => D.buildStudentRecordedLectureDto(row({ sizeBytes: BigInt(-1) }), { now: START, dashboardDays: 7 }), TypeError);
});

test("dto: extra columns on the input row (stored name, teacher, original file name...) never reach the output", () => {
  const leaky = row({
    storedFileName: "0123456789abcdef0123456789abcdef.mp4",
    displayFileName: "Mr Perera private lesson.mp4",
    teacherId: "00000000-0000-4000-8000-000000000001",
    classId: "00000000-0000-4000-8000-000000000101",
    failureCode: "X",
    state: "READY",
    status: 0,
  });
  leaky.lecture = { ...leaky.lecture, classId: "x", status: 0 };
  leaky.class = { ...leaky.class, teacherId: "00000000-0000-4000-8000-000000000001" };
  const dto = D.buildStudentRecordedLectureDto(leaky, { now: START, dashboardDays: 7 });
  const text = JSON.stringify(dto);
  for (const secret of ["0123456789abcdef", "Mr Perera", "00000000-0000-4000-8000-000000000001", "teacherId", "classId", "storedFileName", "failureCode"]) {
    assert.ok(!text.includes(secret), secret);
  }
});

test("dto: dates are ISO strings and the dashboard flag follows the window", () => {
  const inside = D.buildStudentRecordedLectureDto(row({ lecture: { ...row().lecture, endDate: at(2 * 3600_000) } }), { now: at(7 * DAY - 1), dashboardDays: 7 });
  assert.equal(inside.readyAt, "2026-11-10T06:00:00.000Z");
  assert.equal(inside.lecture.date, "2026-11-10T04:30:00.000Z");
  assert.equal(inside.lecture.endDate, "2026-11-10T06:30:00.000Z");
  assert.deepEqual(inside.dashboard, { visible: true, visibleFrom: "2026-11-10T04:30:00.000Z", visibleUntil: "2026-11-17T04:30:00.000Z" });
  const outside = D.buildStudentRecordedLectureDto(row({ readyAt: null }), { now: at(7 * DAY), dashboardDays: 7 });
  assert.equal(outside.dashboard.visible, false);
  assert.equal(outside.readyAt, null);
  assert.equal(outside.lecture.endDate, null);
});

test("dto guard: every upload-forbidden and student-forbidden key is rejected at any depth", () => {
  for (const key of [...FORBIDDEN_DTO_KEYS, ...D.STUDENT_FORBIDDEN_DTO_KEYS]) {
    assert.throws(() => D.assertStudentClientSafe({ a: [{ b: { [key]: "x" } }] }), TypeError, key);
  }
  for (const key of ["displayFileName", "storedFileName", "teacherId", "uploadId", "leaseToken", "failureCode", "path", "key"]) {
    assert.ok([...FORBIDDEN_DTO_KEYS, ...D.STUDENT_FORBIDDEN_DTO_KEYS].includes(key), key);
  }
  assert.throws(() => D.assertStudentClientSafe({ size: BigInt(1) }), TypeError);
  assert.throws(() => D.assertStudentClientSafe({ at: new Date() }), TypeError);
  assert.doesNotThrow(() => D.assertStudentClientSafe({ ok: [1, "a", null, true, { id: "x" }] }));
});
