/*
 * General Assignments / General Quizzes display consistency (Stage 4).
 *
 * Every DTO that shows an assignment's / quiz's lecture classifies it with
 * lib/coursework-lecture.ts (by Lecture.isDefault only): a General item gets
 * isGeneral, the "General Assignments" / "General Quizzes" label and no
 * lecture date; a normal lecture keeps its title and date. Covered here, with
 * the real routes / services and a recording in-memory Prisma:
 *  - student Assignments / Quizzes pages:  GET /api/students/me/assignments|quizzes
 *  - student quiz list:                     GET /api/student/quizzes
 *  - student dashboard agenda:              GET /api/student/dashboard/assignments-due
 *  - teacher dashboard coursework cards:    services/dashboard-coursework-service.ts
 *  - guardian portal assignments:           services/guardian-portal-service.ts
 *  - student profile quiz results:          services/student-service.ts (getStudentQuizResults, getStudentClassQuizResults)
 * and that their queries (visibility, enrolment / class filters, ordering,
 * pagination, the lecture filter options) are exactly as before. The pages'
 * rendering: tests/ui/general-coursework-display.test.tsx.
 *
 *   npm run test:coursework
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
const CLASS = { id: "11111111-1111-4111-8111-111111111111", name: "Physics" };
const DEFAULT_DATE = new Date("2026-01-05T00:00:00.000Z"); // the class's creation: never shown
const LECTURE_DATE = new Date("2026-10-10T03:30:00.000Z");
const GENERAL = { id: "aaaaaaaa-0000-4000-8000-00000000000d", title: "General Notes", date: DEFAULT_DATE, isDefault: true, classId: CLASS.id, class: CLASS };
const NORMAL = { id: "aaaaaaaa-0000-4000-8000-000000000001", title: "Kinematics", date: LECTURE_DATE, isDefault: false, classId: CLASS.id, class: CLASS };

const assignmentRow = (id, lecture) => ({
  id, title: `Assignment ${id}`, description: "Do it.", dueDate: new Date("2026-12-01T10:00:00.000Z"), lectureId: lecture.id, lecture, submissions: [],
});
const quizRow = (id, lecture) => ({
  id, title: `Quiz ${id}`, maxAttempts: 2, startDateTime: new Date("2026-11-01T10:00:00.000Z"), endDateTime: new Date("2026-12-01T10:00:00.000Z"),
  lecture, questions: [{ id: "q" }], submissions: [],
});

let calls = [];
let fixtures = {};
function delegate(model) {
  const handler = (method) => async (args) => {
    calls.push([`${model}.${method}`, args]);
    const value = fixtures[`${model}.${method}`];
    return typeof value === "function" ? value(args) : value;
  };
  return new Proxy({}, { get: (_t, method) => handler(method) });
}
const prisma = new Proxy({}, { get: (_t, model) => delegate(model) });
fake("lib/prisma.ts", { prisma });
fake("lib/auth-session.ts", {
  requireStudentSession: async () => ({ studentId: S1, role: "STUDENT" }),
  requireTeacherSession: async () => ({ teacherId: T1, role: "TEACHER" }),
  requireAppSession: async () => { throw new AppError("no", 401, "UNAUTHORIZED"); },
  requireAdminSession: async () => { throw new AppError("no", 401, "UNAUTHORIZED"); },
  requireTeacherSessionForbiddingOtherRoles: async () => { throw new AppError("no", 401, "UNAUTHORIZED"); },
  getOptionalSession: async () => null,
});
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });

const { NextRequest } = require("next/server");
const lib = require(path.join(root, "lib", "coursework-lecture.ts"));
const route = (...p) => require(path.join(root, "app", "api", ...p, "route.ts"));
const myAssignments = route("students", "me", "assignments");
const myQuizzes = route("students", "me", "quizzes");
const studentQuizzes = route("student", "quizzes");
const assignmentsDue = route("student", "dashboard", "assignments-due");
const coursework = require(path.join(root, "services", "dashboard-coursework-service.ts"));
const guardian = require(path.join(root, "services", "guardian-portal-service.ts"));
const studentService = require(path.join(root, "services", "student-service.ts"));

test.beforeEach(() => {
  calls = [];
  fixtures = {};
});

const json = async (response) => ({ status: response.status, body: await response.json() });
const query = (name) => calls.filter(([n]) => n === name).map(([, args]) => args);
/** Neither the default lecture's internal title nor its date (the class's creation) appears anywhere. */
function assertNoDefaultLectureLeak(value, label) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /General Notes/, `${label}: the internal title`);
  assert.ok(!text.includes(DEFAULT_DATE.toISOString()), `${label}: the default lecture's date`);
}
const lectureFields = (row) => ({ isGeneral: row.isGeneral, lectureTitle: row.lectureTitle, lectureDate: row.lectureDate });

// ---- The shared classification ---------------------------------------------------------------------

