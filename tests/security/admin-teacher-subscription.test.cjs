/*
 * GET / PUT /api/admin/teachers/[teacherId]/subscription
 * (app/api/admin/teachers/[teacherId]/subscription/route.ts,
 * services/admin-teacher-subscription-service.ts): administrators view and
 * assign a teacher's subscription plan.
 *
 *   npm run test:security
 *
 * The real route and the real session check (lib/auth-session.ts) with real
 * signed tokens (throwaway JWT_SECRET). Faked: the cookie reader
 * (next/headers) and the database, an in-memory model whose $transaction
 * restores every table when the callback fails, and whose $queryRaw answers
 * the teacher row lock. Writes outside the transaction fail the test.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

process.env.JWT_SECRET = "admin-teacher-subscription-test-secret-0123456789";

const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const { Prisma } = require("@prisma/client");

function fakeModule(filename, exports) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

/* ---------- Faked edges ---------- */

const cookieJar = new Map();
fakeModule(require.resolve("next/headers", { paths: [root] }), {
  cookies: () => ({ get: (name) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined) }),
  headers: () => new Headers(),
});

const db = {
  teachers: new Map(),
  plans: new Map(),
  subscriptions: [],
  lockQueries: [],
  outsideWrites: [],
  failOn: null, // "update" | "create": that write throws (after any earlier work in the transaction)
  reads: 0,
  nextId: 1,
};

const withPlan = (row) => ({ ...row, plan: { ...db.plans.get(row.planId) } });
const latestFor = (teacherId) =>
  db.subscriptions.filter((row) => row.teacherId === teacherId).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;

const tx = {
  $queryRaw: async (strings, ...values) => {
    db.lockQueries.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
    return db.teachers.has(values[0]) ? [{ id: values[0] }] : [];
  },
  subscriptionPlan: {
    findUnique: async ({ where }) => (db.plans.has(where.id) ? { ...db.plans.get(where.id) } : null),
  },
  teacherSubscription: {
    findFirst: async ({ where }) => {
      const row = latestFor(where.teacherId);
      return row ? withPlan(row) : null;
    },
    update: async ({ where, data }) => {
      if (db.failOn === "update") throw new Error("simulated database failure (update)");
      const row = db.subscriptions.find((candidate) => candidate.id === where.id);
      Object.assign(row, data, { updatedAt: new Date(row.updatedAt.getTime() + 1000) });
      return withPlan(row);
    },
    create: async ({ data }) => {
      if (db.failOn === "create") throw new Error("simulated database failure (create)");
      const now = new Date();
      // Prisma defaults for the columns the service does not set.
      const row = { id: `sub-${db.nextId++}`, endDate: null, autoRenew: true, status: "ACTIVE", currency: "LKR", createdAt: now, updatedAt: now, ...data };
      db.subscriptions.push(row);
      return withPlan(row);
    },
  },
};

const prisma = {
  $transaction: async (fn) => {
    const snapshot = db.subscriptions.map((row) => ({ ...row }));
    try {
      return await fn(tx);
    } catch (error) {
      db.subscriptions = snapshot;
      throw error;
    }
  },
  teacher: {
    findUnique: async ({ where }) => {
      db.reads += 1;
      const teacher = db.teachers.get(where.id);
      return teacher ? { id: where.id, name: teacher.name, email: teacher.email } : null;
    },
  },
  teacherSubscription: {
    findFirst: async ({ where }) => {
      db.reads += 1;
      const row = latestFor(where.teacherId);
      return row ? withPlan(row) : null;
    },
    update: async () => {
      db.outsideWrites.push("teacherSubscription.update");
      throw new Error("write outside the transaction");
    },
    create: async () => {
      db.outsideWrites.push("teacherSubscription.create");
      throw new Error("write outside the transaction");
    },
  },
  subscriptionPlan: {
    findMany: async () => {
      db.reads += 1;
      return [...db.plans.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt).map((plan) => ({ ...plan }));
    },
  },
};
fakeModule(path.join(root, "lib", "prisma.ts"), { prisma });

const serverLogger = require(path.join(root, "lib", "error-logging", "server-logger.ts"));
serverLogger.setErrorLogSinkForTests({ write: async () => {}, writeSync: () => {}, flush: async () => {} });

const { GET, PUT } = require(path.join(root, "app", "api", "admin", "teachers", "[teacherId]", "subscription", "route.ts"));
const { signAuthToken, AUTH_COOKIE_NAME } = require(path.join(root, "lib", "auth.ts"));

/* ---------- Fixtures ---------- */

