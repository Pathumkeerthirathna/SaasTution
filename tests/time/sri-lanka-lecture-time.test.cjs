/*
 * Lecture date/time in Sri Lankan time (Asia/Colombo), whatever the server's
 * or browser's timezone (production runs Europe/Berlin).
 *
 *   npm run test:time
 *
 * Runs the real lib/time.ts, lib/lecture-validation.ts, calendar service,
 * student countdown service and attendance analytics through tsx; only Prisma
 * is faked. Every expectation is a fixed UTC instant, so the suite passes in
 * any process timezone (also run it once with TZ=Europe/Berlin on Linux).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

// ---- Fake Prisma (records the arguments, returns canned rows) ---------------

const calls = [];
const rows = {};

function model(name) {
  return new Proxy(
    {},
    {
      get: (_target, method) => async (args) => {
        calls.push({ model: name, method, args });
        const value = rows[`${name}.${String(method)}`];
        return typeof value === "function" ? value(args) : value ?? [];
      },
    }
  );
}

const fakePrisma = new Proxy({}, { get: (_target, name) => model(String(name)) });

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

fake("lib/prisma.ts", { prisma: fakePrisma });

function reset() {
  calls.length = 0;
  for (const key of Object.keys(rows)) delete rows[key];
}

const time = require(path.join(root, "lib", "time.ts"));
const { createLectureSchema, updateLectureSchema } = require(path.join(root, "lib", "lecture-validation.ts"));
const { getTeacherCalendar, getStudentCalendar } = require(path.join(root, "services", "calendar-service.ts"));
const { getStudentUpcomingCountdowns } = require(path.join(root, "services", "student-countdown-service.ts"));
const { getStudentAttendanceAnalytics } = require(path.join(root, "services", "student-service.ts"));

const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const iso = (d) => d.toISOString();
const create = (date) => createLectureSchema.safeParse({ classId: CLASS_ID, title: "Maths", date });
const update = (date) => updateLectureSchema.safeParse({ date });

// ---- 1. Creating a lecture: datetime-local is Sri Lankan time ----------------

test("6:00 PM Sri Lankan time (winter in Berlin) is stored as 12:30 UTC", () => {
  const parsed = create("2026-11-08T18:00");
  assert.ok(parsed.success);
  assert.equal(iso(parsed.data.date), "2026-11-08T12:30:00.000Z");
});

test("6:00 PM Sri Lankan time in Berlin summer time has no 1-hour drift", () => {
  assert.equal(iso(create("2026-07-08T18:00").data.date), "2026-07-08T12:30:00.000Z");
});

test("11:30 PM Sri Lankan time stays on the same Sri Lankan day", () => {
  const date = create("2026-11-08T23:30").data.date;
  assert.equal(iso(date), "2026-11-08T18:00:00.000Z");
  assert.equal(time.sriLankaDateKey(date), "2026-11-08");
  assert.equal(time.sriLankaTimeKey(date), "23:30");
});

test("month boundary: 30 Nov 23:30 and 1 Dec 00:15 fall in their own Sri Lankan months", () => {
  const late = create("2026-11-30T23:30").data.date;
  const early = create("2026-12-01T00:15").data.date;
  assert.equal(iso(late), "2026-11-30T18:00:00.000Z");
  assert.equal(iso(early), "2026-11-30T18:45:00.000Z");
  assert.equal(time.sriLankaDateKey(late), "2026-11-30");
  assert.equal(time.sriLankaDateKey(early), "2026-12-01");
  assert.deepEqual(time.sriLankaCalendarParts(early), { year: 2026, month: 12, weekday: 2 });
});

test("year boundary: 31 Dec 23:59 and 1 Jan 00:00", () => {
  const last = create("2026-12-31T23:59").data.date;
  const first = create("2027-01-01T00:00").data.date;
  assert.equal(iso(last), "2026-12-31T18:29:00.000Z");
  assert.equal(time.sriLankaDateKey(last), "2026-12-31");
  assert.equal(iso(first), "2026-12-31T18:30:00.000Z");
  assert.equal(time.sriLankaDateKey(first), "2027-01-01");
});

test("Berlin DST transitions (non-existent / repeated Berlin hours) are a plain -5:30", () => {
  // 2026-03-29 02:00-03:00 does not exist in Berlin; 2026-10-25 02:00-03:00 repeats.
  assert.equal(iso(create("2026-03-29T02:30").data.date), "2026-03-28T21:00:00.000Z");
  assert.equal(iso(create("2026-03-29T03:30").data.date), "2026-03-28T22:00:00.000Z");
  assert.equal(iso(create("2026-10-25T02:30").data.date), "2026-10-24T21:00:00.000Z");
  assert.equal(iso(create("2026-10-25T03:30").data.date), "2026-10-24T22:00:00.000Z");
});

test("seconds and milliseconds in a datetime-local value are honoured", () => {
  assert.equal(iso(create("2026-11-08T18:00:45").data.date), "2026-11-08T12:30:45.000Z");
  assert.equal(iso(create("2026-11-08T18:00:45.5").data.date), "2026-11-08T12:30:45.500Z");
});

// ---- 2. Backward compatibility: ISO with Z / offset unchanged --------------

test("existing ISO API inputs with Z or an explicit offset are unchanged", () => {
  assert.equal(iso(create("2026-11-08T12:30:00.000Z").data.date), "2026-11-08T12:30:00.000Z");
  assert.equal(iso(create("2026-11-08T18:00:00+05:30").data.date), "2026-11-08T12:30:00.000Z");
  assert.equal(iso(create("2026-11-08T18:00:00+01:00").data.date), "2026-11-08T17:00:00.000Z");
  assert.equal(iso(update("2026-11-08T12:30:00.000Z").data.date), "2026-11-08T12:30:00.000Z");
  assert.equal(iso(create(new Date("2026-11-08T12:30:00Z")).data.date), "2026-11-08T12:30:00.000Z");
});

// ---- 3. Invalid input is rejected safely -----------------------------------

test("malformed and impossible dates are rejected", () => {
  for (const bad of ["2026-13-01T10:00", "2026-02-30T10:00", "2026-11-08T24:00", "2026-11-08T18:60", "abc", "", "   "]) {
    assert.equal(create(bad).success, false, `create accepted ${JSON.stringify(bad)}`);
    assert.equal(update(bad).success, false, `update accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(create(undefined).success, false, "date is required on create");
  assert.equal(updateLectureSchema.safeParse({}).success, false, "update still needs a field");
  assert.equal(updateLectureSchema.safeParse({ title: "New title" }).success, true, "title-only update still works");
  assert.equal(time.parseSriLankaLocalDateTime("2026-11-08T18:00Z"), null);
  assert.equal(time.parseSriLankaLocalDateTime("2026-11-08"), null, "date-only values are not lecture times");
});

// ---- 4. Edit form round trip -----------------------------------------------

test("create then edit without changing the time keeps the exact same instant", () => {
  for (const typed of ["2026-11-08T18:00", "2026-11-08T23:30", "2026-12-01T00:15", "2026-07-08T06:05"]) {
    const stored = create(typed).data.date;
    const shownInEditForm = time.toSriLankaDateTimeLocal(new Date(iso(stored)));
    assert.equal(shownInEditForm, typed);
    assert.equal(iso(update(shownInEditForm).data.date), iso(stored));
  }
});

test("create then reschedule moves to the new Sri Lankan time", () => {
  const stored = create("2026-11-08T18:00").data.date;
  const rescheduled = update("2026-11-09T07:00").data.date;
  assert.notEqual(iso(rescheduled), iso(stored));
  assert.equal(iso(rescheduled), "2026-11-09T01:30:00.000Z");
  assert.equal(time.sriLankaDateKey(rescheduled), "2026-11-09");
  assert.equal(time.sriLankaTimeKey(rescheduled), "07:00");
});

test("a browser outside Sri Lanka still edits Sri Lankan time (form value never uses the browser zone)", () => {
  const stored = new Date("2026-11-08T12:30:00.000Z");
  assert.equal(time.toSriLankaDateTimeLocal(stored), "2026-11-08T18:00");
  assert.equal(
    stored.toLocaleString("en-GB", { timeZone: "Asia/Colombo", hour12: false }),
    "08/11/2026, 18:00:00"
  );
});

// ---- 5. Weekly schedule occurrences (Overview + student countdown) ----------

test("next weekly occurrence uses Sri Lankan wall-clock time", () => {
  // Sunday 23:00 in Sri Lanka (= 17:30 UTC, still Sunday in Berlin too).
  const sundayNight = new Date("2026-11-08T17:30:00.000Z");
  assert.equal(iso(time.nextSriLankaWeeklyOccurrence(sundayNight, 1, "07:00")), "2026-11-09T01:30:00.000Z");
  // Monday 01:00 in Sri Lanka is still Sunday in Berlin: today's 18:00 slot is Monday.
  const mondayEarly = new Date("2026-11-08T19:30:00.000Z");
  assert.equal(iso(time.nextSriLankaWeeklyOccurrence(mondayEarly, 1, "18:00")), "2026-11-09T12:30:00.000Z");
  // A slot that already started rolls to next week; exactly "now" also rolls.
  assert.equal(iso(time.nextSriLankaWeeklyOccurrence(new Date("2026-11-09T12:30:00.000Z"), 1, "18:00")), "2026-11-16T12:30:00.000Z");
  assert.equal(time.nextSriLankaWeeklyOccurrence(sundayNight, 7, "07:00"), null);
  assert.equal(time.nextSriLankaWeeklyOccurrence(sundayNight, 1, "25:00"), null);
  assert.equal(time.nextSriLankaWeeklyOccurrence(sundayNight, 1, "bad"), null);
});

test("Overview uses Sri Lankan today, weekday and same-day matching (source)", () => {
  const code = fs.readFileSync(path.join(root, "app", "dashboard", "page.tsx"), "utf8");
  assert.match(code, /const todayStart = startOfTodaySriLankaUtc\(\);/);
  assert.match(code, /WEEKDAY_NAMES\[sriLankaCalendarParts\(now\)\.weekday\]/);
  assert.match(code, /return nextSriLankaWeeklyOccurrence\(now, targetDow, timeStr\);/);
  assert.match(code, /return sriLankaDateKey\(a\) === sriLankaDateKey\(b\);/);
  assert.doesNotMatch(code, /setHours\(0, 0, 0, 0\)/);
});

// ---- 6. Calendar --------------------------------------------------------------

function calendarClass(lectures) {
  return {
    id: CLASS_ID,
    name: "Maths",
    startDate: new Date("2026-01-01T00:00:00.000Z"),
    teacher: { name: "T" },
    schedules: [{ dayOfWeek: "SATURDAY", startTime: "18:00", endTime: "20:00" }],
    lectures,
  };
}

const lecture = (id, isoDate) => ({ id, title: id, classStatus: "LIVE", date: new Date(isoDate) });

test("teacher calendar: lecture at 18:00 Sri Lankan time matches its Saturday 18:00 schedule", async () => {
  reset();
  rows["class.findMany"] = [calendarClass([lecture("L1", "2026-11-07T12:30:00.000Z")])];

  const events = await getTeacherCalendar("teacher-1", new Date("2026-11-07T00:00:00.000Z"), new Date("2026-11-07T23:59:59.999Z"));
  const schedule = events.filter((e) => e.classId === CLASS_ID);

  assert.equal(schedule.length, 1, "no stray unscheduled-lecture entry");
  assert.equal(schedule[0].date, "2026-11-07");
  assert.equal(schedule[0].startTime, "18:00");
  assert.equal(schedule[0].lecture.id, "L1");
});

test("calendar lecture query covers Sri Lankan midnight at both ends of the range", async () => {
  reset();
  rows["class.findMany"] = [calendarClass([])];

  await getTeacherCalendar("teacher-1", new Date("2026-11-01T00:00:00.000Z"), new Date("2026-11-30T23:59:59.999Z"));
  const where = calls.find((c) => c.model === "class" && c.method === "findMany").args.select.lectures.where;

  // 1 Nov 00:00 and 30 Nov 23:59:59.999 in Sri Lanka, as real instants.
  assert.equal(iso(where.date.gte), "2026-10-31T18:30:00.000Z");
  assert.equal(iso(where.date.lte), "2026-11-30T18:29:59.999Z");
  // A lecture at 00:15 on 1 Nov (Sri Lanka) is inside; 23:59 on 31 Oct is not.
  assert.ok(new Date("2026-10-31T18:45:00.000Z") >= where.date.gte);
  assert.ok(new Date("2026-10-31T18:29:00.000Z") < where.date.gte);
});

test("unscheduled late-night lecture shows on its Sri Lankan day and time", async () => {
  reset();
  // Sunday 8 Nov 23:30 in Sri Lanka; no Sunday schedule.
  rows["class.findMany"] = [calendarClass([lecture("L2", "2026-11-08T18:00:00.000Z")])];

  const entries = await getStudentCalendar("student-1", new Date("2026-11-08T00:00:00.000Z"), new Date("2026-11-08T23:59:59.999Z"));
  const entry = entries.find((e) => e.lecture?.id === "L2");

  assert.equal(entry.scheduled, false);
  assert.equal(entry.date, "2026-11-08");
  assert.equal(entry.startTime, "23:30");
});

test("student calendar also uses the Sri Lankan lecture window", async () => {
  reset();
  rows["class.findMany"] = [calendarClass([])];

  await getStudentCalendar("student-1", new Date("2026-12-01T00:00:00.000Z"), new Date("2026-12-31T23:59:59.999Z"));
  const where = calls.find((c) => c.model === "class").args.select.lectures.where;
  assert.equal(iso(where.date.gte), "2026-11-30T18:30:00.000Z");
  assert.equal(iso(where.date.lte), "2026-12-31T18:29:59.999Z");
});

test("class start date keeps its date-only meaning in the calendar", async () => {
  reset();
  const cls = calendarClass([]);
  cls.startDate = new Date("2026-11-14T00:00:00.000Z"); // new Date("2026-11-14") as stored today
  rows["class.findMany"] = [cls];

  const events = await getTeacherCalendar("teacher-1", new Date("2026-11-07T00:00:00.000Z"), new Date("2026-11-21T23:59:59.999Z"));
  const dates = events.filter((e) => e.classId === CLASS_ID).map((e) => e.date);
  assert.deepEqual(dates, ["2026-11-14", "2026-11-21"], "the Saturday before the start date is skipped");
});

// ---- 7. Student countdown --------------------------------------------------

test("student countdown: Sri Lankan schedule time, and a same-Sri-Lankan-day lecture suppresses it", async (t) => {
  // Sunday 8 Nov 15:00 in Sri Lanka.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-08T09:30:00.000Z") });

  reset();
  rows["classSchedule.findMany"] = [
    { id: "S1", dayOfWeek: "SUNDAY", startTime: "18:00", endTime: "20:00", classId: CLASS_ID, class: { name: "Maths" } },
  ];

  let items = await getStudentUpcomingCountdowns("student-1");
  const schedule = items.find((i) => i.kind === "SCHEDULE");
  assert.equal(schedule.startsAt, "2026-11-08T12:30:00.000Z", "18:00 Sri Lankan time today");
  assert.equal(schedule.id, "schedule-S1-2026-11-08");

  // A lecture already added for that Sri Lankan day (23:30) hides the schedule nag.
  rows["lecture.findMany"] = [
    { id: "L3", title: "Maths", date: new Date("2026-11-08T18:00:00.000Z"), classId: CLASS_ID, class: { name: "Maths" } },
  ];
  items = await getStudentUpcomingCountdowns("student-1");
  assert.equal(items.filter((i) => i.kind === "SCHEDULE").length, 0);
});

// ---- 8. Attendance analytics months --------------------------------------------

test("attendance analytics buckets by Sri Lankan month (late on the last day, early on the first)", async (t) => {
  // 1 Dec 2026 01:00 in Sri Lanka (still 30 Nov in Berlin and UTC).
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-30T19:30:00.000Z") });

  reset();
  rows["classStudent.findMany"] = [{ classId: CLASS_ID }];
  rows["lecture.findMany"] = [
    { id: "A", date: new Date("2026-11-30T18:00:00.000Z"), sessions: [] }, // 30 Nov 23:30 SL
    { id: "B", date: new Date("2026-11-30T18:45:00.000Z"), sessions: [{ attendance: [{ id: "x" }] }] }, // 1 Dec 00:15 SL
  ];

  const analytics = await getStudentAttendanceAnalytics("student-1", { months: 3 });
  const byKey = Object.fromEntries(analytics.monthly.map((m) => [m.key, m]));

  assert.deepEqual(analytics.monthly.map((m) => m.key), ["2026-10", "2026-11", "2026-12"]);
  assert.equal(analytics.monthly.at(-1).isCurrent, true, "current month is the Sri Lankan December");
  assert.equal(byKey["2026-11"].total, 1);
  assert.equal(byKey["2026-12"].total, 1);
  assert.equal(byKey["2026-12"].attended, 1);
});

// ---- 9. Displays and request wiring (source) -----------------------------------

test("lecture displays use Asia/Colombo and the edit request sends the typed value", () => {
  const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
  const panel = read("components", "lecture-management-panel.tsx");

  assert.match(panel, /return toSriLankaDateTimeLocal\(new Date\(value\)\);/);
  assert.match(panel, /date: editLectureForm\.date,/);
  assert.doesNotMatch(panel, /new Date\(editLectureForm\.date\)\.toISOString\(\)/);
  assert.match(panel, /body: JSON\.stringify\(createLectureForm\)/, "create request unchanged");
  assert.match(panel, /new Date\(lecture\.date\)\.toLocaleDateString\(undefined, SRI_LANKA_TIME_ZONE\)/);
  assert.match(panel, /new Date\(lecture\.date\)\.toLocaleTimeString\(undefined, SRI_LANKA_TIME_ZONE\)/);
  assert.doesNotMatch(panel, /PanelLecture\.date\)\.toLocaleString\(\)/);

  assert.match(read("components", "student-portal", "lecture-list-client.tsx"), /function formatLectureDate[\s\S]{0,260}timeZone: "Asia\/Colombo"/);
  assert.match(read("app", "student", "Components", "StudentAttendance.tsx"), /function fmtDate[\s\S]{0,260}timeZone: "Asia\/Colombo"/);

  const sessions = read("components", "teacher-session-panel.tsx");
  assert.equal((sessions.match(/\.date\)\.toLocaleDateString\(undefined, \{ timeZone: "Asia\/Colombo" \}\)/g) ?? []).length, 4);
});

// ---- 10. Overview metrics: lectures vs schedule occurrences (Sri Lankan days) ----

const { getTeacherDashboardMetrics } = require(path.join(root, "services", "dashboard-metrics-service.ts"));

// Monday 9 Nov 2026 as the Overview sends it (Sri Lankan day, UTC digits).
const MON_FROM = new Date("2026-11-09T00:00:00.000Z");
const MON_TO = new Date("2026-11-09T23:59:59.999Z");

async function mondayMetrics(lectureDates) {
  reset();
  rows["teacherCalendarEvent.count"] = 0;
  rows["materialBundleItem.count"] = 0;
  rows["classSchedule.findMany"] = [{ classId: CLASS_ID, dayOfWeek: "MONDAY" }];
  rows["lecture.findMany"] = lectureDates.map((d) => ({ classId: CLASS_ID, date: new Date(d) }));
  return getTeacherDashboardMetrics("teacher-1", MON_FROM, MON_TO);
}

test("metrics: lecture query uses the real instants of the Sri Lankan day boundaries", async () => {
  await mondayMetrics([]);
  const where = calls.find((c) => c.model === "lecture" && c.method === "findMany").args.where;
  assert.equal(iso(where.date.gte), "2026-11-08T18:30:00.000Z"); // Mon 00:00 Sri Lanka
  assert.equal(iso(where.date.lte), "2026-11-09T18:29:59.999Z"); // Mon 23:59:59.999 Sri Lanka
});

test("metrics: a lecture at 00:00 Sri Lankan time counts for that day's schedule", async () => {
  const metrics = await mondayMetrics(["2026-11-08T18:30:00.000Z"]); // Mon 00:00 SL (Sunday in UTC)
  assert.deepEqual(metrics.lectures, { scheduled: 1, total: 1 });
});

test("metrics: a lecture at 05:29 Sri Lankan time counts for that day's schedule", async () => {
  const metrics = await mondayMetrics(["2026-11-08T23:59:00.000Z"]); // Mon 05:29 SL (Sunday in UTC)
  assert.deepEqual(metrics.lectures, { scheduled: 1, total: 1 });
});

test("metrics: 05:30 still counts, and the previous Sri Lankan day's 23:59 does not", async () => {
  assert.deepEqual((await mondayMetrics(["2026-11-09T00:00:00.000Z"])).lectures, { scheduled: 1, total: 1 }); // Mon 05:30 SL
  assert.deepEqual((await mondayMetrics(["2026-11-08T18:29:00.000Z"])).lectures, { scheduled: 0, total: 1 }); // Sun 23:59 SL
});

test("metrics: response structure and the other counts are unchanged", async () => {
  const metrics = await mondayMetrics([]);
  assert.deepEqual(Object.keys(metrics), ["lectures", "events", "materials", "papers", "bundlePapers", "assignments"]);
  assert.deepEqual(metrics.lectures, { scheduled: 0, total: 1 });
  assert.deepEqual(metrics.events, { pending: 0, total: 0 });
  assert.deepEqual(metrics.materials, { pendingToSend: 0, total: 0 });
  // Only the lecture query changed: every other window is still the original from/to.
  const assignmentWhere = calls.find((c) => c.model === "assignment").args.where;
  assert.equal(assignmentWhere.dueDate.gte, MON_FROM);
  assert.equal(assignmentWhere.dueDate.lte, MON_TO);
  const eventWhere = calls.find((c) => c.model === "teacherCalendarEvent").args.where;
  assert.equal(eventWhere.startDateTime.gte, MON_FROM);
});
