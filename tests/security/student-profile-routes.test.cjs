/*
 * Security regression tests for the teacher-only student profile API
 * (/api/student/Profile/[StudentId]/*, used by /dashboard/students/[id]).
 *
 *   npm run test:security
 *
 * Runs the REAL route handlers, ownership guard (lib/teacher-student-access.ts)
 * and middleware. Faked edges: the session (lib/auth-session.ts, mirroring its
 * 401 rules), Prisma (in-memory) and the data services (recorders), so every
 * test can also prove that a refused request never reached a service.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { createFakeDb } = require("../fee-waiver/helpers/fake-db.cjs");
const { AppError } = require(path.join(root, "lib", "error-handler.ts"));

const db = createFakeDb();

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

// ---- Session (same 401 rules as lib/auth-session.ts) ------------------------------
let session = null; // null | { role, userId }
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    if (!session) throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    if (session.role !== "TEACHER") throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { teacherId: session.userId, role: "TEACHER" };
  },
  requireStudentSession: async () => {
    throw new Error("not used");
  },
});
fake("lib/prisma.ts", { prisma: db.client });

// ---- Service recorders ---------------------------------------------------------------
const calls = [];
const recorder = (name) => async (...args) => {
  calls.push({ name, args });
  return { from: name, args };
};
const STUDENT_SERVICE_FUNCTIONS = [
  "getStudentClassesForTeacher",
  "getStudentPaymentSummary",
  "getStudentAttendanceSummary",
  "getStudentAttendanceAnalytics",
  "getStudentClassAttendance",
  "getStudentQuizSummary",
  "getStudentQuizAnalytics",
  "getStudentQuizResults",
];
fake("services/student-service.ts", Object.fromEntries(STUDENT_SERVICE_FUNCTIONS.map((n) => [n, recorder(n)])));
fake("services/student-device.service.ts", { getStudentDevicesByStudentId: recorder("getStudentDevicesByStudentId") });

// ---- Fixtures -------------------------------------------------------------------------
const T1 = "teacher-1";
const T2 = "teacher-2";
const S1 = "student-1"; // T1's student
const S2 = "student-2"; // T2's student
const S_DELETED = "student-3"; // T1's removed student
const C1 = "class-1"; // T1
const C2 = "class-2"; // T2
const PASSWORD_HASH = "$2a$10$SECRETHASHSECRETHASHSECRETHASHSECRETHASHSECRETHASHXX";

function seed() {
  db.reset();
  db.insert("Class", { id: C1, teacherId: T1, status: 0, name: "Maths" });
  db.insert("Class", { id: C2, teacherId: T2, status: 0, name: "Physics" });
  const student = (id, teacherId, status = 0) =>
    db.insert("Student", {
      id,
      name: `Name ${id}`,
      teacherId,
      contact: "0771234567",
      registrationNumber: `REG-${id}`,
      status,
      email: `${id}@example.test`,
      password: PASSWORD_HASH,
      registrationSource: "TEACHER",
      confirmationStatus: "APPROVED",
      gradeId: 6,
      registeredAt: new Date("2026-11-01T00:00:00.000Z"),
    });
  student(S1, T1);
  student(S2, T2);
  student(S_DELETED, T1, 2);
}

// ---- Routes under test (path relative to app/api/student/Profile/[StudentId]) ----------
const PROFILE = path.join(root, "app", "api", "student", "Profile", "[StudentId]");
const ROUTES = [
  { rel: "route.ts", url: "", service: null },
  { rel: "devices/route.ts", url: "/devices", service: "getStudentDevicesByStudentId" },
  { rel: "classes/route.ts", url: "/classes", service: "getStudentClassesForTeacher" },
  { rel: "payments/route.ts", url: "/payments", service: "getStudentPaymentSummary" },
  { rel: "attendance/route.ts", url: "/attendance", service: "getStudentAttendanceSummary" },
  { rel: "attendance/analytics/route.ts", url: "/attendance/analytics?months=6", service: "getStudentAttendanceAnalytics" },
  { rel: "attendance/[classId]/route.ts", url: "/attendance/CLASS", service: "getStudentClassAttendance", classScoped: true },
  { rel: "quizzes/route.ts", url: "/quizzes", service: "getStudentQuizSummary" },
  { rel: "quizzes/analytics/route.ts", url: "/quizzes/analytics?period=3months", service: "getStudentQuizAnalytics" },
  { rel: "quizzes/[classId]/route.ts", url: "/quizzes/CLASS", service: "getStudentQuizResults", classScoped: true },
];

const handlers = Object.fromEntries(ROUTES.map((r) => [r.rel, require(path.join(PROFILE, r.rel)).GET]));

async function call(route, studentId, classId = C1) {
  const url = `http://localhost/api/student/Profile/${studentId}${route.url.replace("CLASS", classId)}`;
  const params = Promise.resolve({ StudentId: studentId, ...(route.classScoped ? { classId } : {}) });
  const response = await handlers[route.rel](new Request(url), { params });
  return { status: response.status, body: await response.json() };
}

const asTeacher = (id) => (session = { role: "TEACHER", userId: id });

test.beforeEach(() => {
  seed();
  calls.length = 0;
  session = null;
});

// ---- Authorization matrix -------------------------------------------------------------

for (const route of ROUTES) {
  test(`${route.rel}: no session → 401, nothing read`, async () => {
    const { status, body } = await call(route, S1);
    assert.equal(status, 401);
    assert.equal(body.success, false);
    assert.equal(body.error.code, "UNAUTHORIZED");
    assert.deepEqual(calls, []);
  });

  test(`${route.rel}: student or admin session → 401, nothing read`, async () => {
    for (const role of ["STUDENT", "ADMIN"]) {
      session = { role, userId: role === "STUDENT" ? S1 : "admin-1" };
      const { status } = await call(route, S1);
      assert.equal(status, 401, role);
    }
    assert.deepEqual(calls, []);
  });

  test(`${route.rel}: another teacher's student → 404, nothing read or leaked`, async () => {
    asTeacher(T1);
    const { status, body } = await call(route, S2);
    assert.equal(status, 404);
    assert.equal(body.error.code, "STUDENT_NOT_FOUND");
    assert.doesNotMatch(JSON.stringify(body), /Name student-2|student-2@|REG-student-2/);
    assert.deepEqual(calls, []);
  });

  test(`${route.rel}: unknown or empty student id → 404`, async () => {
    asTeacher(T1);
    assert.equal((await call(route, "no-such-student")).status, 404);
    assert.equal((await call(route, "   ")).status, 404);
    assert.deepEqual(calls, []);
  });

  test(`${route.rel}: owning teacher → 200 with the same response shape`, async () => {
    asTeacher(T1);
    const { status, body } = await call(route, S1);
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(body.data);
    if (route.service) {
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, route.service);
      assert.equal(calls[0].args[0], S1, "the verified student id is passed on");
    }
  });
}

test("class-scoped routes: the class must belong to the same teacher", async () => {
  asTeacher(T1);
  for (const route of ROUTES.filter((r) => r.classScoped)) {
    calls.length = 0;
    const other = await call(route, S1, C2);
    assert.equal(other.status, 404, `${route.rel} other teacher's class`);
    assert.equal(other.body.error.code, "CLASS_NOT_FOUND");
    assert.equal((await call(route, S1, "no-such-class")).status, 404);
    assert.deepEqual(calls, []);

    const own = await call(route, S1, C1);
    assert.equal(own.status, 200);
    assert.deepEqual(calls[0].args, [S1, C1]);
  }
});

test("query parameters still reach the analytics services", async () => {
  asTeacher(T1);
  await call(ROUTES.find((r) => r.rel === "attendance/analytics/route.ts"), S1);
  await call(ROUTES.find((r) => r.rel === "quizzes/analytics/route.ts"), S1);
  assert.deepEqual(calls[0].args, [S1, { months: 6 }]);
  assert.deepEqual(calls[1].args, [S1, { period: "3months" }]);
});

test("the owning teacher can still view a removed (status 2) student", async () => {
  asTeacher(T1);
  const { status, body } = await call(ROUTES[0], S_DELETED);
  assert.equal(status, 200);
  assert.equal(body.data.status, 2);
});

// ---- Sensitive data -------------------------------------------------------------------

test("profile response never contains the password hash; expected fields remain", async () => {
  asTeacher(T1);
  const { body } = await call(ROUTES[0], S1);
  assert.equal("password" in body.data, false);
  assert.doesNotMatch(JSON.stringify(body), /SECRETHASH|\$2a\$/);
  for (const field of ["id", "name", "email", "contact", "registrationNumber", "status", "gradeId", "confirmationStatus", "registeredAt"]) {
    assert.ok(field in body.data, `keeps ${field}`);
  }
});

test("no student data is logged by any route", async () => {
  const logged = [];
  const original = { log: console.log, info: console.info };
  console.log = (...args) => logged.push(args);
  console.info = (...args) => logged.push(args);
  try {
    asTeacher(T1);
    for (const route of ROUTES) await call(route, S1);
  } finally {
    console.log = original.log;
    console.info = original.info;
  }
  assert.deepEqual(logged, []);
});

// ---- Source-level guards (future edits) --------------------------------------------------

test("every route file under /api/student/Profile is guarded and logs nothing", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") files.push(full);
    }
  };
  walk(path.join(root, "app", "api", "student", "Profile"));
  assert.equal(files.length, 10, "update this test when a route is added");

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    assert.match(source, /await requireTeacherOwnedStudent\(/, `${rel} calls the ownership guard`);
    assert.doesNotMatch(source, /console\.(log|info|debug)/, `${rel} logs nothing`);
    // An access refusal must keep its 401 / 404: either handleRouteError, or
    // accessErrorResponse() before the route's reportRouteError + 500.
    if (/reportRouteError\(/.test(source)) {
      const refusedAt = source.indexOf("accessErrorResponse(error)");
      assert.ok(refusedAt > 0 && refusedAt < source.indexOf("reportRouteError(error"), `${rel}: refusals answered before reporting`);
    } else {
      assert.match(source, /handleRouteError\(error/, `${rel} uses handleRouteError`);
    }
    const guardAt = source.indexOf("requireTeacherOwnedStudent(");
    const serviceAt = source.search(/await (get[A-Z]\w+|prisma\.)/);
    assert.ok(guardAt > 0 && guardAt < serviceAt, `${rel}: guard runs before any data access`);
  }

  const profile = fs.readFileSync(path.join(PROFILE, "route.ts"), "utf8");
  assert.match(profile, /select: \{/, "explicit field list");
  assert.doesNotMatch(profile, /password\s*:\s*true/, "the password field is never selected");
  assert.doesNotMatch(profile, /include\s*:/, "no include that could pull extra data");
});

// ---- Middleware (defence in depth) ---------------------------------------------------------

test("middleware rejects /api/student/Profile requests without a session", async () => {
  const { middleware, config } = require(path.join(root, "middleware.ts"));
  const { NextRequest } = require("next/server");
  assert.ok(config.matcher.includes("/api/student/Profile/:path*"));

  const response = await middleware(new NextRequest("http://localhost/api/student/Profile/student-1/payments"));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "UNAUTHORIZED");

  const other = await middleware(new NextRequest("http://localhost/api/student/next-registration-number"));
  assert.notEqual(other.status, 401, "other /api/student routes keep their own handling");
});
