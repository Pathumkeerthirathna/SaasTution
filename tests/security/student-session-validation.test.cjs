/*
 * Student Profile SP-5.4: central student session validation.
 *
 *   npm run test:security
 *
 * lib/student-session.ts checks every student session against the database
 * (exists, session version, status); lib/auth-session.ts (requireStudentSession,
 * the STUDENT branch of requireAppSession, getOptionalSession), the student
 * layout and settings page, the session join page and /api/auth/me use it.
 * Teacher, admin and guardian sessions are unchanged and never query students.
 *
 * No database: lib/prisma.ts, next/headers (the cookie) and next/navigation
 * (redirect) are fakes; JWT_SECRET is a throwaway value set here.
 */

"use strict";

require("../helpers/no-class-access-restrictions.cjs"); // this suite does not model class fees (tests/class-access covers access control)

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

process.env.JWT_SECRET = "sp-5-4-test-secret-not-a-real-one-0123456789";

const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();
globalThis.React = require("react"); // the pages' JSX compiles to React.createElement here

function fakeAt(filename, exports) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const fake = (relativePath, exports) => fakeAt(path.join(root, relativePath), exports);

// ---- Fakes ------------------------------------------------------------------------

const state = { cookie: null, students: new Map(), teachers: new Map(), dbError: null, studentQueries: [], teacherQueries: [] };

fakeAt(require.resolve("next/headers", { paths: [root] }), {
  cookies: () => ({ get: (name) => (name === "teacher_session" && state.cookie ? { name, value: state.cookie } : undefined) }),
});
class Redirect extends Error {
  constructor(url) {
    super(`redirect ${url}`);
    this.url = url;
  }
}
fakeAt(require.resolve("next/navigation", { paths: [root] }), {
  redirect: (url) => {
    throw new Redirect(url);
  },
});

fake("lib/prisma.ts", {
  prisma: {
    student: {
      findUnique: async (args) => {
        state.studentQueries.push(args);
        if (state.dbError) throw state.dbError;
        const row = state.students.get(args.where.id);
        if (!row) return null;
        const picked = {};
        for (const key of Object.keys(args.select)) picked[key] = row[key];
        return picked;
      },
    },
    teacher: {
      findUnique: async (args) => {
        state.teacherQueries.push(args);
        const row = state.teachers.get(args.where.id);
        return row ? { id: row.id, name: row.name, email: row.email, createdAt: row.createdAt } : null;
      },
    },
  },
});
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });
fake("components/student-portal/student-shell.tsx", { StudentShell: (props) => ({ shell: true, ...props }) });
fake("components/Jitsi/JitsiClassroom.tsx", { __esModule: true, default: () => null });

const auth = require(path.join(root, "lib", "auth.ts"));
const guardianAuth = require(path.join(root, "lib", "guardian-auth.ts"));
const studentSession = require(path.join(root, "lib", "student-session.ts"));
const authSession = require(path.join(root, "lib", "auth-session.ts"));
const meRoute = require(path.join(root, "app", "api", "auth", "me", "route.ts"));
const StudentLayout = require(path.join(root, "app", "student", "layout.tsx")).default;
const StudentSettingsPage = require(path.join(root, "app", "student", "settings", "page.tsx")).default;
const SessionJoinPage = require(path.join(root, "app", "session", "join", "page.tsx")).default;

// ---- Helpers ------------------------------------------------------------------------

const CREATED = new Date("2026-07-25T09:00:00.000Z");
function reset() {
  state.cookie = null;
  state.dbError = null;
  state.studentQueries = [];
  state.teacherQueries = [];
  state.students = new Map();
  state.teachers = new Map([["t-1", { id: "t-1", name: "Teacher", email: "t@example.test", createdAt: CREATED }]]);
}
function student(id, patch = {}) {
  state.students.set(id, { id, name: `Name ${id}`, email: `${id}@example.test`, registrationNumber: `REG-${id}`, createdAt: CREATED, status: 0, sessionVersion: 0, ...patch });
}
const studentToken = (id, sessionVersion = 0) => auth.signAuthToken({ sub: id, email: `${id}@example.test`, role: "STUDENT", name: `Name ${id}`, sessionVersion });
/** A student token issued before session versioning (no `sv`). */
const legacyStudentToken = (id) =>
  new (require("jose").SignJWT)({ email: `${id}@example.test`, role: "STUDENT", name: `Name ${id}` })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(id)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
