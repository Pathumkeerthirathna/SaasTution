/*
 * Student Profile SP-2: GET /api/students/me/profile, in-process with the
 * real route, service and error handler; faked edges: the session
 * (lib/auth-session.ts, mirroring its 401 rules) and a one-model Prisma that
 * records every select. No database.
 *
 *   npm run test:students
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const { AppError } = require(path.join(root, "lib", "error-handler.ts"));

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

const APP_ORIGIN = "http://localhost:3000";
process.env.APP_URL = APP_ORIGIN;
const state = { session: null, students: new Map(), selects: [], wheres: [], updates: [], sessionCalls: 0 };
const unauthorized = () => new AppError("Authentication required.", 401, "UNAUTHORIZED");

fake("lib/auth-session.ts", {
  requireStudentSession: async () => {
    state.sessionCalls += 1;
    if (!state.session) throw unauthorized();
    if (state.session.role !== "STUDENT") throw new AppError("Session is invalid or expired.", 401, "UNAUTHORIZED");
    return { studentId: state.session.userId, email: "session@example.test", name: "Session Name", role: "STUDENT" };
  },
  requireTeacherSession: async () => {
    throw new Error("not used");
  },
  requireAppSession: async () => {
    throw new Error("not used");
  },
  getOptionalSession: async () => null,
  requireAdminSession: async () => {
    throw new Error("not used");
  },
});

const forbidden = () => {
  throw new Error("write attempted");
};
fake("lib/prisma.ts", {
  prisma: {
    student: {
      findUnique: async ({ where, select }) => {
        state.wheres.push(where);
        state.selects.push(select);
        const row = state.students.get(where.id);
        if (!row) return null;
        const out = {};
        for (const [key, on] of Object.entries(select)) if (on) out[key] = row[key];
        return out;
      },
      update: forbidden,
      // SP-3: the only write the profile route may make.
      updateMany: async ({ where, data }) => {
        state.updates.push({ where, data });
        if (state.missNextUpdate) {
          // Simulates the account changing between the conditional write and the re-read.
          state.missNextUpdate = false;
          return { count: 0 };
        }
        const row = state.students.get(where.id);
        if (!row || (where.status !== undefined && row.status !== where.status)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      create: forbidden,
      delete: forbidden,
    },
  },
});

const route = require(path.join(root, "app", "api", "students", "me", "profile", "route.ts"));
const service = require(path.join(root, "services", "student-profile-service.ts"));

const SECRET_HASH = "$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012";

function student(id, patch = {}) {
  state.students.set(id, {
    id,
    name: `Name ${id}`,
    registrationNumber: `REG-${id}`,
    email: `${id}@example.test`,
    emailConfirmed: true,
    contact01: "0771234567",
    contact: "0112345678",
    contact02: "0719999999",
    registeredAt: new Date("2026-07-25T09:02:27.773Z"),
    status: 0,
    password: SECRET_HASH,
    teacherId: "teacher-secret-1",
    confirmationStatus: "APPROVED",
    confirmedAt: new Date("2026-07-25T09:02:27.773Z"),
    confirmedById: "teacher-secret-1",
    approvedAt: new Date("2026-07-25T09:22:31.169Z"),
    emailConfirmedAt: new Date("2026-07-25T10:00:00.000Z"),
    gradeId: 9,
    publicClassId: "public-class-1",
    ...patch,
  });
}

function reset() {
  state.session = null;
  state.students = new Map();
  state.selects = [];
  state.wheres = [];
  state.updates = [];
  state.sessionCalls = 0;
  state.missNextUpdate = false;
}

const get = (url = "/api/students/me/profile", headers = {}) => route.GET(new Request(`http://localhost:3000${url}`, { headers }));
const json = async (response) => ({ status: response.status, body: await response.json(), response });

function assertNoStore(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("vary"), "Cookie");
}

const KEYS = ["email", "emailVerified", "name", "phone", "registeredOn", "registrationNumber"];

test("an authenticated student gets exactly their own profile; no-store", async () => {
  reset();
  student("s1");
  student("s2", { name: "Other Student" });
  state.session = { role: "STUDENT", userId: "s1" };
  const { status, body, response } = await json(await get());
  assert.equal(status, 200, JSON.stringify(body));
  assertNoStore(response);
  assert.equal(body.success, true);
  assert.deepEqual(body.data, {
    name: "Name s1",
    registrationNumber: "REG-s1",
    email: "s1@example.test",
    emailVerified: true,
    phone: "0771234567",
    registeredOn: "2026-07-25",
  });
  assert.deepEqual(Object.keys(body.data).sort(), KEYS);
  assert.deepEqual(state.wheres, [{ id: "s1" }], "read by the session's student id");
});

test("only the needed columns are read; no secret, teacher id or internal field appears in the response", async () => {
  reset();
  student("s1");
  state.session = { role: "STUDENT", userId: "s1" };
  const response = await get();
  const text = await response.text();
  assert.deepEqual(Object.keys(state.selects[0]).sort(), ["contact01", "email", "emailConfirmed", "name", "registeredAt", "registrationNumber", "status"]);
  for (const secret of [SECRET_HASH, "password", "teacher-secret-1", "teacherId", "confirmationStatus", "confirmedAt", "approvedAt", "confirmedById", "public-class-1", "0112345678", "0719999999", "09:02", "status"]) {
    assert.ok(!text.includes(secret), `never exposed: ${secret}`);
  }
});

test("a student id cannot be supplied: query, header or path-like input is ignored (always the session's student)", async () => {
  reset();
  student("s1");
  student("s2", { name: "Other Student", email: "other@example.test" });
  state.session = { role: "STUDENT", userId: "s1" };
  for (const url of ["/api/students/me/profile?studentId=s2", "/api/students/me/profile?id=s2&StudentId=s2"]) {
    const { body } = await json(await get(url, { "x-student-id": "s2" }));
    assert.equal(body.data.name, "Name s1", url);
    assert.ok(!JSON.stringify(body).includes("other@example.test"));
  }
  assert.ok(state.wheres.every((w) => w.id === "s1"));
  const code = fs.readFileSync(path.join(root, "app", "api", "students", "me", "profile", "route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // GET reads nothing at all from the request; PATCH (SP-3) reads only Content-Length and the JSON body
  // (contact01 only, strict schema; covered by the PATCH tests below), never a student id.
  const getHandler = code.slice(code.indexOf("export async function GET"), code.indexOf("// ---- PATCH"));
  assert.ok(getHandler.includes("requireStudentSession"));
  assert.doesNotMatch(getHandler, /searchParams|nextUrl|request\.json|request\.text|request\.headers|params/, "GET reads nothing identifying from the request");
  assert.doesNotMatch(code, /searchParams|nextUrl|params|studentId\s*[:=]\s*(?!session)/, "no student id is taken from the request");
  assert.deepEqual(code.match(/request\.headers\.get\("[^"]+"\)/g), ['request.headers.get("content-length")'], "the only header read is Content-Length");
});

test("unauthenticated, teacher and admin sessions are 401 (no read)", async () => {
  reset();
  student("s1");
  for (const session of [null, { role: "TEACHER", userId: "s1" }, { role: "ADMIN", userId: "s1" }]) {
    state.session = session;
    const { status, body, response } = await json(await get());
    assert.equal(status, 401);
    assert.equal(body.error.code, "UNAUTHORIZED");
    assertNoStore(response);
  }
  assert.equal(state.wheres.length, 0);
});

test("inactive is 403 STUDENT_ACCOUNT_INACTIVE; deleted, unknown or odd statuses are 404 STUDENT_NOT_FOUND; nothing leaks", async () => {
  reset();
  student("inactive", { status: 1 });
  student("deleted", { status: 2 });
  student("odd", { status: 7 });
  const cases = [
    ["inactive", 403, "STUDENT_ACCOUNT_INACTIVE"],
    ["deleted", 404, "STUDENT_NOT_FOUND"],
    ["odd", 404, "STUDENT_NOT_FOUND"],
    ["missing", 404, "STUDENT_NOT_FOUND"],
  ];
  for (const [id, status, code] of cases) {
    state.session = { role: "STUDENT", userId: id };
    const { status: actual, body, response } = await json(await get());
    assert.deepEqual([actual, body.success, body.error.code], [status, false, code], id);
    assert.equal(body.data, undefined);
    assert.ok(!JSON.stringify(body).includes(`Name ${id}`), "no profile data");
    assertNoStore(response);
  }
});

test("blank optional fields become null; an unconfirmed email is reported; the registration date is a calendar date", async () => {
  reset();
  student("s1", { email: "  ", emailConfirmed: false, contact01: null, registrationNumber: "", registeredAt: new Date("2026-07-25T23:30:00.000Z") });
  state.session = { role: "STUDENT", userId: "s1" };
  const { body } = await json(await get());
  assert.deepEqual(body.data, { name: "Name s1", registrationNumber: null, email: null, emailVerified: false, phone: null, registeredOn: "2026-07-25" });
  assert.equal(service.registeredOnOf(new Date("2026-01-02T03:04:05.000Z")), "2026-01-02");
  assert.equal(service.registeredOnOf(new Date("x")), null);
  assert.equal(service.registeredOnOf(null), null);
});

// ======================================================================================
// SP-3: PATCH /api/students/me/profile (the student's own phone number)
// ======================================================================================

const validation = require(path.join(root, "lib", "student-profile-validation.ts"));
const authValidation = require(path.join(root, "lib", "auth-validation.ts"));

const SAME_ORIGIN = { Origin: APP_ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
const patch = (body, { headers = {}, url = "/api/students/me/profile", origin = true } = {}) =>
  route.PATCH(
    new Request(`${APP_ORIGIN}${url}`, {
      method: "PATCH",
      headers: { ...(origin ? SAME_ORIGIN : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    })
  );

async function refused(promise, status, code, field) {
  const before = JSON.stringify([...state.students.values()]);
  const { status: actual, body, response } = await json(await promise);
  assert.deepEqual([actual, body.success, body.error.code], [status, false, code], JSON.stringify(body));
  if (field !== undefined) assert.deepEqual(body.error.details, { field });
  assertNoStore(response);
  assert.equal(JSON.stringify([...state.students.values()]), before, "nothing written");
  return body;
}

let patchSeq = 0;
/** A fresh active student (the rate limiter is per student and in memory). */
function freshStudent(patchFields = {}) {
  const id = `patch-${++patchSeq}`;
  student(id, patchFields);
  state.session = { role: "STUDENT", userId: id };
  return id;
}

