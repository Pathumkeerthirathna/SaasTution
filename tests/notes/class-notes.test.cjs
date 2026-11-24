/*
 * Notes page redesign, Stage 1 (backend): class-scoped notes.
 *  - services/class-notes-service.ts (default lecture resolution, listings, order)
 *  - GET  /api/classes/[id]/notes[?lectureId=]          (teacher)
 *  - POST /api/classes/[id]/notes                        (teacher: General Note upload)
 *  - GET  /api/student/classes/[id]/notes[?lectureId=]   (student)
 *
 *   npm run test:notes
 *
 * The real routes, services and the real upload pipeline (POST
 * /api/lectures/[id]/notes: validation, stored file, Note row, NoteStudent
 * rows) run through tsx. Faked edges: Prisma (an in-memory Class / Lecture /
 * Note store; note.findMany applies Prisma's orderBy, NULLS LAST included),
 * the sessions, the storage quota reservation (a pass-through: quota is
 * tested in tests/storage-quota), live events and the student's monthly
 * resource access resolver (the real noteBillingMonth / resourceLockFor are
 * kept). Every upload runs with FILE_STORAGE_ROOT in a fresh temporary folder.
 * The order on real PostgreSQL: tests/notes/class-notes.db.test.cjs.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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
const S1 = "student-1";
const S2 = "student-2";
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

const utc = (iso) => new Date(iso);
let state;

function note(id, lectureId, uploadedAt, extra = {}) {
  return {
    id, lectureId, title: `Note ${id}`, kind: "NOTE", mimeType: "application/pdf", sizeBytes: 100, downloadCount: 0, lastDownloadedAt: null,
    visibility: "PRIVATE", access: "LOCKED", status: 0, uploadedAt: uploadedAt === null ? null : utc(uploadedAt), fileUrl: "x", storageKey: null, ...extra,
  };
}

function reset() {
  state = {
    teacher: T1,
    student: S1,
    lockedMonths: new Set(), // "classId:YYYY-M"
    queries: [],
    events: [],
    noteStudents: [],
    classes: {
      [C1]: { id: C1, name: "Physics", teacherId: T1, status: 0, schedule: "Mon" },
      [C2]: { id: C2, name: "Chemistry", teacherId: T1, status: 0, schedule: "Tue" },
      [C_OFF]: { id: C_OFF, name: "Old", teacherId: T1, status: 1, schedule: "Wed" },
      [C_NODEFAULT]: { id: C_NODEFAULT, name: "Biology", teacherId: T1, status: 0, schedule: "Thu" },
    },
    enrolments: [
      { classId: C1, studentId: S1, isActive: true },
      { classId: C2, studentId: S1, isActive: false }, // removed from C2
      { classId: C_OFF, studentId: S1, isActive: true },
      { classId: C_NODEFAULT, studentId: S1, isActive: true },
      { classId: C1, studentId: S2, isActive: true },
    ],
    lectures: {
      [D1]: { id: D1, classId: C1, title: "General Notes", date: utc("2026-01-05T00:00:00Z"), status: 0, isDefault: true },
      [L1]: { id: L1, classId: C1, title: "Kinematics", date: utc("2026-10-10T03:30:00Z"), status: 0, isDefault: false },
      [L1_REMOVED]: { id: L1_REMOVED, classId: C1, title: "Removed", date: utc("2026-10-11T03:30:00Z"), status: 1, isDefault: false },
      [D2]: { id: D2, classId: C2, title: "General Notes", date: utc("2026-01-05T00:00:00Z"), status: 0, isDefault: true },
      [L2]: { id: L2, classId: C2, title: "Organic", date: utc("2026-10-12T03:30:00Z"), status: 0, isDefault: false },
      [D_OFF]: { id: D_OFF, classId: C_OFF, title: "General Notes", date: utc("2026-01-05T00:00:00Z"), status: 0, isDefault: true },
      [L_NODEFAULT]: { id: L_NODEFAULT, classId: C_NODEFAULT, title: "Cells", date: utc("2026-10-13T03:30:00Z"), status: 0, isDefault: false },
    },
    notes: [
      // General Notes of C1: two uploads in November, one in October, one legacy (no uploadedAt).
      note("g-oct", D1, "2026-10-20T10:00:00Z"),
      note("g-legacy", D1, null),
      note("g-nov-a", D1, "2026-11-20T10:00:00Z"),
      note("g-nov-b", D1, "2026-11-20T10:00:00Z"), // same instant: id breaks the tie (b before a)
      note("g-removed", D1, "2026-11-21T10:00:00Z", { status: 1 }),
      // C1's normal lecture.
      note("l-1", L1, "2026-10-10T05:00:00Z"),
      note("l-legacy", L1, null),
      // Another class.
      note("c2-g", D2, "2026-11-01T00:00:00Z"),
      note("c2-l", L2, "2026-11-02T00:00:00Z"),
    ],
  };
}
reset();

// ---- Fake Prisma -----------------------------------------------------------------------------------

function pick(row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const [key, on] of Object.entries(select)) {
    if (!on) continue;
    if (key === "class") out.class = { ...state.classes[row.classId] };
    else out[key] = row[key];
  }
  return out;
}

const LECTURE_FILTERS = new Set(["id", "classId", "status", "isDefault", "class"]);
function lectureMatches(l, where) {
  for (const key of Object.keys(where)) if (!LECTURE_FILTERS.has(key)) throw new Error(`fake: unsupported lecture filter ${key}`);
  if (where.id !== undefined && l.id !== where.id) return false;
  if (where.classId !== undefined && l.classId !== where.classId) return false;
  if (where.status !== undefined && l.status !== where.status) return false;
  if (where.isDefault !== undefined && l.isDefault !== where.isDefault) return false;
  if (where.class?.teacherId !== undefined && state.classes[l.classId].teacherId !== where.class.teacherId) return false;
  return true;
}

/** Prisma's orderBy on Note: scalar "asc"/"desc", { sort, nulls }, and { lecture: { date } }. */
function compareNotes(orderBy) {
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  const value = (row, spec) => {
    const [key, dir] = Object.entries(spec)[0];
    if (key === "lecture") {
      const [k2, d2] = Object.entries(dir)[0];
      return { v: state.lectures[row.lectureId][k2], sort: d2, nulls: undefined };
    }
    return typeof dir === "string" ? { v: row[key], sort: dir, nulls: undefined } : { v: row[key], sort: dir.sort, nulls: dir.nulls };
  };
  const num = (v) => (v instanceof Date ? v.getTime() : v);
  return (a, b) => {
    for (const spec of specs) {
      const x = value(a, spec);
      const y = value(b, spec);
      if (x.v === null || y.v === null) {
        if (x.v === null && y.v === null) continue;
        // PostgreSQL's default: NULLS FIRST for DESC, NULLS LAST for ASC.
        const nulls = x.nulls ?? (x.sort === "desc" ? "first" : "last");
        return (x.v === null) === (nulls === "first") ? -1 : 1;
      }
      const p = num(x.v);
      const q = num(y.v);
      if (p < q) return x.sort === "desc" ? 1 : -1;
      if (p > q) return x.sort === "desc" ? -1 : 1;
    }
    return 0;
  };
}