const T_NEW = "11111111-1111-4111-8111-111111111111"; // no subscription
const T_SUB = "22222222-2222-4222-8222-222222222222"; // has a subscription
const T_MISSING = "33333333-3333-4333-8333-333333333333"; // no such teacher
const P_STARTER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P_GROWTH = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const P_CUSTOM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // INACTIVE
const P_UNKNOWN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const plan = (id, name, price, sortOrder, status = "ACTIVE", currency = "LKR") => ({
  id,
  name,
  description: null,
  price: new Prisma.Decimal(price),
  currency,
  interval: "MONTHLY",
  maxLiveParticipants: 100,
  unlimitedLiveSessions: true,
  unlimitedRecording: true,
  unlimitedStudents: true,
  maxTeachers: null,
  storageGB: null,
  status,
  sortOrder,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
});

const START = new Date("2026-09-01T00:00:00Z");
const END = new Date("2026-12-01T00:00:00Z");

function reset() {
  db.teachers = new Map([
    [T_NEW, { name: "New Teacher", email: "new@example.test" }],
    [T_SUB, { name: "Subscribed Teacher", email: "sub@example.test" }],
  ]);
  db.plans = new Map([
    [P_STARTER, plan(P_STARTER, "Starter", 5500, 1)],
    [P_GROWTH, plan(P_GROWTH, "Growth", 8500, 2)],
    [P_CUSTOM, plan(P_CUSTOM, "Institution (custom)", 40000, 3, "INACTIVE")],
  ]);
  // T_SUB: on Starter at an OLD price, cancelled, with an end date and auto-renew off.
  db.subscriptions = [
    {
      id: "sub-existing",
      teacherId: T_SUB,
      planId: P_STARTER,
      status: "CANCELLED",
      startDate: START,
      endDate: END,
      price: new Prisma.Decimal(5000),
      currency: "LKR",
      autoRenew: false,
      createdAt: START,
      updatedAt: START,
    },
  ];
  db.lockQueries = [];
  db.outsideWrites = [];
  db.failOn = null;
  db.reads = 0;
  cookieJar.clear();
}

async function signIn(role) {
  const claims =
    role === "STUDENT"
      ? { sub: "s1", email: "s@example.test", name: "S", role, sessionVersion: 0 }
      : { sub: role === "ADMIN" ? "admin-1" : "t1", email: role === "ADMIN" ? "admin@example.test" : "t@example.test", name: "U", role };
  cookieJar.set(AUTH_COOKIE_NAME, await signAuthToken(claims));
}

const url = (teacherId) => `https://app.example.test/api/admin/teachers/${teacherId}/subscription`;
const get = (teacherId) => GET(new Request(url(teacherId)), { params: { teacherId } });
const put = (teacherId, body) =>
  PUT(
    new Request(url(teacherId), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: { teacherId } }
  );

async function ok(response) {
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.success, true);
  return payload;
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const payload = await response.json();
  assert.equal(payload.success, false);
  if (code) assert.equal(payload.error.code, code);
  return payload;
}

const snapshot = () => db.subscriptions.map((row) => ({ ...row, price: row.price.toString() }));

let infoLines = [];
const originalInfo = console.info;
test.beforeEach(() => {
  reset();
  infoLines = [];
  console.info = (...args) => infoLines.push(args.join(" "));
});
test.afterEach(() => {
  console.info = originalInfo;
});

/* ---------- GET ---------- */

test("GET: the current subscription and every plan (ACTIVE and INACTIVE), in catalogue order", async () => {
  await signIn("ADMIN");
  const { data } = await ok(await get(T_SUB));

  assert.deepEqual(data.teacher, { id: T_SUB, name: "Subscribed Teacher", email: "sub@example.test" });
  assert.equal(data.subscription.planId, P_STARTER);
  assert.equal(data.subscription.planName, "Starter");
  assert.equal(data.subscription.price, 5000);
  assert.equal(data.subscription.status, "CANCELLED");
  assert.equal(data.subscription.autoRenew, false);
  assert.equal(data.subscription.endDate, END.toISOString());
  assert.deepEqual(data.plans.map((p) => [p.name, p.status, p.price]), [
    ["Starter", "ACTIVE", 5500],
    ["Growth", "ACTIVE", 8500],
    ["Institution (custom)", "INACTIVE", 40000],
  ]);
});

test("GET: a teacher without a subscription gets subscription null", async () => {
  await signIn("ADMIN");
  const { data } = await ok(await get(T_NEW));
  assert.equal(data.subscription, null);
  assert.equal(data.plans.length, 3);
});

