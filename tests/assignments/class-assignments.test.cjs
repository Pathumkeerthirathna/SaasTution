/*
 * Assignments page, Stage 1 (backend): class-scoped assignments.
 *  - services/class-assignments-service.ts (scope resolution, listing, creation)
 *  - GET  /api/classes/[id]/assignments[?lectureId=]
 *  - POST /api/classes/[id]/assignments[?lectureId=]
 *  - the EXISTING per-assignment routes on a General Assignment (the default
 *    lecture's id, as returned above): PUT / DELETE
 *    /api/lectures/[id]/assignments/[assignmentId], GET .../submissions,
 *    GET .../submissions/[submissionId]/file, PATCH .../submissions/[submissionId]
 *  - the EXISTING lecture-level list / create routes, unchanged (they still
 *    refuse a default lecture).
 *
 *   npm run test:assignments
 *
 * The real routes and services (lecture-service, the shared class / lecture
 * resolver, the validation, permanent deletion) run through tsx. Faked edges:
 * Prisma (an in-memory Class / Lecture / Assignment / AssignmentSubmission
 * store that refuses filters it does not understand), the teacher session,
 * live events, the storage quota lock and the stored-file reader (the file
 * route's ownership query is the real one).
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
const APP_ORIGIN = "https://app.example.test";
process.env.APP_URL = APP_ORIGIN;

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

const T1 = "teacher-1";
const T2 = "teacher-2";
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const C_OFF = "33333333-3333-4333-8333-333333333333"; // deactivated class
const C_NODEFAULT = "44444444-4444-4444-8444-444444444444"; // no default lecture yet
const D1 = "aaaaaaaa-0000-4000-8000-00000000000d"; // C1's default lecture
const L1 = "aaaaaaaa-0000-4000-8000-000000000001"; // C1 normal lecture
const L1_REMOVED = "aaaaaaaa-0000-4000-8000-000000000002";
const D2 = "bbbbbbbb-0000-4000-8000-00000000000d";
const L2 = "bbbbbbbb-0000-4000-8000-000000000001"; // C2 normal lecture (another class)
const D_OFF = "cccccccc-0000-4000-8000-00000000000d";
const L_NODEFAULT = "dddddddd-0000-4000-8000-000000000001";
const FUTURE = "2099-01-15T10:00";

const utc = (iso) => new Date(iso);
let state;

function assignment(id, lectureId, dueDate, extra = {}) {
  return { id, lectureId, title: `Assignment ${id}`, description: `Description of ${id}`, dueDate: utc(dueDate), status: 0, ...extra };
}
function submission(id, assignmentId, studentId, extra = {}) {
  return {
    id, assignmentId, studentId, notes: null, submittedAt: utc("2026-11-01T10:00:00Z"), fileName: `${id}.pdf`, fileUrl: `/storage/${id}.pdf`,
    mimeType: "application/pdf", sizeBytes: 1234, marks: null, reviewedAt: null, storageKey: null, sha256: null, ...extra,
  };
}

function reset() {
  state = {
    teacher: T1,
    queries: [],
    events: [],
    nextId: 1,
    classes: {
      [C1]: { id: C1, name: "Physics", teacherId: T1, status: 0, schedule: "Mon" },
      [C2]: { id: C2, name: "Chemistry", teacherId: T1, status: 0, schedule: "Tue" },
      [C_OFF]: { id: C_OFF, name: "Old", teacherId: T1, status: 1, schedule: "Wed" },
      [C_NODEFAULT]: { id: C_NODEFAULT, name: "Biology", teacherId: T1, status: 0, schedule: "Thu" },
    },
    students: { "student-1": { id: "student-1", name: "Nimal Perera", registrationNumber: "R1" }, "student-2": { id: "student-2", name: "Kamal", registrationNumber: "R2" } },
    enrolments: [
      { classId: C1, studentId: "student-1", isActive: true },
      { classId: C1, studentId: "student-2", isActive: true },
    ],
    lectures: {
      [D1]: { id: D1, classId: C1, title: "General Notes", date: utc("2026-01-05T00:00:00Z"), endDate: null, status: 0, isDefault: true },
      [L1]: { id: L1, classId: C1, title: "Kinematics", date: utc("2026-10-10T03:30:00Z"), endDate: null, status: 0, isDefault: false },
      [L1_REMOVED]: { id: L1_REMOVED, classId: C1, title: "Removed", date: utc("2026-10-11T03:30:00Z"), endDate: null, status: 1, isDefault: false },
      [D2]: { id: D2, classId: C2, title: "General Notes", date: utc("2026-01-05T00:00:00Z"), endDate: null, status: 0, isDefault: true },
      [L2]: { id: L2, classId: C2, title: "Organic", date: utc("2026-10-12T03:30:00Z"), endDate: null, status: 0, isDefault: false },
      [D_OFF]: { id: D_OFF, classId: C_OFF, title: "General Notes", date: utc("2026-01-05T00:00:00Z"), endDate: null, status: 0, isDefault: true },
      [L_NODEFAULT]: { id: L_NODEFAULT, classId: C_NODEFAULT, title: "Cells", date: utc("2026-10-13T03:30:00Z"), endDate: null, status: 0, isDefault: false },
    },
    assignments: [
      assignment("g-late", D1, "2026-12-20T10:00:00Z"),
      assignment("g-early", D1, "2026-12-01T10:00:00Z"),
      assignment("g-removed", D1, "2026-12-05T10:00:00Z", { status: 1 }),
      assignment("g-pending", D1, "2026-12-06T10:00:00Z", { status: 2 }),
      assignment("l-1", L1, "2026-11-30T10:00:00Z"),
      assignment("c2-g", D2, "2026-12-02T10:00:00Z"),
      assignment("c2-l", L2, "2026-12-03T10:00:00Z"),
    ],
    submissions: [submission("sub-1", "g-early", "student-1"), submission("sub-2", "g-early", "student-2")],
  };
}
reset();

// ---- Fake Prisma -----------------------------------------------------------------------------------

function onlyKeys(where, allowed, model) {
  for (const key of Object.keys(where)) if (!allowed.includes(key)) throw new Error(`fake: unsupported ${model} filter ${key}`);
}
function statusMatches(value, filter) {
  if (filter === undefined) return true;
  if (typeof filter === "number") return value === filter;
  onlyKeys(filter, ["in"], "status");
  return filter.in.includes(value);
}
function classMatches(c, where) {
  onlyKeys(where, ["teacherId", "status"], "class");
  return (where.teacherId === undefined || c.teacherId === where.teacherId) && (where.status === undefined || c.status === where.status);
}
function lectureMatches(l, where) {
  onlyKeys(where, ["id", "classId", "status", "isDefault", "class"], "lecture");
  if (where.id !== undefined && l.id !== where.id) return false;
  if (where.classId !== undefined && l.classId !== where.classId) return false;
  if (!statusMatches(l.status, where.status)) return false;
  if (where.isDefault !== undefined && l.isDefault !== where.isDefault) return false;
  if (where.class && !classMatches(state.classes[l.classId], where.class)) return false;
  return true;
}
function assignmentMatches(a, where) {
  onlyKeys(where, ["id", "lectureId", "status", "lecture"], "assignment");
  if (where.id !== undefined && a.id !== where.id) return false;
  if (where.lectureId !== undefined && a.lectureId !== where.lectureId) return false;
  if (!statusMatches(a.status, where.status)) return false;
  if (where.lecture && !lectureMatches(state.lectures[a.lectureId], where.lecture)) return false;
  return true;
}
function submissionMatches(s, where) {
  onlyKeys(where, ["id", "assignmentId", "assignment", "storageKey", "fileUrl"], "assignmentSubmission");
  if (where.id !== undefined && s.id !== where.id) return false;
  if (where.assignmentId !== undefined && s.assignmentId !== where.assignmentId) return false;
  if (where.storageKey !== undefined && s.storageKey !== where.storageKey) return false;
  if (where.fileUrl !== undefined && s.fileUrl !== where.fileUrl) return false;
  if (where.assignment) {
    const a = state.assignments.find((x) => x.id === s.assignmentId);
    if (!a || !assignmentMatches(a, where.assignment)) return false;
  }
  return true;
}

/** Prisma `select`, relations included. */
const RELATIONS = {
  assignment: { lecture: (row) => ["lecture", state.lectures[row.lectureId]] },
  lecture: { class: (row) => ["class", state.classes[row.classId]] },
  class: {
    students: (row) => ["classStudent", state.enrolments.filter((e) => e.classId === row.id)],
    schedule: null,
  },
  submission: {
    student: (row) => ["student", state.students[row.studentId]],
    assignment: (row) => ["assignment", state.assignments.find((a) => a.id === row.assignmentId)],
  },
};
function project(kind, row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const [key, spec] of Object.entries(select)) {
    if (!spec) continue;
    const relation = RELATIONS[kind]?.[key];
    if (relation) {
      const [childKind, child] = relation(row);
      const childSelect = spec === true ? null : spec.select;
      out[key] = Array.isArray(child) ? child.map((c) => project(childKind, c, childSelect)) : project(childKind, child, childSelect);
    } else {
      if (spec !== true) throw new Error(`fake: unsupported select ${kind}.${key}`);
      out[key] = row[key];
    }
  }
  return out;
}
function sortBy(orderBy) {
  const [key, dir] = Object.entries(orderBy)[0];
  const v = (x) => (x[key] instanceof Date ? x[key].getTime() : x[key]);
  return (a, b) => (v(a) < v(b) ? -1 : v(a) > v(b) ? 1 : 0) * (dir === "desc" ? -1 : 1);
}