const prisma = {
  class: {
    findFirst: async ({ where, select }) => {
      state.queries.push(["class.findFirst", where]);
      const c = state.classes[where.id];
      if (!c) return null;
      if (where.teacherId !== undefined && c.teacherId !== where.teacherId) return null;
      if (where.status !== undefined && c.status !== where.status) return null;
      const some = where.students?.some;
      if (some && !state.enrolments.some((e) => e.classId === c.id && e.studentId === some.studentId && e.isActive === some.isActive)) return null;
      return pick(c, select);
    },
  },
  lecture: {
    findFirst: async ({ where, select }) => {
      state.queries.push(["lecture.findFirst", where]);
      const l = Object.values(state.lectures).find((row) => lectureMatches(row, where));
      return l ? pick(l, select) : null;
    },
    create: async () => {
      throw new Error("a lecture must never be created here");
    },
  },
  note: {
    findMany: async ({ where, orderBy, select }) => {
      state.queries.push(["note.findMany", where, orderBy]);
      return state.notes
        .filter((n) => n.lectureId === where.lectureId && n.status === where.status)
        .sort(compareNotes(orderBy))
        .map((n) => pick(n, select));
    },
    create: async ({ data, select }) => {
      const row = { downloadCount: 0, lastDownloadedAt: null, visibility: "PRIVATE", access: "LOCKED", status: 0, ...data };
      state.notes.push(row);
      return pick(row, select);
    },
  },
  classStudent: {
    findMany: async ({ where }) =>
      state.enrolments.filter((e) => e.classId === where.classId && e.isActive === where.isActive).map((e) => ({ studentId: e.studentId })),
  },
  noteStudent: {
    createMany: async ({ data }) => {
      state.noteStudents.push(...data);
      return { count: data.length };
    },
  },
};