/* ---------- Assign / change ---------- */

test("admin assigns a plan to a teacher with no subscription: ACTIVE, plan price, starts now, no end date", async () => {
  await signIn("ADMIN");
  const before = Date.now();
  const payload = await ok(await put(T_NEW, { planId: P_GROWTH }));

  assert.equal(payload.data.changed, true);
  assert.equal(payload.message, "The subscription plan was updated.");
  assert.doesNotMatch(payload.message, /paid|payment/i);
  assert.equal(payload.data.subscription.planName, "Growth");

  const row = db.subscriptions.find((candidate) => candidate.teacherId === T_NEW);
  assert.equal(row.planId, P_GROWTH);
  assert.equal(row.status, "ACTIVE");
  assert.equal(row.price.toString(), "8500");
  assert.equal(row.currency, "LKR");
  assert.equal(row.endDate, null);
  assert.equal(row.autoRenew, true, "the schema default");
  assert.ok(row.startDate.getTime() >= before && row.startDate.getTime() <= Date.now());
  assert.equal(db.subscriptions.length, 2);
});

test("admin changes an existing plan: plan and price from the plan, ACTIVE; start, end and auto-renew preserved", async () => {
  await signIn("ADMIN");
  const payload = await ok(await put(T_SUB, { planId: P_GROWTH }));

  assert.equal(payload.data.changed, true);
  assert.equal(db.subscriptions.length, 1, "updated in place, no new row");
  const [row] = db.subscriptions;
  assert.equal(row.id, "sub-existing");
  assert.equal(row.planId, P_GROWTH);
  assert.equal(row.price.toString(), "8500");
  assert.equal(row.currency, "LKR");
  assert.equal(row.status, "ACTIVE");
  assert.equal(row.startDate.getTime(), START.getTime());
  assert.equal(row.endDate.getTime(), END.getTime());
  assert.equal(row.autoRenew, false);

  assert.equal(payload.data.subscription.startDate, START.toISOString());
  assert.equal(payload.data.subscription.endDate, END.toISOString());
  assert.equal(payload.data.subscription.autoRenew, false);
});

test("re-assigning the same plan refreshes an old price to the plan's current price", async () => {
  await signIn("ADMIN");
  const payload = await ok(await put(T_SUB, { planId: P_STARTER }));

  assert.equal(payload.data.changed, true);
  assert.equal(db.subscriptions[0].price.toString(), "5500");
  assert.equal(db.subscriptions[0].status, "ACTIVE");
});

test("assigning the plan the teacher is already ACTIVE on at its current price changes nothing", async () => {
  await signIn("ADMIN");
  await ok(await put(T_SUB, { planId: P_GROWTH }));
  const after = snapshot();
  infoLines = [];

  const payload = await ok(await put(T_SUB, { planId: P_GROWTH }));
  assert.equal(payload.data.changed, false);
  assert.equal(payload.message, "The subscription is unchanged.");
  assert.deepEqual(snapshot(), after);
  assert.deepEqual(infoLines, [], "nothing logged when nothing changed");
});

test("admin can assign an INACTIVE plan", async () => {
  await signIn("ADMIN");
  const payload = await ok(await put(T_NEW, { planId: P_CUSTOM }));

  assert.equal(payload.data.subscription.planName, "Institution (custom)");
  assert.equal(payload.data.subscription.planStatus, "INACTIVE");
  const row = db.subscriptions.find((candidate) => candidate.teacherId === T_NEW);
  assert.equal(row.planId, P_CUSTOM);
  assert.equal(row.price.toString(), "40000");
});

test("price, currency, dates and auto-renew in the request body are ignored: everything comes from the plan", async () => {
  db.plans.set(P_GROWTH, plan(P_GROWTH, "Growth", 8500, 2, "ACTIVE", "LKR"));
  await signIn("ADMIN");
  await ok(
    await put(T_SUB, {
      planId: P_GROWTH,
      price: 1,
      currency: "USD",
      status: "SUSPENDED",
      startDate: "2020-01-01T00:00:00Z",
      endDate: null,
      autoRenew: true,
    })
  );

  const [row] = db.subscriptions;
  assert.equal(row.price.toString(), "8500");
  assert.equal(row.currency, "LKR");
  assert.equal(row.status, "ACTIVE");
  assert.equal(row.startDate.getTime(), START.getTime());
  assert.equal(row.endDate.getTime(), END.getTime());
  assert.equal(row.autoRenew, false);
});