const teacherToken = () => auth.signAuthToken({ sub: "t-1", email: "t@example.test", role: "TEACHER", name: "Teacher" });
const adminToken = () => auth.signAuthToken({ sub: "admin-pathum", email: "admin@example.test", role: "ADMIN", name: "Admin" });
const payloadOf = async (token) => auth.verifyAuthToken(token);

async function rejectsWith(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.deepEqual([error.statusCode, error.code], [status, code], error.message);
    return true;
  });
}

const SELECT = { status: true, sessionVersion: true };

// ---- The central validator ------------------------------------------------------------------

test("validator: active student with a matching version is ACTIVE; only status + sessionVersion are read, by the token's id", async () => {
  reset();
  student("s-1", { sessionVersion: 3 });
  assert.equal(await studentSession.checkStudentSessionAccess(await payloadOf(await studentToken("s-1", 3))), "ACTIVE");
  assert.deepEqual(state.studentQueries, [{ where: { id: "s-1" }, select: SELECT }]);
});

test("validator: an old JWT without `sv` passes while the database version is 0, and stops once it is raised", async () => {
  reset();
  student("s-1");
  const legacy = await payloadOf(await legacyStudentToken("s-1"));
  assert.equal(legacy.sessionVersion, 0);
  assert.equal(await studentSession.checkStudentSessionAccess(legacy), "ACTIVE");
  state.students.get("s-1").sessionVersion = 1;
  assert.equal(await studentSession.checkStudentSessionAccess(legacy), "INVALID");
});

test("validator: a version mismatch (either direction) is 401 UNAUTHORIZED", async () => {
  reset();
  student("s-1", { sessionVersion: 2 });
  for (const sv of [0, 1, 3]) {
    const payload = await payloadOf(await studentToken("s-1", sv));
    assert.equal(await studentSession.checkStudentSessionAccess(payload), "INVALID", `token ${sv}`);
    await rejectsWith(studentSession.assertStudentSessionAccess(payload), 401, "UNAUTHORIZED");
  }
});

test("validator: inactive is 403 STUDENT_ACCOUNT_INACTIVE (only with a matching version: a stale token learns nothing)", async () => {
  reset();
  student("s-1", { status: 1, sessionVersion: 1 });
  await rejectsWith(studentSession.assertStudentSessionAccess(await payloadOf(await studentToken("s-1", 1))), 403, "STUDENT_ACCOUNT_INACTIVE");
  await rejectsWith(studentSession.assertStudentSessionAccess(await payloadOf(await studentToken("s-1", 0))), 401, "UNAUTHORIZED");
});

test("validator: deleted, missing and unknown-status students are 401 UNAUTHORIZED", async () => {
  reset();
  student("deleted", { status: 2 });
  student("odd", { status: 7 });
  for (const id of ["deleted", "missing", "odd"]) {
    const payload = await payloadOf(await studentToken(id, 0));
    assert.equal(await studentSession.checkStudentSessionAccess(payload), "INVALID", id);
    await rejectsWith(studentSession.assertStudentSessionAccess(payload), 401, "UNAUTHORIZED");
  }
});

test("validator: an invalid stored version or a database error fails closed (thrown, never access)", async () => {
  reset();
  for (const sessionVersion of [null, -1, 1.5, "0", undefined]) {
    student("s-1", { sessionVersion });
    await assert.rejects(studentSession.checkStudentSessionAccess(await payloadOf(await studentToken("s-1", 0))), /Invalid student session version/, String(sessionVersion));
  }
  student("s-1");
  state.dbError = new Error("connection refused");
  await assert.rejects(studentSession.checkStudentSessionAccess(await payloadOf(await studentToken("s-1", 0))), /connection refused/);
  await assert.rejects(studentSession.assertStudentSessionAccess(await payloadOf(await studentToken("s-1", 0))), /connection refused/);
});