test("lib: by Lecture.isDefault only; General label and no date for the default lecture; normal lectures unchanged", () => {
  assert.deepEqual(lib.courseworkLectureView("assignment", GENERAL), { isGeneral: true, lectureTitle: "General Assignments", lectureDate: null });
  assert.deepEqual(lib.courseworkLectureView("quiz", GENERAL), { isGeneral: true, lectureTitle: "General Quizzes", lectureDate: null });
  assert.deepEqual(lib.courseworkLectureView("quiz", NORMAL), { isGeneral: false, lectureTitle: "Kinematics", lectureDate: LECTURE_DATE });
  assert.deepEqual(lib.courseworkLectureJson("assignment", NORMAL), { isGeneral: false, lectureTitle: "Kinematics", lectureDate: LECTURE_DATE.toISOString() });
  assert.deepEqual(lib.courseworkLectureLabel("assignment", GENERAL), { isGeneral: true, lectureTitle: "General Assignments" });
  // Never by title: a normal lecture that happens to be called "General Notes" is a normal lecture.
  assert.deepEqual(lib.courseworkLectureLabel("quiz", { title: "General Notes", isDefault: false }), { isGeneral: false, lectureTitle: "General Notes" });
  assert.deepEqual(lib.COURSEWORK_LECTURE_FIELDS, { title: true, date: true, isDefault: true });
});

// ---- Student Assignments / Quizzes pages ---------------------------------------------------------------

test("student Assignments page API: General label, no date; lecture assignments keep title and date; query, order, pagination and filter options unchanged", async () => {
  fixtures = {
    "assignment.count": 2,
    "assignment.findMany": [assignmentRow("g", GENERAL), assignmentRow("l", NORMAL)],
    "assignmentSubmission.findMany": [],
    "lecture.findMany": [{ id: NORMAL.id, title: NORMAL.title, date: NORMAL.date, classId: CLASS.id, class: { name: CLASS.name } }],
    "classStudent.findMany": [{ class: CLASS }],
  };
  const result = await json(await myAssignments.GET(new NextRequest("http://x/api/students/me/assignments?page=2&pageSize=5")));
  assert.equal(result.status, 200);
  const [general, lecture] = result.body.data.records ?? result.body.data;
  assert.deepEqual(lectureFields(general), { isGeneral: true, lectureTitle: "General Assignments", lectureDate: null });
  assert.deepEqual(lectureFields(lecture), { isGeneral: false, lectureTitle: "Kinematics", lectureDate: LECTURE_DATE.toISOString() });
  assert.equal(general.lectureId, GENERAL.id, "existing fields kept");
  assertNoDefaultLectureLeak(result.body, "assignments");

  const [findMany] = query("assignment.findMany");
  assert.deepEqual(findMany.where, {
    status: 0,
    lecture: { status: 0, class: { status: 0, students: { some: { studentId: S1, isActive: true } } } },
  }, "General assignments stay visible: no default-lecture filter; enrolment unchanged");
  assert.deepEqual([findMany.orderBy, findMany.skip, findMany.take], [{ dueDate: "asc" }, 5, 5]);
  assert.equal(findMany.select.lecture.select.isDefault, true);
  const [options] = query("lecture.findMany");
  assert.equal(options.where.isDefault, false, "the default lecture is never a lecture filter option");
});

test("student Quizzes page API: General label, no date; lecture quizzes keep title and date; query, order, pagination and filter options unchanged", async () => {
  fixtures = {
    "quiz.count": 2,
    "quiz.findMany": [quizRow("g", GENERAL), quizRow("l", NORMAL)],
    "lecture.findMany": [{ id: NORMAL.id, title: NORMAL.title, date: NORMAL.date, classId: CLASS.id, class: { name: CLASS.name } }],
    "classStudent.findMany": [{ class: CLASS }],
  };
  const result = await json(await myQuizzes.GET(new NextRequest("http://x/api/students/me/quizzes")));
  assert.equal(result.status, 200);
  const [general, lecture] = result.body.data.records ?? result.body.data;
  assert.deepEqual(lectureFields(general), { isGeneral: true, lectureTitle: "General Quizzes", lectureDate: null });
  assert.deepEqual(lectureFields(lecture), { isGeneral: false, lectureTitle: "Kinematics", lectureDate: LECTURE_DATE.toISOString() });
  assertNoDefaultLectureLeak(result.body, "quizzes");
  const [findMany] = query("quiz.findMany");
  assert.deepEqual(findMany.where, {
    status: 0,
    lecture: { status: 0, class: { status: 0, students: { some: { studentId: S1, isActive: true } } } },
  });
  assert.deepEqual(findMany.orderBy, [{ startDateTime: "asc" }, { title: "asc" }]);
  assert.equal(query("lecture.findMany")[0].where.isDefault, false);
});

test("student quiz list API: General label and no date; order unchanged", async () => {
  fixtures = { "quiz.findMany": [quizRow("g", GENERAL), quizRow("l", NORMAL)] };
  const result = await json(await studentQuizzes.GET(new Request("http://x/api/student/quizzes")));
  assert.equal(result.status, 200);
  assert.deepEqual(lectureFields(result.body.data[0]), { isGeneral: true, lectureTitle: "General Quizzes", lectureDate: null });
  assert.deepEqual(lectureFields(result.body.data[1]), { isGeneral: false, lectureTitle: "Kinematics", lectureDate: LECTURE_DATE.toISOString() });
  assertNoDefaultLectureLeak(result.body, "student quiz list");
  assert.deepEqual(query("quiz.findMany")[0].orderBy, [{ endDateTime: "desc" }, { title: "asc" }]);
});