const prisma = {
  class: {
    findFirst: async ({ where, select }) => {
      state.queries.push(["class.findFirst", where]);
      onlyKeys(where, ["id", "teacherId", "status"], "class");
      const c = state.classes[where.id];
      return c && classMatches(c, { teacherId: where.teacherId, status: where.status }) ? project("class", c, select) : null;
    },
  },
  lecture: {
    findFirst: async ({ where, select }) => {
      state.queries.push(["lecture.findFirst", where]);
      const l = Object.values(state.lectures).find((row) => lectureMatches(row, where));
      return l ? project("lecture", l, select) : null;
    },
    create: async () => {
      throw new Error("a lecture must never be created here");
    },
  },
  assignment: {
    findMany: async ({ where, orderBy, select }) => {
      state.queries.push(["assignment.findMany", where, orderBy]);
      return state.assignments.filter((a) => assignmentMatches(a, where)).sort(sortBy(orderBy)).map((a) => project("assignment", a, select));
    },
    findFirst: async ({ where, select }) => {
      const a = state.assignments.find((row) => assignmentMatches(row, where));
      return a ? project("assignment", a, select) : null;
    },
    create: async ({ data, select }) => {
      const row = { id: `new-${state.nextId++}`, status: 0, ...data };
      state.assignments.push(row);
      return project("assignment", row, select);
    },
    update: async ({ where, data, select }) => {
      const row = state.assignments.find((a) => a.id === where.id);
      Object.assign(row, data);
      return project("assignment", row, select);
    },
    updateMany: async ({ where, data }) => {
      const rows = state.assignments.filter((a) => assignmentMatches(a, where));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    },
    deleteMany: async ({ where }) => {
      const before = state.assignments.length;
      state.assignments = state.assignments.filter((a) => !assignmentMatches(a, where));
      return { count: before - state.assignments.length };
    },
    count: async ({ where }) => state.assignments.filter((a) => assignmentMatches(a, where)).length,
  },
  assignmentSubmission: {
    findMany: async ({ where, orderBy, take, select }) => {
      const rows = state.submissions.filter((s) => submissionMatches(s, where)).sort(sortBy(orderBy));
      return (take ? rows.slice(0, take) : rows).map((s) => project("submission", s, select));
    },
    findFirst: async ({ where, select }) => {
      const s = state.submissions.find((row) => submissionMatches(row, where));
      return s ? project("submission", s, select) : null;
    },
    update: async ({ where, data, select }) => {
      const row = state.submissions.find((s) => s.id === where.id);
      Object.assign(row, data);
      return project("submission", row, select);
    },
    deleteMany: async ({ where }) => {
      const before = state.submissions.length;
      state.submissions = state.submissions.filter((s) => !submissionMatches(s, where));
      return { count: before - state.submissions.length };
    },
    count: async ({ where }) => state.submissions.filter((s) => submissionMatches(s, where)).length,
  },
  $transaction: async (fn) => fn(prisma),
};

