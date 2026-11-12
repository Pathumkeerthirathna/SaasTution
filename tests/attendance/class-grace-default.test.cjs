/*
 * Stage 5.7b-2b-2: the class's default attendance grace period —
 * lib/class-validation.ts (createClassSchema / updateClassSchema),
 * services/class-service.ts (createClassForTeacher / updateClassForTeacher)
 * and the class routes (POST /api/classes, PUT /api/classes/[id]: same-origin
 * before authentication). Faked edges: Prisma (a recording fake with no
 * attendance models, so any access to them fails the test), the session and
 * the realtime events. No database.
 *
 *   npm run test:attendance-grace   (also part of npm run test:attendance)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
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

const APP_ORIGIN = "https://app.example.test";
process.env.APP_URL = APP_ORIGIN;

const T1 = "teacher-1";
const T2 = "teacher-2";
const C1 = "class-1";

// ---- A recording Prisma fake (classes only) -----------------------------------------------------

const state = { session: { teacherId: T1 }, sessionCalls: 0, classes: {}, calls: [] };

function classRow(id) {
  const c = state.classes[id];
  return c && { ...c };
}

const prismaFake = {
  class: {
    create: async ({ data }) => {
      state.calls.push(["class.create", data]);
      const id = `class-${Object.keys(state.classes).length + 1}`;
      state.classes[id] = { id, ...data, schedules: data.schedules?.create ?? [], status: 0 };
      return { id, name: data.name, attendanceGraceMinutes: data.attendanceGraceMinutes };
    },
    findFirst: async ({ where }) => {
      state.calls.push(["class.findFirst", where]);
      const c = state.classes[where.id];
      return c && c.teacherId === where.teacherId && c.status === where.status ? { id: c.id, monthlyFee: c.monthlyFee } : null;
    },
  },
  $transaction: async (fn) =>
    fn({
      classSchedule: { deleteMany: async () => ({ count: 0 }) },
      classFee: { count: async () => 1, updateMany: async () => ({ count: 1 }), create: async () => ({}) },
      class: {
        update: async ({ where, data }) => {
          state.calls.push(["class.update", data]);
          Object.assign(state.classes[where.id], data);
          return classRow(where.id);
        },
      },
    }),
};
// Any model other than the class fakes (attendance registers included) is a test failure.
fake("lib/prisma.ts", {
  prisma: new Proxy(prismaFake, {
    get: (target, key) => {
      if (key in target) return target[key];
      throw new Error(`unexpected Prisma access: ${String(key)}`);
    },
  }),
});
fake("lib/session-events.ts", { emitStudentDataChange: () => {}, emitLiveChange: () => {} });
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    state.sessionCalls += 1;
    if (!state.session) throw new AppError("Authentication required.", 401, "UNAUTHORIZED");
    return { teacherId: state.session.teacherId, role: "TEACHER" };
  },
  requireStudentSession: async () => { throw new Error("not used"); },
  requireAppSession: async () => { throw new Error("not used"); },
  requireAdminSession: async () => { throw new Error("not used"); },
  getOptionalSession: async () => null,
});

const { createClassSchema, updateClassSchema } = require(path.join(root, "lib", "class-validation.ts"));
const classService = require(path.join(root, "services", "class-service.ts"));
const createRoute = require(path.join(root, "app", "api", "classes", "route.ts"));
const updateRoute = require(path.join(root, "app", "api", "classes", "[id]", "route.ts"));

function reset() {
  state.session = { teacherId: T1 };
  state.sessionCalls = 0;
  state.calls = [];
  state.classes = { [C1]: { id: C1, teacherId: T1, status: 0, name: "Physics", monthlyFee: 1000, paymentDueWeek: 1, attendanceGraceMinutes: 10 } };
}

const BASE = {
  name: "Physics",
  monthlyFee: 1500,
  paymentDueWeek: 1,
  schedules: [{ dayOfWeek: "MONDAY", startTime: "08:00", endTime: "10:00" }],
};

// ======================================================================================
// Validation
// ======================================================================================

test("create schema: omitted grace stays omitted (the service then uses 10); 0 and 240 accepted", () => {
  const omitted = createClassSchema.safeParse(BASE);
  assert.equal(omitted.success, true);
  assert.equal(omitted.data.attendanceGraceMinutes, undefined);
  for (const value of [0, 240, 15]) {
    const parsed = createClassSchema.safeParse({ ...BASE, attendanceGraceMinutes: value });
    assert.equal(parsed.success, true, String(value));
    assert.equal(parsed.data.attendanceGraceMinutes, value);
  }
});

test("create and update schemas: negative, above 240, decimal, string, null, NaN and Infinity are refused", () => {
  for (const value of [-1, 241, 1.5, "10", null, Number.NaN, Number.POSITIVE_INFINITY, true]) {
    assert.equal(createClassSchema.safeParse({ ...BASE, attendanceGraceMinutes: value }).success, false, `create ${String(value)}`);
    assert.equal(updateClassSchema.safeParse({ attendanceGraceMinutes: value }).success, false, `update ${String(value)}`);
  }
  const issue = createClassSchema.safeParse({ ...BASE, attendanceGraceMinutes: 241 }).error.issues[0];
  assert.deepEqual(issue.path, ["attendanceGraceMinutes"]);
});

test("update schema: the grace alone is a valid update; omitted leaves it out (unchanged)", () => {
  const only = updateClassSchema.safeParse({ attendanceGraceMinutes: 20 });
  assert.equal(only.success, true);
  assert.deepEqual(only.data, { attendanceGraceMinutes: 20 });
  const other = updateClassSchema.safeParse({ name: "Chemistry" });
  assert.equal(other.success, true);
  assert.equal("attendanceGraceMinutes" in other.data, false);
  assert.equal(updateClassSchema.safeParse({}).success, false, "an empty update is still refused");
});

// ======================================================================================
// Service
// ======================================================================================

test("create: default 10 when omitted; the given value otherwise; returned in the response", async () => {
  reset();
  const omitted = await classService.createClassForTeacher(T1, { ...BASE, startDate: "2026-09-01" });
  assert.equal(state.calls.find((c) => c[0] === "class.create")[1].attendanceGraceMinutes, 10);
  assert.equal(omitted.attendanceGraceMinutes, 10);
  state.calls = [];
  const zero = await classService.createClassForTeacher(T1, { ...BASE, attendanceGraceMinutes: 0, startDate: "2026-09-01" });
  assert.equal(state.calls.find((c) => c[0] === "class.create")[1].attendanceGraceMinutes, 0, "0 is kept (not replaced by the default)");
  assert.equal(zero.attendanceGraceMinutes, 0);
});

test("update: the owner changes the default; omitted leaves it unchanged; only the Class row is written (no register)", async () => {
  reset();
  await classService.updateClassForTeacher(C1, T1, { attendanceGraceMinutes: 25 });
  assert.equal(state.classes[C1].attendanceGraceMinutes, 25);
  state.calls = [];
  await classService.updateClassForTeacher(C1, T1, { name: "Physics A" });
  const data = state.calls.find((c) => c[0] === "class.update")[1];
  assert.equal("attendanceGraceMinutes" in data, false, "omitted: not part of the update");
  assert.equal(state.classes[C1].attendanceGraceMinutes, 25);
  // The fake Prisma throws on any other model: no attendance register was read or written.
});

test("update: another teacher's class is 404 CLASS_NOT_FOUND and nothing is written", async () => {
  reset();
  await assert.rejects(classService.updateClassForTeacher(C1, T2, { attendanceGraceMinutes: 30 }), (e) => e.statusCode === 404 && e.code === "CLASS_NOT_FOUND");
  assert.equal(state.classes[C1].attendanceGraceMinutes, 10);
  assert.ok(!state.calls.some((c) => c[0] === "class.update"));
});

// ======================================================================================
// Routes
// ======================================================================================

const request = (url, method, body, headers = {}) =>
  new Request(`${APP_ORIGIN}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: APP_ORIGIN, "Sec-Fetch-Site": "same-origin", ...headers },
    body: JSON.stringify(body),
  });
const json = async (response) => ({ status: response.status, body: await response.json() });

test("routes: POST and PUT refuse a cross-origin request (403) BEFORE authentication; nothing written", async () => {
  reset();
  for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { Origin: "https://evil.example" }, { Origin: "null" }]) {
    const created = await json(await createRoute.POST(request("/api/classes", "POST", { ...BASE, attendanceGraceMinutes: 5, startDate: "2026-09-01" }, headers)));
    assert.deepEqual([created.status, created.body.error.code], [403, "CROSS_ORIGIN_REQUEST_REJECTED"]);
    const updated = await json(await updateRoute.PUT(request(`/api/classes/${C1}`, "PUT", { attendanceGraceMinutes: 5 }, headers), { params: { id: C1 } }));
    assert.deepEqual([updated.status, updated.body.error.code], [403, "CROSS_ORIGIN_REQUEST_REJECTED"]);
  }
  assert.equal(state.sessionCalls, 0, "refused before authentication");
  assert.deepEqual(state.calls, []);
});

test("routes: a same-origin owner request sets the default (POST create, PUT update); invalid values are 400", async () => {
  reset();
  const created = await json(await createRoute.POST(request("/api/classes", "POST", { ...BASE, attendanceGraceMinutes: 0, startDate: "2026-09-01" })));
  assert.equal(created.status, 201);
  assert.equal(created.body.data.class.attendanceGraceMinutes, 0);
  const updated = await json(await updateRoute.PUT(request(`/api/classes/${C1}`, "PUT", { attendanceGraceMinutes: 240 }), { params: { id: C1 } }));
  assert.equal(updated.status, 200);
  assert.equal(state.classes[C1].attendanceGraceMinutes, 240);
  for (const value of [-5, 300, 2.5, "15", null]) {
    const bad = await json(await updateRoute.PUT(request(`/api/classes/${C1}`, "PUT", { attendanceGraceMinutes: value }), { params: { id: C1 } }));
    assert.deepEqual([bad.status, bad.body.error.code], [400, "VALIDATION_ERROR"], String(value));
  }
  assert.equal(state.classes[C1].attendanceGraceMinutes, 240);
});

test("routes: the teacher comes only from the session (a teacherId in the body changes nothing); another teacher gets 404", async () => {
  reset();
  state.session = { teacherId: T2 };
  const other = await json(await updateRoute.PUT(request(`/api/classes/${C1}`, "PUT", { attendanceGraceMinutes: 30, teacherId: T1 }), { params: { id: C1 } }));
  assert.equal(other.status, 404);
  assert.equal(state.classes[C1].attendanceGraceMinutes, 10);
  state.session = null;
  assert.equal((await updateRoute.PUT(request(`/api/classes/${C1}`, "PUT", { attendanceGraceMinutes: 30 }), { params: { id: C1 } })).status, 401);
});
