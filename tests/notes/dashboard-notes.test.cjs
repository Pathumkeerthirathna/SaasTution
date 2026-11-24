/*
 * Notes redesign Stage 4: the shape of the student dashboard's note queries
 * (no database; their results on real PostgreSQL:
 * tests/notes/dashboard-notes.db.test.cjs).
 *  - services/student-dashboard-counts-service.ts: notes counted per Note (no
 *    NoteStudent row counting), the widget's eligibility, the Sri Lankan
 *    month of uploadedAt with the lecture-date fallback.
 *  - app/api/student/dashboard/notes: the Notes pages' order.
 *
 *   npm run test:notes
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const calls = [];
const recorder = new Proxy(
  {},
  {
    get: (_, model) =>
      new Proxy(
        {},
        {
          get: (__, method) => async (args) => {
            calls.push({ model, method, args });
            return method === "count" ? 0 : [];
          },
        }
      ),
  }
);
const filename = path.join(root, "lib", "prisma.ts");
const mod = new Module(filename);
mod.filename = filename;
mod.loaded = true;
mod.exports = { prisma: recorder };
require.cache[filename] = mod;

const { getStudentDashboardCounts } = require(path.join(root, "services", "student-dashboard-counts-service.ts"));
const iso = (d) => d.toISOString();

test("counts: two Note counts (no NoteStudent counting); active enrolment in an active class; unviewed = no viewed row", async () => {
  calls.length = 0;
  await getStudentDashboardCounts("student-1", "all");
  assert.equal(calls.filter((c) => c.model === "noteStudent").length, 0, "NoteStudent rows are no longer counted");
  const [total, unviewed] = calls.filter((c) => c.model === "note" && c.method === "count").map((c) => c.args.where);
  assert.deepEqual(total, { status: 0, lecture: { status: 0, class: { status: 0, students: { some: { studentId: "student-1", isActive: true } } } } }, "'all': no date filter");
  assert.deepEqual(unviewed, { ...total, noteStudents: { none: { studentId: "student-1", viewed: true } } });
});

test("counts: the range is the Sri Lankan month of uploadedAt, else (no uploadedAt) the lecture's date", async (t) => {
  // 1 Dec 2026 01:00 in Sri Lanka (still 30 Nov in UTC).
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-30T19:30:00.000Z") });
  calls.length = 0;
  await getStudentDashboardCounts("student-1", "month");
  const where = calls.find((c) => c.model === "note" && c.method === "count").args.where;
  const [uploaded, legacy] = where.OR;
  assert.equal(iso(uploaded.uploadedAt.gte), "2026-11-30T18:30:00.000Z"); // 1 Dec 00:00 SL
  assert.equal(iso(uploaded.uploadedAt.lte), "2026-12-31T18:29:59.999Z");
  assert.deepEqual(legacy.uploadedAt, { equals: null });
  assert.equal(iso(legacy.lecture.date.gte), "2026-11-30T18:30:00.000Z");
  assert.equal(iso(legacy.lecture.date.lte), "2026-12-31T18:29:59.999Z");
  assert.deepEqual(where.lecture, { status: 0, class: { status: 0, students: { some: { studentId: "student-1", isActive: true } } } });
});

test("the widget API orders like the Notes pages, includes General Notes and returns uploadedAt / isGeneral / classId", () => {
  const src = fs.readFileSync(path.join(root, "app", "api", "student", "dashboard", "notes", "route.ts"), "utf8");
  assert.match(src, /orderBy: CLASS_NOTES_ORDER,/);
  assert.doesNotMatch(src, /isDefault: false|NORMAL_LECTURE_WHERE/, "General Notes are not filtered out");
  assert.match(src, /noteStudents: \{ none: \{ studentId, viewed: true \} \}/, "unviewed eligibility unchanged");
  assert.match(src, /students: \{ some: \{ studentId, isActive: true \} \}/, "enrolment unchanged");
  assert.match(src, /kind: "NOTE",/, "notes only, as before");
  assert.match(src, /isGeneral: n\.lecture\.isDefault,/);
  assert.match(src, /uploadedAt: n\.uploadedAt \? n\.uploadedAt\.toISOString\(\) : null,/);
  assert.match(src, /classId: n\.lecture\.classId,/);
  assert.match(src, /resourceLockFor\(access, n\.lecture\.classId, noteBillingMonth\(n\)\)/, "the lock information unchanged");
});