fake("lib/prisma.ts", { prisma });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    if (!state.teacher) throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    return { teacherId: state.teacher, role: "TEACHER" };
  },
  requireStudentSession: async () => { throw new Error("not used"); },
  requireAppSession: async () => { throw new Error("not used"); },
  requireAdminSession: async () => { throw new Error("not used"); },
  requireTeacherSessionForbiddingOtherRoles: async () => { throw new Error("not used"); },
  getOptionalSession: async () => null,
});
fake("lib/session-events.ts", { emitStudentDataChange: (payload) => state.events.push(payload), emitLiveChange: () => {} });
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });
fake("lib/storage-quota/locks.ts", {
  STORAGE_QUOTA_LOCK_NAMESPACE: "storage-quota",
  STORAGE_QUOTA_LOCK_TIMEOUT_MS: 10_000,
  teacherStorageQuotaLockKey: (teacherId) => `storage-quota:${teacherId}`,
  setStorageQuotaLockTimeout: async () => {},
  lockTeacherStorageQuota: async () => {},
});
const realStoredFile = require(path.join(root, "lib", "stored-files", "stored-file.ts"));
const opened = [];
fake("lib/stored-files/stored-file.ts", {
  ...realStoredFile,
  openStoredFileForRead: async (kind, reference) => {
    opened.push({ kind, reference });
    return { kind, reference };
  },
  storedFileResponse: (_file, headers) => new Response("%PDF-1.4", { status: 200, headers }),
});

