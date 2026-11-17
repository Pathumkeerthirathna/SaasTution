/*
 * POST /api/teacher/subscription (app/api/teacher/subscription/route.ts,
 * services/teacher-subscription-service.ts selectTeacherSubscriptionPlan):
 * a teacher may choose or change their plan only while the account is
 * awaiting approval. Once approved (or rejected) the request is refused with
 * 403 SUBSCRIPTION_CHANGE_NOT_ALLOWED and the subscription (plan, price,
 * start date) stays exactly as it was.
 *
 *   npm run test:security
 *
 * The real route, the real session check (lib/auth-session.ts) with real
 * signed tokens (throwaway JWT_SECRET); faked: the cookie reader
 * (next/headers) and the database (an in-memory model whose $transaction
 * rolls back on failure and whose $queryRaw answers the teacher row lock).
 * Any subscription read or write outside the transaction fails the test.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

process.env.JWT_SECRET = "teacher-subscription-selection-test-secret-0123456789";

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
  cookies: () => ({
    get: (name) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  }),
  headers: () => new Headers(),
});

const db = {
  teachers: new Map(),
  plans: new Map(),
  subscriptions: [],
  lockQueries: [],
  outsideTransaction: [],
  nextId: 1,
};

const clone = (rows) => rows.map((row) => ({ ...row }));
const withPlan = (sub) => ({ ...sub, plan: { ...db.plans.get(sub.planId) } });

const tx = {
  $queryRaw: async (strings, ...values) => {
    db.lockQueries.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
    const teacher = db.teachers.get(values[0]);
    return teacher ? [{ isConfirmed: teacher.isConfirmed, isRejected: teacher.isRejected }] : [];
  },
  subscriptionPlan: {
    findUnique: async ({ where }) => (db.plans.has(where.id) ? { ...db.plans.get(where.id) } : null),
  },
  teacherSubscription: {
    findFirst: async ({ where }) => {
      const rows = db.subscriptions.filter((row) => row.teacherId === where.teacherId);
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      return rows[0] ? { ...rows[0] } : null;
    },
    update: async ({ where, data }) => {
      const row = db.subscriptions.find((candidate) => candidate.id === where.id);
      Object.assign(row, data, { updatedAt: new Date() });
      return withPlan(row);
    },
    create: async ({ data }) => {
      const now = new Date();
      const row = { id: `sub-${db.nextId++}`, endDate: null, autoRenew: true, createdAt: now, updatedAt: now, ...data };
      db.subscriptions.push(row);
      return withPlan(row);
    },
  },
};

const outside = (model) =>
  new Proxy({}, {
    get: (_, method) => async () => {
      db.outsideTransaction.push(`${model}.${String(method)}`);
      throw new Error(`${model}.${String(method)} called outside the transaction`);
    },
  });

const prisma = {
  $transaction: async (fn) => {
    const snapshot = clone(db.subscriptions);
    try {
      return await fn(tx);
    } catch (error) {
      db.subscriptions = snapshot;
      throw error;
    }
  },
  subscriptionPlan: outside("subscriptionPlan"),
  teacherSubscription: outside("teacherSubscription"),
  teacher: outside("teacher"),
};
fakeModule(path.join(root, "lib", "prisma.ts"), { prisma });

// API error log: a memory sink (nothing written to disk).
const serverLogger = require(path.join(root, "lib", "error-logging", "server-logger.ts"));
serverLogger.setErrorLogSinkForTests({ write: async () => {}, writeSync: () => {}, flush: async () => {} });

const { POST } = require(path.join(root, "app", "api", "teacher", "subscription", "route.ts"));
const { signAuthToken, AUTH_COOKIE_NAME } = require(path.join(root, "lib", "auth.ts"));

/* ---------- Fixtures ---------- */

const PENDING = "teacher-pending";
const APPROVED = "teacher-approved";
const REJECTED = "teacher-rejected";