test("validator: a non-student or malformed payload is INVALID without a query", async () => {
  reset();
  for (const payload of [
    { sub: "t-1", email: "e", name: "n", role: "TEACHER" },
    { sub: "", email: "e", name: "n", role: "STUDENT", sessionVersion: 0 },
    { sub: "s-1", email: "e", name: "n", role: "STUDENT", sessionVersion: -1 },
    { sub: "s-1", email: "e", name: "n", role: "STUDENT" },
  ]) {
    assert.equal(await studentSession.checkStudentSessionAccess(payload), "INVALID");
  }
  assert.equal(state.studentQueries.length, 0);
});

// ---- lib/auth-session.ts ----------------------------------------------------------------

test("requireStudentSession: same result shape for an active student; 401 / 403 / thrown DB error otherwise", async () => {
  reset();
  student("s-1", { sessionVersion: 2 });
  state.cookie = await studentToken("s-1", 2);
  assert.deepEqual(await authSession.requireStudentSession(), { studentId: "s-1", email: "s-1@example.test", name: "Name s-1", role: "STUDENT" });

  state.cookie = await studentToken("s-1", 1);
  await rejectsWith(authSession.requireStudentSession(), 401, "UNAUTHORIZED");
  student("s-1", { status: 1, sessionVersion: 2 });
  state.cookie = await studentToken("s-1", 2);
  await rejectsWith(authSession.requireStudentSession(), 403, "STUDENT_ACCOUNT_INACTIVE");
  student("s-1", { status: 2, sessionVersion: 2 });
  await rejectsWith(authSession.requireStudentSession(), 401, "UNAUTHORIZED");
  state.students.delete("s-1");
  await rejectsWith(authSession.requireStudentSession(), 401, "UNAUTHORIZED");
  state.dbError = new Error("db down");
  await assert.rejects(authSession.requireStudentSession(), /db down/);
});

test("requireStudentSession: no cookie, a bad token, or a teacher / admin / guardian token: 401 as before, with no student query", async () => {
  reset();
  await rejectsWith(authSession.requireStudentSession(), 401, "UNAUTHORIZED");
  for (const token of ["garbage", await teacherToken(), await adminToken(), await guardianAuth.signGuardianToken({ sub: "g-1", email: "g@example.test", role: "GUARDIAN", name: "G" })]) {
    state.cookie = token;
    await rejectsWith(authSession.requireStudentSession(), 401, "UNAUTHORIZED");
  }
  assert.equal(state.studentQueries.length, 0);
});

test("requireAppSession: a STUDENT session is validated centrally; teacher and admin sessions are unchanged (no query)", async () => {
  reset();
  student("s-1");
  state.cookie = await studentToken("s-1", 0);
  assert.deepEqual(await authSession.requireAppSession(), { userId: "s-1", email: "s-1@example.test", name: "Name s-1", role: "STUDENT" });
  student("s-1", { status: 1 });
  await rejectsWith(authSession.requireAppSession(), 403, "STUDENT_ACCOUNT_INACTIVE");
  student("s-1", { sessionVersion: 4 });
  await rejectsWith(authSession.requireAppSession(), 401, "UNAUTHORIZED");
  const studentQueries = state.studentQueries.length;

  state.cookie = await teacherToken();
  assert.deepEqual(await authSession.requireAppSession(), { userId: "t-1", email: "t@example.test", name: "Teacher", role: "TEACHER" });
  state.cookie = await adminToken();
  assert.deepEqual(await authSession.requireAppSession(), { userId: "admin-pathum", email: "admin@example.test", name: "Admin", role: "ADMIN" });
  assert.equal(state.studentQueries.length, studentQueries, "teacher / admin never query students");
  state.cookie = null;
  await rejectsWith(authSession.requireAppSession(), 401, "UNAUTHORIZED");
});