fake("lib/prisma.ts", { prisma });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    if (!state.teacher) throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    return { teacherId: state.teacher, role: "TEACHER" };
  },
  requireStudentSession: async () => {
    if (!state.student) throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { studentId: state.student, role: "STUDENT" };
  },
  requireAppSession: async () => { throw new Error("not used"); },
  requireAdminSession: async () => { throw new Error("not used"); },
  requireTeacherSessionForbiddingOtherRoles: async () => { throw new Error("not used"); },
  getOptionalSession: async () => null,
});
fake("lib/session-events.ts", { emitStudentDataChange: (payload) => state.events.push(payload), emitLiveChange: () => {} });
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });
const reservations = [];
fake("services/storage-reservation-service.ts", {
  reserveTeacherStorage: async (input) => {
    reservations.push(input);
    return { id: `res-${input.storageKey}`, ...input, expiresAt: new Date(Date.now() + 900_000) };
  },
  commitTeacherStorageReservation: async (_handle, _audience, fn) => fn(prisma),
  releaseTeacherStorageReservation: async () => true,
});
// The student's monthly access: the real month functions, a resolver that locks state.lockedMonths.
const realAccess = require(path.join(root, "services", "resource-access-service.ts"));
const accessLoads = [];
fake("services/resource-access-service.ts", {
  ...realAccess,
  loadStudentResourceAccess: async (studentId, options) => {
    accessLoads.push({ studentId, options });
    return {
      decide: (classId, month) =>
        state.lockedMonths.has(`${classId}:${month.year}-${month.month}`) ? { accessible: false, year: month.year, month: month.month } : { accessible: true, year: month.year, month: month.month },
    };
  },
});

const service = require(path.join(root, "services", "class-notes-service.ts"));
const teacherRoute = require(path.join(root, "app", "api", "classes", "[id]", "notes", "route.ts"));
const studentRoute = require(path.join(root, "app", "api", "student", "classes", "[id]", "notes", "route.ts"));
const lectureNotesRoute = require(path.join(root, "app", "api", "lectures", "[id]", "notes", "route.ts"));
const { resetSharedFileStorageCacheForTests } = require(path.join(root, "lib", "file-storage", "open-root.ts"));

test.beforeEach(() => {
  reset();
  reservations.length = 0;
  accessLoads.length = 0;
});

// ---- Helpers ---------------------------------------------------------------------------------------

async function call(handler, url, classId, init = {}) {
  const response = await handler(new Request(url, init), { params: { id: classId } });
  return { status: response.status, body: await response.json() };
}
const teacherGet = (classId, query = "") => call(teacherRoute.GET, `${APP_ORIGIN}/api/classes/${classId}/notes${query}`, classId);
const studentGet = (classId, query = "") => call(studentRoute.GET, `${APP_ORIGIN}/api/student/classes/${classId}/notes${query}`, classId);
const ids = (body) => body.data.notes.map((n) => n.id);
const code = (result) => result.body.error?.code;

const PDF = Buffer.from("%PDF-1.4\n% class notes test\n%%EOF\n");
function noteForm(extra = {}) {
  const form = new FormData();
  form.set("title", "Syllabus");
  form.set("kind", "NOTE");
  form.set("file", new File([PDF], "Syllabus.pdf", { type: "application/pdf" }));
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
}