test("PATCH: the student updates their own phone; only contact01 is written (conditioned on an active account); the profile answers as GET", async () => {
  reset();
  const id = freshStudent();
  student("someone-else");
  const before = { ...state.students.get(id) };
  const { status, body, response } = await json(await patch({ contact01: "  +94 77 123-4567 " }));
  assert.equal(status, 200, JSON.stringify(body));
  assertNoStore(response);
  assert.equal(body.message, "Your phone number was updated.");
  assert.deepEqual(body.data, { name: `Name ${id}`, registrationNumber: `REG-${id}`, email: `${id}@example.test`, emailVerified: true, phone: "+94 77 123-4567", registeredOn: "2026-07-25" });
  assert.deepEqual(Object.keys(body.data).sort(), KEYS);
  assert.deepEqual(state.updates, [{ where: { id, status: 0 }, data: { contact01: "+94 77 123-4567" } }], "exactly one write: contact01 only, trimmed");
  const after = state.students.get(id);
  for (const key of Object.keys(before)) if (key !== "contact01") assert.deepEqual(after[key], before[key], `${key} unchanged`);
  assert.equal(state.students.get("someone-else").contact01, "0771234567", "no other student touched");
});

test("PATCH: unauthenticated, teacher and admin sessions are 401 with nothing written", async () => {
  reset();
  student("s1");
  for (const session of [null, { role: "TEACHER", userId: "s1" }, { role: "ADMIN", userId: "s1" }]) {
    state.session = session;
    await refused(patch({ contact01: "0771112223" }), 401, "UNAUTHORIZED");
  }
  assert.equal(state.updates.length, 0);
});