// ---- Dashboards ------------------------------------------------------------------------------------------

test("student dashboard agenda (assignments due): General label; lecture title kept; window, enrolment and order unchanged", async () => {
  fixtures = { "assignment.findMany": [assignmentRow("g", GENERAL), assignmentRow("l", NORMAL)] };
  const result = await json(await assignmentsDue.GET(new Request("http://x/api/student/dashboard/assignments-due?from=2026-11-01&to=2026-12-31")));
  assert.equal(result.status, 200);
  const rows = result.body.data.assignments ?? result.body.data;
  assert.deepEqual(rows.map((r) => [r.isGeneral, r.lectureTitle]), [[true, "General Assignments"], [false, "Kinematics"]]);
  assertNoDefaultLectureLeak(result.body, "agenda");
  const [findMany] = query("assignment.findMany");
  assert.deepEqual(findMany.where.lecture, { status: 0, class: { status: 0, students: { some: { studentId: S1, isActive: true } } } });
  assert.deepEqual(findMany.orderBy, { dueDate: "asc" });
});

test("teacher dashboard coursework cards: General label on General Assignments; lecture titles kept; queries unchanged", async () => {
  fixtures = {
    "assignment.findMany": [
      { ...assignmentRow("g", GENERAL), submissions: [] },
      { ...assignmentRow("l", NORMAL), submissions: [] },
    ],
    "quiz.findMany": [],
  };
  const result = await coursework.getTeacherCourseworkForRange(T1, new Date("2026-11-01T00:00:00Z"), new Date("2026-12-31T00:00:00Z"));
  assert.deepEqual(result.assignments.map((a) => [a.isGeneral, a.lectureTitle]), [[true, "General Assignments"], [false, "Kinematics"]]);
  assertNoDefaultLectureLeak(result, "coursework cards");
  const [findMany] = query("assignment.findMany");
  assert.equal(JSON.stringify(findMany.where).includes("isDefault"), false, "General assignments are not filtered out");
  assert.deepEqual(findMany.orderBy, { dueDate: "desc" });
});

// ---- Guardian portal -------------------------------------------------------------------------------------

test("guardian portal assignments: General label and no date; lecture assignments keep title and date", async () => {
  fixtures = {
    "assignment.findMany": [assignmentRow("g", GENERAL), assignmentRow("l", NORMAL)],
    "assignmentSubmission.findMany": [],
  };
  const result = await guardian.getGuardianStudentAssignments(S1);
  const rows = result.records ?? result;
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(lectureFields(byId.g), { isGeneral: true, lectureTitle: "General Assignments", lectureDate: null });
  assert.deepEqual(lectureFields(byId.l), { isGeneral: false, lectureTitle: "Kinematics", lectureDate: LECTURE_DATE.toISOString() });
  assertNoDefaultLectureLeak(result, "guardian");
  assert.equal(JSON.stringify(query("assignment.findMany")[0].where).includes("isDefault"), false, "General assignments still visible to guardians");
});

// ---- Student profile quiz results --------------------------------------------------------------------------

test("student profile quiz results (both services): General label and no date; lecture quizzes keep title and date; order unchanged", async () => {
  fixtures = { "quiz.findMany": [quizRow("g", GENERAL), quizRow("l", NORMAL)] };
  const results = await studentService.getStudentQuizResults(S1, CLASS.id);
  const rows = results.results ?? results.quizzes ?? results;
  const byId = Object.fromEntries((Array.isArray(rows) ? rows : []).map((r) => [r.quizId, r]));
  assert.deepEqual(
    { isGeneral: byId.g.isGeneral, lectureTitle: byId.g.lectureTitle, lectureDate: byId.g.lectureDate },
    { isGeneral: true, lectureTitle: "General Quizzes", lectureDate: null }
  );
  assert.deepEqual(
    { isGeneral: byId.l.isGeneral, lectureTitle: byId.l.lectureTitle, lectureDate: byId.l.lectureDate },
    { isGeneral: false, lectureTitle: "Kinematics", lectureDate: LECTURE_DATE }
  );
  assertNoDefaultLectureLeak(results, "profile quiz results");
  const [first] = query("quiz.findMany");
  assert.deepEqual(first.where, { status: 0, lecture: { classId: CLASS.id, status: 0 } });
  assert.deepEqual(first.orderBy, { lecture: { date: "desc" } });

  calls = [];
  const classResults = await studentService.getStudentClassQuizResults(S1, CLASS.id);
  const list = Array.isArray(classResults) ? classResults : classResults.quizzes;
  assert.deepEqual(list.map((r) => [r.isGeneral, r.lectureTitle, r.lectureDate]), [[true, "General Quizzes", null], [false, "Kinematics", LECTURE_DATE]]);
  assertNoDefaultLectureLeak(classResults, "class quiz results");
  assert.deepEqual(query("quiz.findMany")[0].orderBy, { startDateTime: "desc" });
});