/** POST a General Note with FILE_STORAGE_ROOT in a fresh sandbox; returns the response and the stored files. */
async function upload(classId, { form = noteForm(), headers = { origin: APP_ORIGIN } } = {}) {
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "class-notes-"));
  const previousRoot = process.env.FILE_STORAGE_ROOT;
  const previousDual = process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE;
  const previousCwd = process.cwd();
  fs.mkdirSync(path.join(sandbox, "files"));
  fs.mkdirSync(path.join(sandbox, "app"));
  process.env.FILE_STORAGE_ROOT = path.join(sandbox, "files");
  process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE = "false";
  resetSharedFileStorageCacheForTests();
  process.chdir(path.join(sandbox, "app"));
  try {
    const result = await call(teacherRoute.POST, `${APP_ORIGIN}/api/classes/${classId}/notes`, classId, { method: "POST", body: form, headers });
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(path.relative(sandbox, full).split(path.sep).join("/"));
      }
    };
    walk(sandbox);
    return { ...result, files };
  } finally {
    process.chdir(previousCwd);
    if (previousRoot === undefined) delete process.env.FILE_STORAGE_ROOT;
    else process.env.FILE_STORAGE_ROOT = previousRoot;
    if (previousDual === undefined) delete process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE;
    else process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE = previousDual;
    resetSharedFileStorageCacheForTests();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// ======================================================================================
// Default lecture resolution
// ======================================================================================

test("resolve (teacher): the owner's class's default lecture, found by classId + isDefault only", async () => {
  const { class: cls, lecture } = await service.resolveDefaultLectureForTeacher(T1, C1);
  assert.deepEqual(cls, { id: C1, name: "Physics" });
  assert.equal(lecture.id, D1);
  assert.equal(lecture.isDefault, true);
  assert.deepEqual(state.queries.find((q) => q[0] === "lecture.findFirst")[1], { classId: C1, isDefault: true, status: 0 });
  assert.deepEqual(state.queries.find((q) => q[0] === "class.findFirst")[1], { id: C1, teacherId: T1, status: 0 });
});

test("resolve (teacher): another teacher's, a deactivated or an unknown class is 404 CLASS_NOT_FOUND; no lecture is read", async () => {
  for (const [teacherId, classId] of [[T2, C1], [T1, C_OFF], [T1, "99999999-9999-4999-8999-999999999999"]]) {
    reset();
    await assert.rejects(service.resolveDefaultLectureForTeacher(teacherId, classId), (e) => e.code === "CLASS_NOT_FOUND" && e.statusCode === 404);
    assert.equal(state.queries.filter((q) => q[0] === "lecture.findFirst").length, 0);
  }
});

test("resolve: a class without a default lecture is 409 DEFAULT_LECTURE_MISSING, and none is created", async () => {
  await assert.rejects(service.resolveDefaultLectureForTeacher(T1, C_NODEFAULT), (e) => e.code === "DEFAULT_LECTURE_MISSING" && e.statusCode === 409);
  await assert.rejects(service.resolveDefaultLectureForStudent(S1, C_NODEFAULT), (e) => e.code === "DEFAULT_LECTURE_MISSING");
  assert.equal(Object.values(state.lectures).filter((l) => l.classId === C_NODEFAULT && l.isDefault).length, 0);
});

test("resolve (student): active enrolment in an active class only", async () => {
  assert.equal((await service.resolveDefaultLectureForStudent(S1, C1)).lecture.id, D1);
  for (const [studentId, classId] of [[S1, C2], [S2, C2], [S1, C_OFF]]) {
    await assert.rejects(service.resolveDefaultLectureForStudent(studentId, classId), (e) => e.code === "CLASS_NOT_FOUND", `${studentId} ${classId}`);
  }
});

// ======================================================================================
// Teacher listing
// ======================================================================================

test("teacher GET: General Notes by default, newest upload first, legacy (no uploadedAt) last, id breaks ties; uploadedAt returned", async () => {
  const { status, body } = await teacherGet(C1);
  assert.equal(status, 200);
  assert.equal(body.data.section, "GENERAL");
  assert.deepEqual(body.data.class, { id: C1, name: "Physics" });
  assert.equal(body.data.lecture.id, D1);
  assert.equal(body.data.lecture.isDefault, true);
  assert.deepEqual(ids(body), ["g-nov-b", "g-nov-a", "g-oct", "g-legacy"], "removed notes and other lectures excluded");
  const [first] = body.data.notes;
  assert.deepEqual(Object.keys(first).sort(), ["access", "downloadCount", "id", "kind", "lastDownloadedAt", "lectureId", "mimeType", "sizeBytes", "title", "uploadedAt", "visibility"].sort());
  assert.equal(first.uploadedAt, "2026-11-20T10:00:00.000Z");
  assert.equal(body.data.notes.at(-1).uploadedAt, null);
  assert.equal("fileUrl" in first || "storageKey" in first, false, "no file location");
});

test("teacher GET ?lectureId: a normal lecture of the class; its notes in the same order", async () => {
  const { status, body } = await teacherGet(C1, `?lectureId=${L1}`);
  assert.equal(status, 200);
  assert.equal(body.data.section, "LECTURE");
  assert.deepEqual([body.data.lecture.id, body.data.lecture.isDefault], [L1, false]);
  assert.deepEqual(ids(body), ["l-1", "l-legacy"]);
});

test("teacher GET ?lectureId: another class's lecture, the default lecture's id, a removed lecture: 404 LECTURE_NOT_FOUND; a malformed id: 400", async () => {
  for (const lectureId of [L2, D1, D2, L1_REMOVED]) {
    const result = await teacherGet(C1, `?lectureId=${lectureId}`);
    assert.deepEqual([result.status, code(result)], [404, "LECTURE_NOT_FOUND"], lectureId);
  }
  const bad = await teacherGet(C1, "?lectureId=../../etc");
  assert.deepEqual([bad.status, code(bad)], [400, "VALIDATION_ERROR"]);
});

test("teacher GET: another teacher's class 404, a class without a default lecture 409, no session 401", async () => {
  state.teacher = T2;
  assert.deepEqual([(await teacherGet(C1)).status, code(await teacherGet(C1))], [404, "CLASS_NOT_FOUND"]);
  state.teacher = T1;
  const missing = await teacherGet(C_NODEFAULT);
  assert.deepEqual([missing.status, code(missing)], [409, "DEFAULT_LECTURE_MISSING"]);
  const lectureStill = await teacherGet(C_NODEFAULT, `?lectureId=${L_NODEFAULT}`);
  assert.equal(lectureStill.status, 200, "lecture notes still work without a default lecture");
  state.teacher = null;
  assert.equal((await teacherGet(C1)).status, 401);
});

// ======================================================================================
// Teacher upload (General Notes)
// ======================================================================================

test("POST: a General Note through the existing pipeline: stored under the DEFAULT lecture, uploadedAt set, NoteStudent rows, 201 { note }", async () => {
  const before = Date.now();
  const result = await upload(C1);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.success, true);
  const created = result.body.data.note;
  assert.equal(created.lectureId, D1);
  const row = state.notes.find((n) => n.id === created.id);
  assert.ok(row.uploadedAt instanceof Date && row.uploadedAt.getTime() >= before, "uploadedAt: the upload instant");
  assert.match(row.storageKey, new RegExp(`^Teachers/${T1}/Lectures/${D1}/Notes/${created.id}/[0-9a-f]{32}\\.pdf$`));
  assert.deepEqual(result.files, [`files/${row.storageKey}`], "exactly the stored file");
  assert.deepEqual(reservations.map((r) => [r.teacherId, r.category, r.storageKey]), [[T1, "NOTE", row.storageKey]], "the quota was reserved");
  assert.deepEqual(state.noteStudents.map((s) => s.studentId).sort(), [S1, S2], "view rows for the class's active students");
  assert.deepEqual(state.events, [{ classId: C1 }]);

  const listed = await teacherGet(C1);
  assert.equal(ids(listed.body)[0], created.id, "the new note is listed first");
});