test("PATCH: another student's id can't be supplied (body field refused; query and header ignored: the session's student is updated)", async () => {
  reset();
  const id = freshStudent();
  student("victim");
  for (const body of [{ contact01: "0771112223", studentId: "victim" }, { contact01: "0771112223", id: "victim" }]) {
    await refused(patch(body), 400, "VALIDATION_ERROR", "body");
  }
  const { status } = await json(await patch({ contact01: "0779998887" }, { url: "/api/students/me/profile?studentId=victim", headers: { "x-student-id": "victim" } }));
  assert.equal(status, 200);
  assert.equal(state.students.get("victim").contact01, "0771234567", "the other student is untouched");
  assert.equal(state.students.get(id).contact01, "0779998887");
  assert.ok(state.updates.every((u) => u.where.id === id));
});

test("PATCH: name, email, registrationNumber, teacherId (or any extra field) are refused; nothing written", async () => {
  reset();
  freshStudent();
  for (const extra of [{ name: "New Name" }, { email: "x@example.test" }, { registrationNumber: "REG-X" }, { teacherId: "t-2" }, { status: 0 }, { contact02: "0770000000" }, { password: "secret123" }]) {
    const body = await refused(patch({ contact01: "0771112223", ...extra }), 400, "VALIDATION_ERROR", "body");
    assert.equal(body.error.message, "Only your phone number can be changed here.");
  }
  for (const only of [{ name: "New Name" }, { email: "x@example.test" }]) await refused(patch(only), 400, "VALIDATION_ERROR");
  assert.equal(state.updates.length, 0);
});