test("the change runs inside one transaction that first locks the teacher row", async () => {
  await signIn("ADMIN");
  await ok(await put(T_SUB, { planId: P_GROWTH }));

  assert.equal(db.lockQueries.length, 1);
  assert.match(db.lockQueries[0].sql, /^SELECT "id" FROM "Teacher" WHERE "id" = \? FOR UPDATE$/);
  assert.deepEqual(db.lockQueries[0].values, [T_SUB]);
  assert.deepEqual(db.outsideWrites, []);
});

test("each change is written to the server log with the administrator and both plans", async () => {
  await signIn("ADMIN");
  await ok(await put(T_SUB, { planId: P_GROWTH }));
  assert.equal(infoLines.length, 1);
  assert.match(infoLines[0], /admin@example\.test/);
  assert.match(infoLines[0], new RegExp(T_SUB));
  assert.match(infoLines[0], /"Growth"/);
  assert.match(infoLines[0], /previous plan "Starter"/);
});

/* ---------- Not found / validation ---------- */

test("missing teacher: 404 on GET and PUT, nothing written", async () => {
  await signIn("ADMIN");
  await expectError(await get(T_MISSING), 404, "TEACHER_NOT_FOUND");
  await expectError(await put(T_MISSING, { planId: P_STARTER }), 404, "TEACHER_NOT_FOUND");
  assert.equal(db.subscriptions.length, 1);
});

test("invalid plan selections: 400 for a bad or missing id or body, 404 for an unknown plan; nothing written", async () => {
  await signIn("ADMIN");
  const before = snapshot();

  await expectError(await put(T_SUB, {}), 400, "VALIDATION_ERROR");
  await expectError(await put(T_SUB, { planId: "" }), 400, "VALIDATION_ERROR");
  await expectError(await put(T_SUB, { planId: 42 }), 400, "VALIDATION_ERROR");
  await expectError(await put(T_SUB, { planId: "not-a-uuid" }), 400, "VALIDATION_ERROR");
  await expectError(await put(T_SUB, [P_STARTER]), 400, "VALIDATION_ERROR");
  await expectError(await put(T_SUB, "{not json"), 400, "VALIDATION_ERROR");
  await expectError(await put(T_SUB, { planId: P_UNKNOWN }), 404, "PLAN_NOT_FOUND");

  assert.deepEqual(snapshot(), before);
});

test("invalid teacher id: 400 on GET and PUT, the database is not touched", async () => {
  await signIn("ADMIN");
  await expectError(await get("not-a-uuid"), 400, "VALIDATION_ERROR");
  await expectError(await put("not-a-uuid", { planId: P_STARTER }), 400, "VALIDATION_ERROR");
  assert.equal(db.reads, 0);
  assert.equal(db.lockQueries.length, 0);
});

/* ---------- Authorisation ---------- */

test("unauthenticated: 401 on GET and PUT, the database is not touched", async () => {
  await expectError(await get(T_SUB), 401, "UNAUTHORIZED");
  await expectError(await put(T_SUB, { planId: P_GROWTH }), 401, "UNAUTHORIZED");
  cookieJar.set(AUTH_COOKIE_NAME, "not-a-token");
  await expectError(await put(T_SUB, { planId: P_GROWTH }), 401, "UNAUTHORIZED");
  assert.equal(db.reads, 0);
  assert.equal(db.lockQueries.length, 0);
});

test("teachers and students are refused (403) on GET and PUT, nothing is written", async () => {
  const before = snapshot();
  for (const role of ["TEACHER", "STUDENT"]) {
    await signIn(role);
    await expectError(await get(T_SUB), 403, "FORBIDDEN");
    await expectError(await put(T_SUB, { planId: P_GROWTH }), 403, "FORBIDDEN");
  }
  assert.deepEqual(snapshot(), before);
  assert.equal(db.lockQueries.length, 0);
});

/* ---------- Failed transactions ---------- */

test("a failure while changing an existing subscription leaves it exactly as it was", async () => {
  await signIn("ADMIN");
  const before = snapshot();
  db.failOn = "update";

  // The project's handler (lib/error-handler.ts): 500 INTERNAL_SERVER_ERROR, generic message in production.
  await expectError(await put(T_SUB, { planId: P_GROWTH }), 500, "INTERNAL_SERVER_ERROR");
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(infoLines, [], "nothing logged as assigned");
});

test("a failure while creating a subscription leaves no row behind", async () => {
  await signIn("ADMIN");
  db.failOn = "create";

  await expectError(await put(T_NEW, { planId: P_GROWTH }), 500);
  assert.equal(db.subscriptions.some((row) => row.teacherId === T_NEW), false);
  assert.equal(db.subscriptions.length, 1);
});