test("POST: a lecture id sent by the client is ignored (General Notes always go to the class's default lecture)", async () => {
  const result = await upload(C1, { form: noteForm({ lectureId: L2, classId: C2 }) });
  assert.equal(result.status, 201);
  assert.equal(result.body.data.note.lectureId, D1);
});

test("POST: same-origin first: a missing or foreign Origin is 403 before anything else; nothing stored", async () => {
  for (const headers of [{}, { origin: "https://evil.example" }, { origin: APP_ORIGIN, "sec-fetch-site": "cross-site" }]) {
    reset();
    const result = await upload(C1, { headers });
    assert.deepEqual([result.status, code(result)], [403, "CROSS_ORIGIN_REQUEST_REJECTED"]);
    assert.deepEqual(result.files, []);
    assert.equal(state.queries.length, 0, "no database access");
  }
});

test("POST: another teacher's class 404, a class without a default lecture 409, no session 401, an invalid file 400; nothing stored or reserved", async () => {
  state.teacher = T2;
  const other = await upload(C1);
  assert.deepEqual([other.status, code(other)], [404, "CLASS_NOT_FOUND"]);
  state.teacher = T1;
  const missing = await upload(C_NODEFAULT);
  assert.deepEqual([missing.status, code(missing)], [409, "DEFAULT_LECTURE_MISSING"]);
  const badType = await upload(C1, { form: noteForm({ file: new File(["x"], "x.exe", { type: "application/x-msdownload" }) }) });
  assert.deepEqual([badType.status, code(badType)], [400, "UNSUPPORTED_FILE_TYPE"], "the existing validation");
  state.teacher = null;
  assert.equal((await upload(C1)).status, 401);
  for (const r of [other, missing, badType]) assert.deepEqual(r.files, []);
  assert.equal(reservations.length, 0);
  assert.equal(state.notes.filter((n) => n.title === "Syllabus").length, 0);
});