test("PATCH: invalid phone numbers are 400 (field contact01) with the project's phone messages; nothing written", async () => {
  reset();
  freshStudent();
  const cases = [
    ["12345678", "Please enter a valid phone number."],
    ["077-ABC-4567", "Phone number can only contain digits, spaces, + and -."],
    ["0771234567<script>", "Phone number can only contain digits, spaces, + and -."],
    ["1".repeat(21), "Phone number is too long."],
    [771234567, "Enter a phone number."],
    [null, "Enter a phone number."],
    [["0771234567"], "Enter a phone number."],
  ];
  for (const [value, message] of cases) {
    const body = await refused(patch({ contact01: value }), 400, "VALIDATION_ERROR", "contact01");
    assert.equal(body.error.message, message, JSON.stringify(value));
  }
  assert.equal(state.updates.length, 0);
});

test("PATCH: an empty phone number is not allowed (the number can be replaced, never removed)", async () => {
  reset();
  freshStudent();
  for (const value of ["", "   "]) {
    const body = await refused(patch({ contact01: value }), 400, "VALIDATION_ERROR", "contact01");
    assert.equal(body.error.message, "Enter a phone number.");
  }
  await refused(patch({}), 400, "VALIDATION_ERROR", "contact01");
  assert.equal(state.updates.length, 0);
});

test("PATCH: inactive is 403 and deleted / unknown 404, nothing written (the write itself requires an active account)", async () => {
  reset();
  for (const [patchFields, status, code] of [[{ status: 1 }, 403, "STUDENT_ACCOUNT_INACTIVE"], [{ status: 2 }, 404, "STUDENT_NOT_FOUND"]]) {
    freshStudent(patchFields);
    await refused(patch({ contact01: "0771112223" }), status, code);
  }
  state.session = { role: "STUDENT", userId: "nobody" };
  await refused(patch({ contact01: "0771112223" }), 404, "STUDENT_NOT_FOUND");
  assert.ok(state.updates.every((u) => u.where.status === 0), "every attempted write is conditioned on an active account");
});