test("requireTeacherSession / requireAdminSession: unchanged results and errors, never a student query", async () => {
  reset();
  student("s-1", { status: 1 });
  state.cookie = await teacherToken();
  assert.deepEqual(await authSession.requireTeacherSession(), { teacherId: "t-1", email: "t@example.test", name: "Teacher", role: "TEACHER" });
  await rejectsWith(authSession.requireAdminSession(), 403, "FORBIDDEN");
  state.cookie = await adminToken();
  assert.deepEqual(await authSession.requireAdminSession(), { adminId: "admin-pathum", email: "admin@example.test", name: "Admin", role: "ADMIN" });
  await rejectsWith(authSession.requireTeacherSession(), 401, "UNAUTHORIZED");
  state.cookie = await studentToken("s-1", 0); // an inactive student on teacher / admin routes: same errors as before
  await rejectsWith(authSession.requireTeacherSession(), 401, "UNAUTHORIZED");
  await rejectsWith(authSession.requireAdminSession(), 403, "FORBIDDEN");
  assert.equal(state.studentQueries.length, 0);
});

test("getOptionalSession: an invalid student session is no session; teachers unchanged; a DB error still throws", async () => {
  reset();
  student("s-1");
  state.cookie = await studentToken("s-1", 0);
  assert.deepEqual(await authSession.getOptionalSession(), { userId: "s-1", email: "s-1@example.test", name: "Name s-1", role: "STUDENT" });
  student("s-1", { status: 2 });
  assert.equal(await authSession.getOptionalSession(), null);
  state.cookie = await teacherToken();
  assert.deepEqual(await authSession.getOptionalSession(), { userId: "t-1", email: "t@example.test", name: "Teacher", role: "TEACHER" });
  state.cookie = null;
  assert.equal(await authSession.getOptionalSession(), null);
  state.cookie = await studentToken("s-1", 0);
  state.dbError = new Error("db down");
  await assert.rejects(authSession.getOptionalSession(), /db down/);
});

// ---- /api/auth/me ---------------------------------------------------------------------------

async function me() {
  const response = await meRoute.GET(new Request("http://localhost:3000/api/auth/me"));
  return { status: response.status, body: await response.json() };
}

test("/api/auth/me: student branch validated centrally (200 / 401 / 403 / 500), the user payload unchanged", async () => {
  reset();
  student("s-1", { sessionVersion: 1 });
  state.cookie = await studentToken("s-1", 1);
  const ok = await me();
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.data.user, { id: "s-1", name: "Name s-1", email: "s-1@example.test", registrationNumber: "REG-s-1", createdAt: CREATED.toISOString(), role: "STUDENT" });

  state.cookie = await studentToken("s-1", 0);
  assert.deepEqual([(await me()).status, (await me()).body.error.code], [401, "UNAUTHORIZED"]);
  student("s-1", { status: 1, sessionVersion: 1 });
  state.cookie = await studentToken("s-1", 1);
  const inactive = await me();
  assert.deepEqual([inactive.status, inactive.body.error.code], [403, "STUDENT_ACCOUNT_INACTIVE"]);
  student("s-1", { status: 2, sessionVersion: 1 });
  assert.deepEqual([(await me()).status, (await me()).body.error.code], [401, "UNAUTHORIZED"]);
  state.students.delete("s-1");
  assert.deepEqual([(await me()).status, (await me()).body.error.code], [401, "UNAUTHORIZED"]);
  state.dbError = new Error("db down");
  const failed = await me();
  assert.deepEqual([failed.status, failed.body.error.code, failed.body.success], [500, "INTERNAL_SERVER_ERROR", false]);
});

test("/api/auth/me: teacher and admin branches unchanged (no student query)", async () => {
  reset();
  state.cookie = await teacherToken();
  const teacher = await me();
  assert.equal(teacher.status, 200);
  assert.deepEqual(teacher.body.data.user, { id: "t-1", name: "Teacher", email: "t@example.test", createdAt: CREATED.toISOString(), role: "TEACHER" });
  state.cookie = await adminToken();
  const admin = await me();
  assert.deepEqual(admin.body.data.user, { id: "admin-pathum", name: "Admin", email: "admin@example.test", role: "ADMIN" });
  state.cookie = null;
  assert.equal((await me()).status, 401);
  assert.equal(state.studentQueries.length, 0);
});

// ---- Pages -------------------------------------------------------------------------------------