const service = require(path.join(root, "services", "class-assignments-service.ts"));
const classRoute = require(path.join(root, "app", "api", "classes", "[id]", "assignments", "route.ts"));
const lectureListRoute = require(path.join(root, "app", "api", "lectures", "[id]", "assignments", "route.ts"));
const itemRoute = require(path.join(root, "app", "api", "lectures", "[id]", "assignments", "[assignmentId]", "route.ts"));
const submissionsRoute = require(path.join(root, "app", "api", "lectures", "[id]", "assignments", "[assignmentId]", "submissions", "route.ts"));
const marksRoute = require(path.join(root, "app", "api", "lectures", "[id]", "assignments", "[assignmentId]", "submissions", "[submissionId]", "route.ts"));
const fileRoute = require(path.join(root, "app", "api", "lectures", "[id]", "assignments", "[assignmentId]", "submissions", "[submissionId]", "file", "route.ts"));

test.beforeEach(() => {
  reset();
  opened.length = 0;
});

// ---- Helpers ---------------------------------------------------------------------------------------

async function call(handler, url, params, init = {}) {
  const response = await handler(new Request(url, init), { params });
  const type = response.headers.get("content-type") ?? "";
  return { status: response.status, headers: response.headers, body: type.includes("json") ? await response.json() : await response.text() };
}
const classGet = (classId, query = "") => call(classRoute.GET, `${APP_ORIGIN}/api/classes/${classId}/assignments${query}`, { id: classId });
function classPost(classId, { query = "", body = { title: "Essay", description: "Write an essay.", dueDate: FUTURE }, headers = { origin: APP_ORIGIN } } = {}) {
  return call(classRoute.POST, `${APP_ORIGIN}/api/classes/${classId}/assignments${query}`, { id: classId }, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}
const ids = (result) => result.body.data.assignments.map((a) => a.id);
const code = (result) => result.body.error?.code;
const created = () => state.assignments.filter((a) => a.id.startsWith("new-"));

// ---- 1-6: listing, creation, sections, default lecture resolution ---------------------------------------

test("GET without lectureId: the class's General Assignments (its default lecture), active only, earliest due first", async () => {
  const result = await classGet(C1);
  assert.equal(result.status, 200);
  const data = result.body.data;
  assert.equal(data.section, "GENERAL");
  assert.equal(data.label, "General Assignments");
  assert.deepEqual(data.class, { id: C1, name: "Physics" });
  assert.deepEqual(data.lecture, { id: D1, isDefault: true, title: null, date: null });
  assert.deepEqual(ids(result), ["g-early", "g-late"], "removed and deletion-pending assignments are not listed; another lecture's neither");
  assert.deepEqual(Object.keys(data.assignments[0]).sort(), ["description", "dueDate", "id", "title"], "the lecture API's fields");
  assert.doesNotMatch(JSON.stringify(result.body), /General Notes/, "the default lecture's internal title is never sent");
  // The default lecture was found from the class on the server: classId + isDefault, never an id from the client.
  assert.ok(state.queries.some(([q, where]) => q === "lecture.findFirst" && where.classId === C1 && where.isDefault === true && where.id === undefined));
});

test("GET with a normal lectureId: that lecture's assignments, LECTURE section with its title and date", async () => {
  const result = await classGet(C1, `?lectureId=${L1}`);
  assert.equal(result.status, 200);
  const data = result.body.data;
  assert.equal(data.section, "LECTURE");
  assert.equal(data.label, "Kinematics");
  assert.deepEqual(data.lecture, { id: L1, isDefault: false, title: "Kinematics", date: "2026-10-10T03:30:00.000Z" });
  assert.deepEqual(ids(result), ["l-1"]);
  const blank = await classGet(C1, "?lectureId=%20%20");
  assert.equal(blank.body.data.section, "GENERAL", "a blank lectureId means General");
});

test("POST without lectureId: created on the class's default lecture (the existing creation: fields, student refresh)", async () => {
  const result = await classPost(C1, { body: { title: "Essay", description: "Write an essay.", dueDate: FUTURE, lectureId: L1 } });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const data = result.body.data;
  assert.equal(data.section, "GENERAL");
  assert.deepEqual(data.lecture, { id: D1, isDefault: true, title: null, date: null });
  assert.equal(data.assignment.lectureId, D1, "a lecture id in the body is ignored");
  assert.equal(data.assignment.title, "Essay");
  assert.equal(data.assignment.description, "Write an essay.");
  assert.equal(created().length, 1);
  assert.equal(created()[0].lectureId, D1);
  assert.equal(created()[0].status, 0);
  assert.deepEqual(state.events, [{ classId: C1 }]);
  const listed = await classGet(C1);
  assert.ok(ids(listed).includes(data.assignment.id), "listed in General Assignments");
});

test("POST with a normal lectureId: created on that lecture; the LECTURE section is returned", async () => {
  const result = await classPost(C1, { query: `?lectureId=${L1}` });
  assert.equal(result.status, 201);
  assert.equal(result.body.data.section, "LECTURE");
  assert.equal(result.body.data.assignment.lectureId, L1);
  assert.deepEqual(ids(await classGet(C1, `?lectureId=${L1}`)).sort(), ["l-1", result.body.data.assignment.id].sort());
  assert.ok(!ids(await classGet(C1)).includes(result.body.data.assignment.id), "not in General Assignments");
});

test("POST validation is the lecture API's (title, description, due date); nothing created", async () => {
  for (const body of [
    { title: "E", description: "Write an essay.", dueDate: FUTURE },
    { title: "Essay", description: "Hi", dueDate: FUTURE },
    { title: "Essay", description: "Write an essay." },
    { title: "Essay", description: "Write an essay.", dueDate: "not a date" },
  ]) {
    const result = await classPost(C1, { body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(code(result), "VALIDATION_ERROR");
  }
  assert.equal((await classPost(C1, { body: "{not json" })).status, 400);
  assert.equal(created().length, 0);
});

// ---- 7-9, 11: errors and protection --------------------------------------------------------------------

test("a class without a default lecture: 409 DEFAULT_LECTURE_MISSING (in this page's words); nothing created", async () => {
  for (const result of [await classGet(C_NODEFAULT), await classPost(C_NODEFAULT)]) {
    assert.equal(result.status, 409);
    assert.equal(code(result), "DEFAULT_LECTURE_MISSING");
    assert.match(result.body.error.message, /General Assignments/);
  }
  // Its normal lectures still work.
  assert.equal((await classGet(C_NODEFAULT, `?lectureId=${L_NODEFAULT}`)).status, 200);
  assert.equal(created().length, 0);
});

test("another teacher, a deactivated class or an unknown class: 404 CLASS_NOT_FOUND, before any lecture is looked up", async () => {
  state.teacher = T2;
  for (const result of [await classGet(C1), await classPost(C1), await classGet(C1, `?lectureId=${L1}`), await classPost(C1, { query: `?lectureId=${L1}` })]) {
    assert.equal(result.status, 404);
    assert.equal(code(result), "CLASS_NOT_FOUND");
  }
  assert.ok(!state.queries.some(([q]) => q === "lecture.findFirst"));
  state.teacher = T1;
  assert.equal(code(await classGet(C_OFF)), "CLASS_NOT_FOUND");
  assert.equal(code(await classGet("99999999-9999-4999-8999-999999999999")), "CLASS_NOT_FOUND");
  assert.equal(created().length, 0);
});

test("lectureId of another class, the default lecture itself or a removed lecture: 404 LECTURE_NOT_FOUND; malformed: 400", async () => {
  for (const lectureId of [L2, D1, D2, L1_REMOVED]) {
    for (const result of [await classGet(C1, `?lectureId=${lectureId}`), await classPost(C1, { query: `?lectureId=${lectureId}` })]) {
      assert.equal(result.status, 404, lectureId);
      assert.equal(code(result), "LECTURE_NOT_FOUND");
    }
  }
  assert.equal((await classGet(C1, "?lectureId=bad%20id")).status, 400);
  assert.equal((await classGet(C1, `?lectureId=${"a".repeat(65)}`)).status, 400);
  assert.equal(created().length, 0);
});

test("POST same-origin protection: a missing or foreign Origin, or a cross-site fetch, is 403 before the session; nothing created", async () => {
  for (const headers of [{}, { origin: "https://evil.example" }, { origin: APP_ORIGIN, "sec-fetch-site": "cross-site" }]) {
    const result = await classPost(C1, { headers });
    assert.equal(result.status, 403, JSON.stringify(headers));
    assert.equal(code(result), "CROSS_ORIGIN_REQUEST_REJECTED");
  }
  state.teacher = null;
  assert.equal((await classPost(C1, { headers: {} })).status, 403);
  assert.equal((await classPost(C1)).status, 401, "same origin, no session");
  assert.equal((await classGet(C1)).status, 401);
  assert.equal(created().length, 0);
});

// ---- 10: the existing item routes on a General Assignment ----------------------------------------------

test("existing item routes work on a General Assignment with the lecture id this API returns: update, submissions, file, marks", async () => {
  const lectureId = (await classGet(C1)).body.data.lecture.id;
  assert.equal(lectureId, D1);
  const params = { id: lectureId, assignmentId: "g-early" };

  const updated = await call(itemRoute.PUT, `${APP_ORIGIN}/api/lectures/${D1}/assignments/g-early`, params, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Essay (revised)" }),
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.data.assignment.title, "Essay (revised)");
  assert.equal(updated.body.data.assignment.lectureId, D1);

  const subs = await call(submissionsRoute.GET, `${APP_ORIGIN}/api/lectures/${D1}/assignments/g-early/submissions`, params);
  assert.equal(subs.status, 200, JSON.stringify(subs.body));
  assert.equal(subs.body.data.totalSubmissions, 2);
  assert.equal(subs.body.data.assignment.totalEnrolled, 2);
  assert.deepEqual(subs.body.data.submissions.map((s) => s.submissionId), ["sub-1", "sub-2"]);

  const file = await call(fileRoute.GET, `${APP_ORIGIN}/api/lectures/${D1}/assignments/g-early/submissions/sub-1/file`, { ...params, submissionId: "sub-1" });
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-disposition"), /attachment; filename="nimal-perera-sub-1\.pdf"/);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].kind, "SUBMISSION");

  const marks = await call(marksRoute.PATCH, `${APP_ORIGIN}/api/lectures/${D1}/assignments/g-early/submissions/sub-1`, { ...params, submissionId: "sub-1" }, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marks: 78 }),
  });
  assert.equal(marks.status, 200, JSON.stringify(marks.body));
  assert.equal(marks.body.data.marks, 78);
  assert.equal(state.submissions.find((s) => s.id === "sub-1").marks, 78);
});