// ======================================================================================
// Student listing
// ======================================================================================

test("student GET: General Notes by default, newest first, with uploadedAt, lock flags and the existing file route", async () => {
  const { status, body } = await studentGet(C1);
  assert.equal(status, 200);
  assert.equal(body.data.section, "GENERAL");
  assert.deepEqual(ids(body), ["g-nov-b", "g-nov-a", "g-oct", "g-legacy"]);
  const [first] = body.data.notes;
  assert.deepEqual(Object.keys(first).sort(), ["fileUrl", "id", "kind", "lectureId", "mimeType", "resourceAccess", "sizeBytes", "title", "uploadedAt"].sort());
  assert.deepEqual(first.resourceAccess, { locked: false, year: 2026, month: 11 });
  assert.equal(first.fileUrl, `/api/student/lectures/${D1}/notes/g-nov-b/file`);
  assert.deepEqual(accessLoads, [{ studentId: S1, options: { classIds: [C1] } }], "one batched access load for the class");
});

test("student GET: monthly locks apply to General Notes by upload month; a legacy note uses its lecture's date; locked notes have no file link", async () => {
  state.lockedMonths.add(`${C1}:2026-11`);
  state.lockedMonths.add(`${C1}:2026-1`); // the default lecture's date (legacy fallback)
  const { body } = await studentGet(C1);
  const byId = Object.fromEntries(body.data.notes.map((n) => [n.id, n]));
  assert.deepEqual(byId["g-nov-a"].resourceAccess, { locked: true, year: 2026, month: 11 });
  assert.equal(byId["g-nov-a"].fileUrl, null);
  assert.deepEqual(byId["g-oct"].resourceAccess, { locked: false, year: 2026, month: 10 });
  assert.notEqual(byId["g-oct"].fileUrl, null);
  assert.deepEqual(byId["g-legacy"].resourceAccess, { locked: true, year: 2026, month: 1 }, "no uploadedAt: the lecture's date decides");
  assert.equal(body.data.notes.length, 4, "locked notes are still listed (marked), as in the existing lists");
});

test("student GET ?lectureId: a normal lecture of the class; another class's lecture, the default lecture's id or a removed lecture is 404", async () => {
  const normal = await studentGet(C1, `?lectureId=${L1}`);
  assert.equal(normal.body.data.section, "LECTURE");
  assert.deepEqual(ids(normal.body), ["l-1", "l-legacy"]);
  for (const lectureId of [L2, D1, D2, L1_REMOVED]) {
    const result = await studentGet(C1, `?lectureId=${lectureId}`);
    assert.deepEqual([result.status, code(result)], [404, "LECTURE_NOT_FOUND"], lectureId);
  }
});