async function outcome(promise) {
  try {
    await promise;
    return "RENDERED";
  } catch (error) {
    if (error instanceof Redirect) return error.url;
    throw error;
  }
}

test("student layout: renders only for an active student with a matching version; otherwise /login; DB error is an error, not the portal", async () => {
  reset();
  student("s-1", { sessionVersion: 2 });
  state.cookie = await studentToken("s-1", 2);
  const element = await StudentLayout({ children: "child" });
  assert.equal(element.props.studentName, "Name s-1");

  state.cookie = await legacyStudentToken("s-1");
  assert.equal(await outcome(StudentLayout({ children: null })), "/login", "old token after the version was raised");
  for (const patch of [{ status: 1 }, { status: 2 }]) {
    student("s-1", { sessionVersion: 2, ...patch });
    state.cookie = await studentToken("s-1", 2);
    assert.equal(await outcome(StudentLayout({ children: null })), "/login", JSON.stringify(patch));
  }
  state.students.delete("s-1");
  assert.equal(await outcome(StudentLayout({ children: null })), "/login");
  student("s-1", { sessionVersion: 2 });
  state.dbError = new Error("db down");
  await assert.rejects(StudentLayout({ children: null }), /db down/);
  state.dbError = null;
  state.cookie = await teacherToken();
  assert.equal(await outcome(StudentLayout({ children: null })), "/login");
});

test("student settings: same central check (active renders; mismatch / inactive / deleted / missing -> /login; DB error thrown)", async () => {
  reset();
  student("s-1");
  state.cookie = await legacyStudentToken("s-1");
  assert.equal(await outcome(StudentSettingsPage()), "RENDERED", "old token, database version 0");
  assert.deepEqual(state.studentQueries.at(-1), { where: { id: "s-1" }, select: SELECT }, "the only student read");
  for (const patch of [{ sessionVersion: 1 }, { status: 1 }, { status: 2 }]) {
    student("s-1", patch);
    assert.equal(await outcome(StudentSettingsPage()), "/login", JSON.stringify(patch));
  }
  state.students.delete("s-1");
  assert.equal(await outcome(StudentSettingsPage()), "/login");
  student("s-1");
  state.dbError = new Error("db down");
  await assert.rejects(StudentSettingsPage(), /db down/);
});

test("session join page: an invite needs an active student with a matching version; without an invite nothing changes", async () => {
  reset();
  student("s-1");
  const invite = { searchParams: { invite: "inv-123" } };
  state.cookie = await studentToken("s-1", 0);
  assert.equal(await outcome(SessionJoinPage(invite)), "RENDERED");
  for (const patch of [{ sessionVersion: 1 }, { status: 1 }, { status: 2 }]) {
    student("s-1", patch);
    assert.equal(await outcome(SessionJoinPage(invite)), "/login?invite=inv-123", JSON.stringify(patch));
  }
  state.cookie = null;
  assert.equal(await outcome(SessionJoinPage(invite)), "/login?invite=inv-123");
  const before = state.studentQueries.length;
  state.cookie = await teacherToken();
  assert.equal(await outcome(SessionJoinPage({ searchParams: {} })), "RENDERED", "no invite: unchanged (teachers join here too)");
  assert.equal(state.studentQueries.length, before);
});

// ---- Guardian ----------------------------------------------------------------------------------

test("guardian sessions are untouched: their own cookie and verifier, never a student query", async () => {
  reset();
  const token = await guardianAuth.signGuardianToken({ sub: "g-1", email: "g@example.test", role: "GUARDIAN", name: "G" });
  assert.deepEqual(await guardianAuth.verifyGuardianToken(token), { sub: "g-1", email: "g@example.test", role: "GUARDIAN", name: "G" });
  state.cookie = token; // even in the app cookie it is not an app session
  await rejectsWith(authSession.requireAppSession(), 401, "UNAUTHORIZED");
  assert.equal(state.studentQueries.length, 0);
  const guardianSessionSource = require("node:fs").readFileSync(path.join(root, "lib", "guardian-auth-session.ts"), "utf8");
  assert.doesNotMatch(guardianSessionSource, /student-session|sessionVersion/);
});