test("existing permanent deletion works on a General Assignment: its submissions, then the assignment", async () => {
  const result = await call(itemRoute.DELETE, `${APP_ORIGIN}/api/lectures/${D1}/assignments/g-early`, { id: D1, assignmentId: "g-early" }, { method: "DELETE" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(!state.assignments.some((a) => a.id === "g-early"));
  assert.equal(state.submissions.filter((s) => s.assignmentId === "g-early").length, 0);
  assert.deepEqual(state.events, [{ classId: C1 }]);
  assert.deepEqual(ids(await classGet(C1)), ["g-late"]);
});

test("item routes on a General Assignment keep their ownership checks: another teacher or another lecture id is 404", async () => {
  state.teacher = T2;
  const params = { id: D1, assignmentId: "g-early" };
  assert.equal((await call(submissionsRoute.GET, `${APP_ORIGIN}/x`, params)).status, 404);
  assert.equal((await call(fileRoute.GET, `${APP_ORIGIN}/x`, { ...params, submissionId: "sub-1" })).status, 404);
  const put = await call(itemRoute.PUT, `${APP_ORIGIN}/x`, params, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Hijack" }) });
  assert.equal(put.status, 404);
  assert.equal((await call(itemRoute.DELETE, `${APP_ORIGIN}/x`, params, { method: "DELETE" })).status, 404);
  state.teacher = T1;
  // The right teacher, but the General Assignment addressed through a normal lecture of the class.
  assert.equal((await call(submissionsRoute.GET, `${APP_ORIGIN}/x`, { id: L1, assignmentId: "g-early" })).status, 404);
  assert.equal(state.assignments.find((a) => a.id === "g-early").title, "Assignment g-early");
  assert.equal(opened.length, 0);
});

// ---- 12: the existing lecture-level list / create routes, unchanged --------------------------------------

test("the lecture-level list / create routes are unchanged: a normal lecture works; the default lecture is still refused", async () => {
  const list = await call(lectureListRoute.GET, `${APP_ORIGIN}/api/lectures/${L1}/assignments`, { id: L1 });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map((a) => a.id), ["l-1"]);

  for (const result of [
    await call(lectureListRoute.GET, `${APP_ORIGIN}/api/lectures/${D1}/assignments`, { id: D1 }),
    await call(lectureListRoute.POST, `${APP_ORIGIN}/api/lectures/${D1}/assignments`, { id: D1 }, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Essay", description: "Write an essay.", dueDate: FUTURE }),
    }),
  ]) {
    assert.equal(result.status, 404);
    assert.equal(code(result), "LECTURE_NOT_FOUND");
  }
  assert.equal(created().length, 0);

  const createdOnLecture = await call(lectureListRoute.POST, `${APP_ORIGIN}/api/lectures/${L1}/assignments`, { id: L1 }, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Essay", description: "Write an essay.", dueDate: FUTURE }),
  });
  assert.equal(createdOnLecture.status, 201);
  assert.equal(createdOnLecture.body.data.assignment.lectureId, L1);
});

test("source: the class API validates with the lecture API's schema, resolves through the shared resolver, and adds no item routes", () => {
  const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
  const route = read("app", "api", "classes", "[id]", "assignments", "route.ts");
  assert.match(route, /createAssignmentSchema\.safeParse\(body\)/);
  assert.match(route, /checkSameOriginRequest\(request\)/);
  assert.ok(route.indexOf("checkSameOriginRequest") < route.indexOf("requireTeacherSession()", route.indexOf("export async function POST")), "origin before session");
  const svc = read("services", "class-assignments-service.ts");
  assert.match(svc, /resolveClassLectureForTeacher\(teacherId, classId, lectureId\)/);
  assert.doesNotMatch(svc, /prisma\./, "no queries of its own: the existing lecture-service functions");
  assert.deepEqual(fs.readdirSync(path.join(root, "app", "api", "classes", "[id]", "assignments")), ["route.ts"]);
  assert.equal(service.GENERAL_ASSIGNMENTS_LABEL, "General Assignments");
});