const plan = (id, name, price, status = "ACTIVE") => ({
  id,
  name,
  description: null,
  price: new Prisma.Decimal(price),
  currency: "LKR",
  interval: "MONTHLY",
  maxLiveParticipants: 100,
  unlimitedLiveSessions: true,
  unlimitedRecording: true,
  unlimitedStudents: true,
  maxTeachers: null,
  storageGB: null,
  status,
  sortOrder: 0,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
});

const ORIGINAL_START = new Date("2026-10-01T00:00:00Z");

function reset() {
  db.teachers = new Map([
    [PENDING, { isConfirmed: false, isRejected: false }],
    [APPROVED, { isConfirmed: true, isRejected: false }],
    [REJECTED, { isConfirmed: false, isRejected: true }],
  ]);
  db.plans = new Map([
    ["plan-basic", plan("plan-basic", "Basic", 5000)],
    ["plan-pro", plan("plan-pro", "Pro", 12000)],
    ["plan-retired", plan("plan-retired", "Retired", 3000, "INACTIVE")],
  ]);
  db.subscriptions = [];
  db.lockQueries = [];
  db.outsideTransaction = [];
  cookieJar.clear();
}

/** A subscription the teacher already has (Basic, LKR 5000). */
function givenSubscription(teacherId) {
  const row = {
    id: `sub-${teacherId}`,
    teacherId,
    planId: "plan-basic",
    status: "ACTIVE",
    startDate: ORIGINAL_START,
    endDate: null,
    price: new Prisma.Decimal(5000),
    currency: "LKR",
    autoRenew: true,
    createdAt: ORIGINAL_START,
    updatedAt: ORIGINAL_START,
  };
  db.subscriptions.push(row);
  return { ...row };
}

async function signIn(role, sub) {
  const token = await signAuthToken(
    role === "STUDENT"
      ? { sub, email: "s@example.test", name: "S", role, sessionVersion: 0 }
      : { sub, email: "t@example.test", name: "T", role }
  );
  cookieJar.set(AUTH_COOKIE_NAME, token);
}

const post = (body) =>
  POST(
    new Request("https://app.example.test/api/teacher/subscription", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const payload = await response.json();
  assert.equal(payload.success, false);
  assert.equal(payload.error.code, code);
  return payload;
}

test.beforeEach(reset);

/* ---------- Awaiting approval: selection works as before ---------- */

test("awaiting approval: first selection creates an ACTIVE subscription at the plan's price", async () => {
  await signIn("TEACHER", PENDING);
  const response = await post({ planId: "plan-pro" });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.message, "Subscription plan selected.");
  assert.equal(payload.data.subscription.plan.name, "Pro");
  assert.equal(payload.data.subscription.price, 12000);

  assert.equal(db.subscriptions.length, 1);
  const [row] = db.subscriptions;
  assert.equal(row.teacherId, PENDING);
  assert.equal(row.planId, "plan-pro");
  assert.equal(row.status, "ACTIVE");
  assert.equal(row.price.toNumber(), 12000);
  assert.deepEqual(db.outsideTransaction, []);
});

test("awaiting approval: changing the selection updates the same row in place (no new row)", async () => {
  givenSubscription(PENDING);
  await signIn("TEACHER", PENDING);

  const response = await post({ planId: "plan-pro" });

  assert.equal(response.status, 200);
  assert.equal(db.subscriptions.length, 1);
  assert.equal(db.subscriptions[0].id, `sub-${PENDING}`);
  assert.equal(db.subscriptions[0].planId, "plan-pro");
  assert.equal(db.subscriptions[0].price.toNumber(), 12000);
  assert.equal(db.subscriptions[0].endDate, null);
});

test("the selection locks the teacher row inside the transaction", async () => {
  await signIn("TEACHER", PENDING);
  await post({ planId: "plan-basic" });

  assert.equal(db.lockQueries.length, 1);
  assert.match(db.lockQueries[0].sql, /^SELECT "isConfirmed", "isRejected" FROM "Teacher" WHERE "id" = \? FOR UPDATE$/);
  assert.deepEqual(db.lockQueries[0].values, [PENDING]);
  assert.deepEqual(db.outsideTransaction, []);
});

