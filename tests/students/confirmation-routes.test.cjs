/*
 * Approval decision routes and the import route's registrationSource check.
 *
 *   npm run test:confirmation
 *
 *  - PUT /api/students/[id]/confirm, PUT /api/students/[id]/decline and
 *    PUT /api/students/confirm-all, with the student service faked: status
 *    codes and the { success: false, error: { message, code } } shape.
 *  - POST /api/students/import with the real student service and the
 *    in-memory Prisma of tests/students/helpers/fake-prisma.cjs.
 * No database, SMTP server or log file is touched (errors go to a memory sink).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const T = "teacher-1";
const Y = new Date().getFullYear();

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

const { AppError } = require(path.join(root, "lib", "error-handler.ts"));
const serverLogger = require(path.join(root, "lib", "error-logging", "server-logger.ts"));
const errorHandler = require(path.join(root, "lib", "error-handler.ts"));

// ---- Session ----------------------------------------------------------------------

let signedIn = true;
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    if (!signedIn) throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { teacherId: T, name: "Pathum", email: "pathum@mail.com", role: "TEACHER" };
  },
});

// ---- Error log: a memory sink, console quiet ----------------------------------------

const logged = [];
const sink = {
  options: { dir: "", maxBytes: 0, maxFiles: 0 },
  write: (channel, entry) => {
    logged.push({ channel, entry });
    return Promise.resolve();
  },
  writeSync: (channel, entry) => logged.push({ channel, entry }),
  flush: () => Promise.resolve(),
  dropped: () => ({ queueFull: 0, budget: 0 }),
};
const originalConsoleError = console.error;
test.before(() => {
  serverLogger.setErrorLogSinkForTests(sink);
  console.error = () => {};
});
test.after(() => {
  serverLogger.setErrorLogSinkForTests(null);
  errorHandler.resetRouteErrorConsoleForTests();
  console.error = originalConsoleError;
});

// ---- Decision routes, with the service faked ------------------------------------------

const calls = [];
let behaviour = null; // (name, args) => value | throws
const decision = (name) => async (...args) => {
  calls.push([name, ...args]);
  return behaviour ? behaviour(name, args) : undefined;
};

// Load the import route (real service) first, then fake the service for the
// decision routes: each route module keeps the service it was loaded with.
const { createFakePrisma } = require("./helpers/fake-prisma.cjs");
const { db, prisma: fakePrisma, reset } = createFakePrisma();
fake("lib/prisma.ts", { prisma: fakePrisma });
fake("lib/mailer.ts", {
  buildPasswordResetLink: () => "",
  sendPasswordResetEmail: async () => {},
  sendEmailVerificationCodeEmail: async () => {},
  sendEmail: async () => {},
  sendStudentRegistrationEmail: async () => {},
});
fake("services/class-student-fee-service.ts", { ensureCurrentMonthFeeForClassStudent: async () => {} });
const importRoute = require(path.join(root, "app", "api", "students", "import", "route.ts"));

const realServicePath = path.join(root, "services", "student-service.ts");
delete require.cache[realServicePath];
fake("services/student-service.ts", {
  confirmStudent: decision("confirmStudent"),
  declineStudent: decision("declineStudent"),
  confirmAllPendingStudents: decision("confirmAllPendingStudents"),
});
const confirmRoute = require(path.join(root, "app", "api", "students", "[id]", "confirm", "route.ts"));
const declineRoute = require(path.join(root, "app", "api", "students", "[id]", "decline", "route.ts"));
const confirmAllRoute = require(path.join(root, "app", "api", "students", "confirm-all", "route.ts"));

const put = (url) => new Request(`http://localhost${url}`, { method: "PUT" });

async function call(route, id) {
  const response =
    route === "confirm-all"
      ? await confirmAllRoute.PUT(put("/api/students/confirm-all"))
      : await (route === "confirm" ? confirmRoute : declineRoute).PUT(put(`/api/students/${id}/${route}`), {
          params: { id },
        });
  return { status: response.status, body: await response.json() };
}

function resetCalls() {
  calls.length = 0;
  logged.length = 0;
  behaviour = null;
  signedIn = true;
}

test("success bodies are unchanged; the decline message is corrected", async () => {
  resetCalls();
  assert.deepEqual(await call("confirm", "s1"), {
    status: 200,
    body: { success: true, message: "Student confirmed successfully." },
  });
  assert.deepEqual(await call("decline", "s1"), {
    status: 200,
    body: { success: true, message: "Student declined successfully." },
  });
  behaviour = () => 3;
  assert.deepEqual(await call("confirm-all"), {
    status: 200,
    body: { success: true, count: 3, message: "3 student(s) confirmed successfully." },
  });
  assert.deepEqual(calls, [
    ["confirmStudent", T, "s1"],
    ["declineStudent", T, "s1"],
    ["confirmAllPendingStudents", T],
  ]);
});

test("not signed in: 401 UNAUTHORIZED, the service is never called", async () => {
  resetCalls();
  signedIn = false;
  for (const route of ["confirm", "decline", "confirm-all"]) {
    const { status, body } = await call(route, "s1");
    assert.equal(status, 401, route);
    assert.deepEqual(body, { success: false, error: { message: "Session is invalid or expired.", code: "UNAUTHORIZED" } });
  }
  assert.deepEqual(calls, []);
});

test("service AppErrors keep their status and code: 404 / 409 (already approved, already rejected, busy)", async () => {
  const cases = [
    ["confirm", new AppError("Student not found.", 404, "STUDENT_NOT_FOUND")],
    ["decline", new AppError("Student not found.", 404, "STUDENT_NOT_FOUND")],
    ["confirm", new AppError("This student is already confirmed.", 409, "STUDENT_ALREADY_APPROVED")],
    ["decline", new AppError("This student is already declined.", 409, "STUDENT_ALREADY_REJECTED")],
    ["confirm", new AppError("Another change to this student is in progress. Please try again.", 409, "STUDENT_DECISION_BUSY")],
    ["decline", new AppError("Another change to this student is in progress. Please try again.", 409, "STUDENT_DECISION_BUSY")],
    ["confirm-all", new AppError("Another change to this student is in progress. Please try again.", 409, "STUDENT_DECISION_BUSY")],
  ];
  for (const [route, error] of cases) {
    resetCalls();
    behaviour = () => {
      throw error;
    };
    const { status, body } = await call(route, "s1");
    assert.equal(status, error.statusCode, `${route} ${error.code}`);
    assert.deepEqual(body, { success: false, error: { message: error.message, code: error.code } });
    assert.deepEqual(logged, [], "expected errors are not logged as unexpected");
  }
});

test("unexpected errors: 500 INTERNAL_SERVER_ERROR (never 400), logged, raw message hidden in production", async () => {
  for (const route of ["confirm", "decline", "confirm-all"]) {
    resetCalls();
    behaviour = () => {
      throw new Error('relation "Student" does not exist at 10.0.0.5');
    };
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let result;
    try {
      result = await call(route, "s1");
    } finally {
      process.env.NODE_ENV = previous;
    }
    assert.equal(result.status, 500, route);
    assert.equal(result.body.success, false);
    assert.equal(result.body.error.code, "INTERNAL_SERVER_ERROR");
    assert.doesNotMatch(result.body.error.message, /10\.0\.0\.5|relation/);
    assert.equal(logged.length, 1, "logged once");
  }
});

// ---- Import: registrationSource ------------------------------------------------------

function setupImport() {
  reset({
    teacher: [{ id: T, name: "Pathum", email: "pathum@mail.com" }],
    guardian: [],
    grade: [{ id: 6 }],
    student: [],
  });
}

let rowSeq = 0;
const importRow = () => {
  rowSeq += 1;
  return {
    studentName: `Imported Student ${rowSeq}`,
    gradeId: 6,
    primaryContact: "0771234567",
    email: `import${rowSeq}@mail.com`,
    registrationNumber: `PAT-${Y}-${String(700 + rowSeq).padStart(3, "0")}`,
  };
};

async function runImport(body) {
  const request = new Request("http://localhost/api/students/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await importRoute.POST(request);
  return { status: response.status, body: await response.json() };
}

test("import rejects PUBLIC_CLASS, ADMIN and invalid sources with 400 VALIDATION_ERROR; nothing is created", async () => {
  for (const registrationSource of ["PUBLIC_CLASS", "ADMIN", "public_class", "import", "", "SOMETHING", 5, true, {}, []]) {
    setupImport();
    const { status, body } = await runImport({ registrationSource, students: [importRow()] });
    assert.equal(status, 400, JSON.stringify(registrationSource));
    assert.equal(body.success, false);
    assert.deepEqual(body.error, { message: "Invalid registration source.", code: "VALIDATION_ERROR" });
    assert.deepEqual(body.errors, [{ row: 0, field: "registrationSource", message: "Invalid registration source." }]);
    assert.equal(db.student.length, 0);
  }
});

test("import accepts IMPORT and TEACHER as before; missing (or null) keeps the schema default; no decision is invented", async () => {
  for (const [registrationSource, stored] of [
    ["IMPORT", "IMPORT"],
    ["TEACHER", "TEACHER"],
    [undefined, undefined],
    [null, undefined],
  ]) {
    setupImport();
    const payload = { students: [importRow()] };
    if (registrationSource !== undefined) payload.registrationSource = registrationSource;
    const { status, body } = await runImport(payload);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.count, 1);
    const [created] = db.student;
    assert.equal(created.registrationSource, stored, `${registrationSource} → ${stored} (undefined = database default TEACHER)`);
    assert.equal(created.confirmationStatus, "APPROVED");
    assert.equal(created.confirmedById ?? null, null, "created approved: no teacher decision");
    assert.equal(created.confirmedAt ?? null, null);
    assert.equal(created.approvedAt ?? null, null);
  }
});