test("student GET: not enrolled, a removed enrolment or a deactivated class is 404 CLASS_NOT_FOUND (nothing revealed); no notes read", async () => {
  for (const [studentId, classId] of [[S1, C2], [S2, C2], [S1, C_OFF], ["stranger", C1]]) {
    reset();
    state.student = studentId;
    const result = await studentGet(classId);
    assert.deepEqual([result.status, code(result)], [404, "CLASS_NOT_FOUND"], `${studentId} ${classId}`);
    assert.equal(state.queries.filter((q) => q[0] === "note.findMany").length, 0);
  }
  reset();
  state.student = S1;
  state.enrolments = state.enrolments.filter((e) => !(e.studentId === S1 && e.classId === C1));
  assert.equal((await studentGet(C1, `?lectureId=${L1}`)).status, 404, "a lecture id does not bypass the enrolment check");
  state.student = null;
  assert.equal((await studentGet(C1)).status, 401);
});

test("student GET: a class without a default lecture is 409 for General Notes; its lectures still list", async () => {
  const missing = await studentGet(C_NODEFAULT);
  assert.deepEqual([missing.status, code(missing)], [409, "DEFAULT_LECTURE_MISSING"]);
  assert.equal((await studentGet(C_NODEFAULT, `?lectureId=${L_NODEFAULT}`)).status, 200);
});

// ======================================================================================
// Order, compatibility, guards
// ======================================================================================

test("the order: uploadedAt DESC NULLS LAST, the lecture's date DESC, id DESC (both lists)", () => {
  assert.deepEqual(service.CLASS_NOTES_ORDER, [{ uploadedAt: { sort: "desc", nulls: "last" } }, { lecture: { date: "desc" } }, { id: "desc" }]);
  const src = fs.readFileSync(path.join(root, "services", "class-notes-service.ts"), "utf8");
  assert.equal((src.match(/orderBy: CLASS_NOTES_ORDER/g) ?? []).length, 2);
});

test("compatibility: the existing per-lecture teacher API keeps its contract (an array, no uploadedAt) and still serves default-lecture notes", async () => {
  const response = await lectureNotesRoute.GET(new Request(`${APP_ORIGIN}/api/lectures/${D1}/notes`), { params: { id: D1 } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.data));
  assert.deepEqual(Object.keys(body.data[0]).sort(), ["access", "downloadCount", "id", "kind", "lastDownloadedAt", "lectureId", "mimeType", "sizeBytes", "title", "visibility"].sort());
});

test("compatibility: the student file route serves the listed notes (no isDefault filter) and keeps the monthly check first", () => {
  const file = fs.readFileSync(path.join(root, "app", "api", "student", "lectures", "[lectureId]", "notes", "[noteId]", "file", "route.ts"), "utf8");
  assert.doesNotMatch(file, /isDefault|NORMAL_LECTURE_WHERE/);
  assert.ok(file.indexOf("await assertResourceAccessForStudent(session.studentId, { noteId })") < file.indexOf("prisma.note.findFirst("));
  assert.match(file, /lecture: \{\s*status: 0,\s*class: \{\s*students: \{\s*some: \{\s*studentId: session\.studentId,\s*isActive: true,/);
});

test("guards: the new routes never accept a default lecture id from the client; the POST checks the origin before the session", () => {
  const teacher = fs.readFileSync(path.join(root, "app", "api", "classes", "[id]", "notes", "route.ts"), "utf8");
  const post = teacher.slice(teacher.indexOf("export async function POST"));
  assert.ok(post.indexOf("checkSameOriginRequest(request)") < post.indexOf("requireTeacherSession()"));
  assert.ok(post.indexOf("requireTeacherSession()") < post.indexOf("resolveDefaultLectureForTeacher("));
  assert.match(post, /uploadLectureNote\(request, \{ params: \{ id: lecture\.id \} \}\)/, "the existing pipeline, with the resolved default lecture");
  assert.doesNotMatch(post, /formData\(|searchParams/, "nothing from the client chooses the lecture");
  const studentSrc = fs.readFileSync(path.join(root, "app", "api", "student", "classes", "[id]", "notes", "route.ts"), "utf8");
  assert.match(studentSrc, /resourceLockFor\(/, "every listed note carries its lock (route coverage: a resource listing)");
});