/* ---------- Approved or rejected: refused, nothing changes ---------- */

test("approved teacher: changing the plan is refused (403) and the subscription is unchanged", async () => {
  const before = givenSubscription(APPROVED);
  await signIn("TEACHER", APPROVED);

  const response = await post({ planId: "plan-pro" });

  const payload = await expectError(response, 403, "SUBSCRIPTION_CHANGE_NOT_ALLOWED");
  assert.match(payload.error.message, /approved/);
  assert.match(payload.error.message, /contact us/);
  assert.equal(db.subscriptions.length, 1);
  assert.deepEqual(db.subscriptions[0], before, "plan, price, status and dates untouched");
});

test("approved teacher without a subscription: refused, no subscription is created", async () => {
  await signIn("TEACHER", APPROVED);

  await expectError(await post({ planId: "plan-basic" }), 403, "SUBSCRIPTION_CHANGE_NOT_ALLOWED");
  assert.equal(db.subscriptions.length, 0);
});

test("approved teacher: refused before the plan is even looked up (unknown or inactive plan is still 403)", async () => {
  await signIn("TEACHER", APPROVED);

  await expectError(await post({ planId: "no-such-plan" }), 403, "SUBSCRIPTION_CHANGE_NOT_ALLOWED");
  await expectError(await post({ planId: "plan-retired" }), 403, "SUBSCRIPTION_CHANGE_NOT_ALLOWED");
  assert.equal(db.subscriptions.length, 0);
});

test("rejected teacher: selecting a plan is refused (403), nothing is written", async () => {
  const before = givenSubscription(REJECTED);
  await signIn("TEACHER", REJECTED);

  const payload = await expectError(await post({ planId: "plan-pro" }), 403, "SUBSCRIPTION_CHANGE_NOT_ALLOWED");
  assert.match(payload.error.message, /not approved/);
  assert.deepEqual(db.subscriptions, [before]);
});

test("unknown teacher account (valid token, no row): 404, nothing written", async () => {
  await signIn("TEACHER", "teacher-deleted");

  await expectError(await post({ planId: "plan-basic" }), 404, "TEACHER_NOT_FOUND");
  assert.equal(db.subscriptions.length, 0);
});

/* ---------- Unauthenticated / wrong role ---------- */

test("unauthenticated request: 401, the database is not touched", async () => {
  const response = await post({ planId: "plan-basic" });

  await expectError(response, 401, "UNAUTHORIZED");
  assert.equal(db.lockQueries.length, 0);
  assert.equal(db.subscriptions.length, 0);
});

test("invalid or non-teacher token: 401, the database is not touched", async () => {
  cookieJar.set(AUTH_COOKIE_NAME, "not-a-token");
  await expectError(await post({ planId: "plan-basic" }), 401, "UNAUTHORIZED");

  await signIn("STUDENT", PENDING);
  await expectError(await post({ planId: "plan-basic" }), 401, "UNAUTHORIZED");

  assert.equal(db.lockQueries.length, 0);
  assert.equal(db.subscriptions.length, 0);
});

/* ---------- Invalid selections (awaiting approval) ---------- */

test("invalid selections are rejected and nothing is written", async () => {
  const before = givenSubscription(PENDING);
  await signIn("TEACHER", PENDING);

  await expectError(await post({}), 400, "VALIDATION_ERROR");
  await expectError(await post({ planId: 42 }), 400, "VALIDATION_ERROR");
  await expectError(await post({ planId: "" }), 400, "VALIDATION_ERROR");
  await expectError(await post("{not json"), 400, "VALIDATION_ERROR");
  await expectError(await post({ planId: "no-such-plan" }), 404, "PLAN_NOT_FOUND");
  await expectError(await post({ planId: "plan-retired" }), 400, "PLAN_NOT_AVAILABLE");

  assert.deepEqual(db.subscriptions, [before]);
  assert.deepEqual(db.outsideTransaction, []);
});