test("PATCH: same-origin is checked first (403 before the session or body); malformed and oversized bodies are refused", async () => {
  reset();
  freshStudent();
  const calls = state.sessionCalls;
  for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { Origin: "https://evil.example" }, { Origin: "null" }]) {
    const body = await refused(patch({ contact01: "0771112223" }, { origin: false, headers: { ...headers, "Content-Type": "application/json" } }), 403, "CROSS_ORIGIN_REQUEST_REJECTED");
    assert.equal(body.error.message, "This request must come from the application itself.");
  }
  await refused(patch({ contact01: "0771112223" }, { origin: false, headers: { "Content-Type": "application/json" } }), 403, "CROSS_ORIGIN_REQUEST_REJECTED");
  assert.equal(state.sessionCalls, calls, "refused before the session is read");

  await refused(patch("{not json"), 400, "INVALID_JSON");
  await refused(patch(undefined), 400, "INVALID_JSON");
  await refused(patch("[]"), 400, "VALIDATION_ERROR");
  await refused(patch(JSON.stringify({ contact01: "0771112223", pad: "x".repeat(2000) })), 413, "REQUEST_TOO_LARGE");
  await refused(patch({ contact01: "0771112223" }, { headers: { "Content-Length": "99999" } }), 413, "REQUEST_TOO_LARGE");
  assert.equal(state.updates.length, 0);
});

test("PATCH: rate limited per student (10 per 10 minutes; 429 PROFILE_UPDATE_RATE_LIMITED + Retry-After); other students unaffected", async () => {
  reset();
  assert.deepEqual({ ...validation.PROFILE_UPDATE_RATE_LIMIT }, { perStudent: 10, global: 600, windowMs: 600_000 });
  const id = freshStudent();
  for (let i = 0; i < 10; i += 1) {
    const { status } = await json(await patch({ contact01: `077123456${i}` }));
    assert.equal(status, 200, `update ${i + 1}`);
  }
  const limited = await patch({ contact01: "0771234560" });
  const body = await limited.json();
  assert.deepEqual([limited.status, body.error.code], [429, "PROFILE_UPDATE_RATE_LIMITED"]);
  assert.equal(limited.headers.get("retry-after"), "600");
  assertNoStore(limited);
  assert.equal(state.students.get(id).contact01, "0771234569", "the refused update wrote nothing");
  freshStudent();
  assert.equal((await patch({ contact01: "0771112223" })).status, 200, "another student has their own budget");
});

test("validation: the student phone rule matches the project's registration phone rule", () => {
  const samples = ["0771234567", "+94 77 123 4567", "077-123-4567", "12345678", "123456789", "1".repeat(20), "1".repeat(21), "077 ABC 4567", "", "  0771234567  ", "+-  -+ 123"];
  for (const value of samples) {
    const mine = validation.studentPhoneSchema.safeParse(value);
    const theirs = authValidation.registerSchema.shape.contact.safeParse(value);
    assert.equal(mine.success, theirs.success, JSON.stringify(value));
    if (mine.success && theirs.success) assert.equal(mine.data, theirs.data);
  }
  assert.equal(validation.PROFILE_UPDATE_MAX_BODY_BYTES, 1024);
  const strict = validation.studentProfileUpdateSchema.safeParse({ contact01: "0771234567", name: "x" });
  assert.equal(strict.success, false);
});

test("PATCH: a write that matched nothing is never reported as saved (409 PROFILE_UPDATE_CONFLICT if the account looks active again)", async () => {
  reset();
  const id = freshStudent();
  state.missNextUpdate = true;
  const body = await refused(patch({ contact01: "0771112223" }), 409, "PROFILE_UPDATE_CONFLICT");
  assert.equal(body.error.message, "Your profile could not be updated. Please try again.");
  assert.equal(state.students.get(id).contact01, "0771234567");
});
