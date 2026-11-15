/*
 * Teacher storage quota, Stage 3.4: the admin storage APIs
 *   GET  /api/admin/teachers/[teacherId]/storage
 *   PUT  /api/admin/teachers/[teacherId]/storage-limit
 *   GET  /api/admin/teachers/[teacherId]/storage-limit/history
 *
 *   npm run test:storage-quota
 *
 * The REAL routes, session check (signed tokens in the session cookie: admin,
 * teacher, student or none), admin service and usage service run.
 * lib/prisma.ts is an in-memory FAKE with transactions (rollback on throw) and
 * advisory locks; it is not PostgreSQL (tests/storage-quota/*.db.test.cjs are
 * skipped without a local test database).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

process.env.JWT_SECRET = "stage-3-4-test-secret-not-a-real-one-0123456789";
const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

function fakeAt(filename, exports) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const fake = (relativePath, exports) => fakeAt(path.join(root, relativePath), exports);

const B = (n) => BigInt(n);
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const UNKNOWN = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-11-16T12:00:00.000Z");

// ---- Fake database ----------------------------------------------------------------------------------------

const db = {};
function resetDb() {
  Object.assign(db, {
    teachers: [
      { id: T1, name: "Nimal Perera", email: "nimal@example.test" },
      { id: T2, name: "Kamala Silva", email: "kamala@example.test" },
    ],
    limits: [],
    changes: [],
    subscriptions: [],
    notesBytes: new Map(),
    locks: [],
    hooks: {},
  });
}
resetDb();
const tick = () => new Promise((r) => setImmediate(r));

function matchesSubscription(s, where) {
  if (s.teacherId !== where.teacherId) return false;
  if (where.status !== undefined && s.status !== where.status) return false;
  if (where.OR) {
    const now = where.OR[1].endDate.gt;
    if (!(s.endDate === null || s.endDate > now)) return false;
  }
  return true;
}

function client(ctx) {
  const undo = (fn) => ctx?.undo.push(fn);
  const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row });
  return {
    async $executeRaw(strings, ...values) {
      await tick();
      if (strings.join("?").includes("pg_advisory_xact_lock")) {
        if (!ctx) throw new Error("lock outside a transaction");
        db.locks.push(values[0]);
      }
      return 0;
    },
    $executeRawUnsafe: async () => 0,
    async $queryRaw(strings, ...values) {
      await tick();
      return [{ notesBytes: db.notesBytes.get(values[0]) ?? B(0), submissionsBytes: B(0) }];
    },
    teacher: { findUnique: async ({ where, select }) => (db.teachers.find((t) => t.id === where.id) ? pick(db.teachers.find((t) => t.id === where.id), select) : null) },
    recordingUploadSession: { findMany: async () => [] },
    storageReservation: { groupBy: async () => [] },
    recordedLecture: { aggregate: async () => ({ _sum: { sizeBytes: null } }) },
    teacherStorageLimit: {
      async findUnique({ where, select }) {
        await tick();
        const row = db.limits.find((l) => l.teacherId === where.teacherId);
        return row ? pick(row, select) : null;
      },
      async upsert({ where, create, update }) {
        await tick();
        const row = db.limits.find((l) => l.teacherId === where.teacherId);
        if (row) {
          const before = { ...row };
          Object.assign(row, update);
          undo(() => Object.assign(row, before));
        } else {
          const created = { ...create };
          db.limits.push(created);
          undo(() => db.limits.splice(db.limits.indexOf(created), 1));
        }
      },
      async delete({ where }) {
        await tick();
        const row = db.limits.find((l) => l.teacherId === where.teacherId);
        db.limits.splice(db.limits.indexOf(row), 1);
        undo(() => db.limits.push(row));
      },
    },
    teacherStorageLimitChange: {
      async create({ data }) {
        await tick();
        if (db.hooks.failAudit) throw new Error("audit insert failed");
        const row = { ...data, writtenInTransaction: Boolean(ctx) };
        db.changes.push(row);
        undo(() => db.changes.splice(db.changes.indexOf(row), 1));
      },
      async findMany({ where, skip, take }) {
        return db.changes
          .filter((c) => c.teacherId === where.teacherId)
          .sort((a, b) => b.changedAt - a.changedAt || (a.id < b.id ? 1 : -1))
          .slice(skip, skip + take);
      },
      count: async ({ where }) => db.changes.filter((c) => c.teacherId === where.teacherId).length,
    },
    // Profile photos (PROFILE_IMAGE): none unless a test adds db.profiles rows.
    teacherProfile: { findUnique: async ({ where }) => (db.profiles ?? []).find((p) => p.teacherId === where.teacherId) ?? null },
    teacherSubscription: {
      async findFirst({ where }) {
        const rows = db.subscriptions.filter((s) => matchesSubscription(s, where)).sort((a, b) => b.updatedAt - a.updatedAt);
        const s = rows[0];
        return s ? { id: s.id, status: s.status, startDate: s.startDate, endDate: s.endDate, plan: { ...s.plan } } : null;
      },
    },
  };
}
const prisma = {
  ...client(null),
  async $transaction(fn) {
    const ctx = { undo: [] };
    try {
      return await fn(client(ctx));
    } catch (error) {
      for (const u of ctx.undo.reverse()) u();
      throw error;
    }
  },
};
fake("lib/prisma.ts", { prisma });
fake("lib/server-clock.ts", { serverNow: async () => new Date(NOW), serverNowSync: () => new Date(NOW) });
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });

const session = { cookie: null };
fakeAt(require.resolve("next/headers", { paths: [root] }), {
  cookies: () => ({ get: (name) => (name === "teacher_session" && session.cookie ? { name, value: session.cookie } : undefined) }),
  headers: () => new Headers(),
});

const { signAuthToken } = require(path.join(root, "lib", "auth.ts"));
const storageRoute = require(path.join(root, "app", "api", "admin", "teachers", "[teacherId]", "storage", "route.ts"));
const limitRoute = require(path.join(root, "app", "api", "admin", "teachers", "[teacherId]", "storage-limit", "route.ts"));
const historyRoute = require(path.join(root, "app", "api", "admin", "teachers", "[teacherId]", "storage-limit", "history", "route.ts"));

// ---- Helpers ----------------------------------------------------------------------------------------------

async function signIn(role, sub = role === "ADMIN" ? "admin-7" : T1) {
  session.cookie = await signAuthToken({ sub, email: `${role.toLowerCase()}@example.test`, role, name: role, ...(role === "STUDENT" ? { sessionVersion: 0 } : {}) });
}
const ctx = (teacherId) => ({ params: { teacherId } });
async function getStorage(teacherId = T1) {
  const res = await storageRoute.GET(new Request(`http://localhost/api/admin/teachers/${teacherId}/storage`), ctx(teacherId));
  return { status: res.status, body: await res.json() };
}
async function putLimit(body, teacherId = T1) {
  const res = await limitRoute.PUT(
    new Request(`http://localhost/api/admin/teachers/${teacherId}/storage-limit`, { method: "PUT", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    ctx(teacherId)
  );
  return { status: res.status, body: await res.json() };
}
async function getHistory(teacherId = T1, query = "") {
  const res = await historyRoute.GET(new Request(`http://localhost/api/admin/teachers/${teacherId}/storage-limit/history${query}`), ctx(teacherId));
  return { status: res.status, body: await res.json() };
}
const subscription = (teacherId, storageGB, { status = "ACTIVE", endDate = null, updatedAt = new Date("2026-01-01"), name = "Pro" } = {}) =>
  db.subscriptions.push({ id: `sub-${db.subscriptions.length}`, teacherId, status, startDate: new Date("2026-01-01"), endDate, updatedAt, plan: { id: `plan-${name}`, name, storageGB } });

test.beforeEach(async () => {
  resetDb();
  await signIn("ADMIN");
});

// ==== Authorization ======================================================================================

test("auth: no session -> 401; teacher or student session -> 403; nothing is read or written", async () => {
  for (const setup of [() => (session.cookie = null), () => signIn("TEACHER", T1), () => signIn("STUDENT", "student-1")]) {
    await setup();
    const expected = session.cookie ? 403 : 401;
    assert.equal((await getStorage()).status, expected);
    assert.equal((await putLimit({ limitGB: "5" })).status, expected);
    assert.equal((await getHistory()).status, expected);
  }
  assert.deepEqual([db.limits.length, db.changes.length, db.locks.length], [0, 0, 0]);
});

test("teacher id: malformed -> 400 VALIDATION_ERROR; unknown -> 404 TEACHER_NOT_FOUND (all three endpoints)", async () => {
  for (const bad of ["abc", "../x", "11111111-1111-4111-8111-11111111111Z"]) {
    assert.equal((await getStorage(bad)).status, 400, bad);
    assert.equal((await putLimit({ limitGB: "1" }, bad)).status, 400);
    assert.equal((await getHistory(bad)).status, 400);
  }
  assert.equal((await getStorage(UNKNOWN)).body.error.code, "TEACHER_NOT_FOUND");
  assert.equal((await putLimit({ limitGB: "1" }, UNKNOWN)).status, 404);
  assert.equal((await getHistory(UNKNOWN)).status, 404);
  assert.equal(db.changes.length, 0);
});

// ==== GET ====================================================================================================

test("GET: usage, limit, source, override and plan, with byte counts as strings and no file details", async () => {
  db.notesBytes.set(T1, B(2_500_000_000));
  subscription(T1, 10);
  const { status, body } = await getStorage();
  assert.equal(status, 200);
  const d = body.data;
  assert.deepEqual(d.teacher, { id: T1, name: "Nimal Perera", email: "nimal@example.test" });
  assert.deepEqual(d.usage.committedBytes, { recordedLectures: "0", notes: "2500000000", submissions: "0", profileImages: "0", total: "2500000000" });
  assert.deepEqual(d.usage.reservedBytes, { recordedLectures: "0", notes: "0", submissions: "0", profileImages: "0", total: "0" });
  assert.deepEqual(d.usage.limit, { limitBytes: "10000000000", source: "PLAN", overrideBytes: null, planLimitBytes: "10000000000" });
  assert.deepEqual([d.usage.remainingBytes, d.usage.usagePercent, d.usage.isUnlimited, d.usage.isOverQuota, d.isOverLimitIncludingReservations], ["7500000000", 25, false, false, false]);
  assert.equal(d.override, null);
  assert.equal(d.subscription.active.planName, "Pro");
  assert.equal(d.subscription.active.planLimitBytes, "10000000000");
  assert.doesNotMatch(JSON.stringify(body), /storageKey|Teachers\/|sha256|fileUrl|storedFileName/, "no file internals");
});

test("GET: cancelled / expired / suspended / ended subscriptions supply no limit (unlimited), but are shown as the latest subscription", async () => {
  for (const [status, endDate] of [["CANCELLED", null], ["EXPIRED", null], ["SUSPENDED", null], ["ACTIVE", new Date(NOW - 1)]]) {
    db.subscriptions = [];
    subscription(T1, 1, { status, endDate });
    const d = (await getStorage()).body.data;
    assert.equal(d.usage.limit.source, "NO_ACTIVE_SUBSCRIPTION", status);
    assert.equal(d.usage.isUnlimited, true);
    assert.equal(d.subscription.active, null);
    assert.equal(d.subscription.latest.status, status);
  }
  db.subscriptions = [];
  subscription(T1, null);
  const d = (await getStorage()).body.data;
  assert.deepEqual([d.usage.limit.source, d.usage.isUnlimited, d.subscription.active.planLimitBytes], ["UNLIMITED_PLAN", true, null]);
});

// ==== PUT ====================================================================================================

test("PUT: set (decimal GB, exact), increase, decrease and remove - each audited with the session's admin; removal restores the plan", async () => {
  subscription(T1, 10);
  let r = await putLimit({ limitGB: "12.5" });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.changed, true);
  assert.deepEqual(db.limits[0].limitBytes, B(12_500_000_000));
  assert.deepEqual(r.body.data.usage.limit, { limitBytes: "12500000000", source: "OVERRIDE", overrideBytes: "12500000000", planLimitBytes: "10000000000" });
  assert.equal(r.body.data.override.updatedByAdminEmail, "admin@example.test");

  assert.equal((await putLimit({ limitGB: 20 })).status, 200, "increase (a JSON number)");
  assert.equal((await putLimit({ limitBytes: "5000000000" })).status, 200, "decrease (decimal bytes)");
  r = await putLimit({ removeOverride: true });
  assert.equal(r.status, 200);
  assert.equal(db.limits.length, 0);
  assert.deepEqual(r.body.data.usage.limit, { limitBytes: "10000000000", source: "PLAN", overrideBytes: null, planLimitBytes: "10000000000" }, "back to the plan");

  assert.deepEqual(
    db.changes.map((c) => [c.previousLimitBytes, c.newLimitBytes, c.planLimitBytes, c.changedByAdminId, c.changedByAdminEmail, c.changedAt.getTime()]),
    [
      [null, B(12_500_000_000), B(10_000_000_000), "admin-7", "admin@example.test", NOW],
      [B(12_500_000_000), B(20_000_000_000), B(10_000_000_000), "admin-7", "admin@example.test", NOW],
      [B(20_000_000_000), B(5_000_000_000), B(10_000_000_000), "admin-7", "admin@example.test", NOW],
      [B(5_000_000_000), null, B(10_000_000_000), "admin-7", "admin@example.test", NOW],
    ]
  );
  assert.deepEqual(db.locks, Array(4).fill(`storage-quota:teacher:${T1}`), "every change held the teacher's quota lock (level 2 only)");
  assert.ok(db.changes.every((c) => c.writtenInTransaction), "the audit rows are written inside the limit's transaction");
});

test("PUT: the audit's plan limit is the ACTIVE plan's (an inactive latest subscription supplies none)", async () => {
  subscription(T1, 1, { status: "SUSPENDED", updatedAt: new Date("2026-06-01") });
  await putLimit({ limitGB: "2" });
  assert.equal(db.changes[0].planLimitBytes, null, "suspended: no plan limit");
  subscription(T1, 10, { updatedAt: new Date("2026-01-01") }); // older but ACTIVE
  await putLimit({ limitGB: "3" });
  assert.equal(db.changes[1].planLimitBytes, B(10_000_000_000));
});

test("PUT: the override applies over an unlimited plan; removing it with no active plan restores unlimited", async () => {
  subscription(T1, null);
  let r = await putLimit({ limitGB: "3" });
  assert.deepEqual([r.body.data.usage.limit.source, r.body.data.usage.limit.limitBytes, r.body.data.usage.isUnlimited], ["OVERRIDE", "3000000000", false]);
  db.subscriptions = [];
  r = await putLimit({ removeOverride: true });
  assert.deepEqual([r.body.data.usage.limit.source, r.body.data.usage.isUnlimited], ["NO_ACTIVE_SUBSCRIPTION", true]);
});

test("PUT: 0 is a real limit (nothing more may be stored), never unlimited", async () => {
  db.notesBytes.set(T1, B(10));
  const r = await putLimit({ limitGB: "0" });
  assert.equal(r.status, 200);
  const u = r.body.data.usage;
  assert.deepEqual([u.limit.limitBytes, u.isUnlimited, u.remainingBytes, u.isOverQuota, u.overQuotaBytes], ["0", false, "0", true, "10"]);
});

test("PUT: a limit below the current usage is saved, files untouched, and reported as over the limit", async () => {
  db.notesBytes.set(T1, B(4_000_000_000));
  const r = await putLimit({ limitGB: "1" });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.usage.isOverQuota, true);
  assert.equal(r.body.data.isOverLimitIncludingReservations, true);
  assert.equal(r.body.data.usage.overQuotaBytes, "3000000000");
  assert.equal(db.notesBytes.get(T1), B(4_000_000_000), "usage (files) unchanged");
});

test("PUT: invalid, negative, excessive or ambiguous bodies are refused with 400 and change nothing", async () => {
  const bad = [
    { limitGB: "-1" },
    { limitGB: -1 },
    { limitGB: "abc" },
    { limitGB: "" },
    { limitGB: "1.0000000001" }, // more than 9 decimals (finer than a byte)
    { limitGB: 1e-10 },
    { limitGB: "1000001" }, // over 1 PB
    { limitGB: Number.NaN },
    { limitGB: null },
    { limitBytes: "1000000000000001" },
    { limitBytes: 5 },
    { limitBytes: "1e9" },
    { limitGB: "1", limitBytes: "1" },
    { removeOverride: false },
    {},
    { limitGB: "5", teacherId: T2 }, // the teacher comes from the URL only
    { limitGB: "5", changedByAdminEmail: "someone@else.test" }, // the admin comes from the session only
    [],
  ];
  for (const body of bad) {
    const r = await putLimit(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error.code, "VALIDATION_ERROR");
  }
  assert.equal((await putLimit("{not json")).body.error.code, "INVALID_JSON");
  for (const field of ["teacherId", "adminId", "changedByAdminEmail"]) {
    const r = await putLimit({ [field]: "x" });
    assert.equal(r.body.error.message, `Unexpected field: ${field}.`, "identity fields are refused by name");
  }
  assert.deepEqual([db.limits.length, db.changes.length], [0, 0]);
  assert.equal((await putLimit({ limitGB: "1000000" })).status, 200, "exactly 1 PB is the maximum");
  assert.equal(db.limits[0].limitBytes, B("1000000000000000"));
});

test("PUT: an unchanged limit or removing a missing override writes nothing (changed: false)", async () => {
  assert.equal((await putLimit({ removeOverride: true })).body.data.changed, false);
  await putLimit({ limitGB: "5" });
  const again = await putLimit({ limitBytes: "5000000000" });
  assert.equal(again.body.data.changed, false);
  assert.equal(db.changes.length, 1);
});

test("PUT: the override and its audit row are atomic: a failing audit insert rolls the limit back", async () => {
  await putLimit({ limitGB: "5" });
  db.hooks.failAudit = true;
  const r = await putLimit({ limitGB: "9" });
  assert.equal(r.status, 500);
  assert.equal(db.limits[0].limitBytes, B(5_000_000_000), "the limit is unchanged");
  assert.equal(db.changes.length, 1);
  db.hooks.failAudit = false;
  db.hooks = {};
  const removed = await putLimit({ removeOverride: true });
  assert.equal(removed.status, 200);
});

test("PUT: only the URL's teacher is changed (cross-teacher isolation)", async () => {
  await putLimit({ limitGB: "7" }, T2);
  assert.deepEqual(db.limits.map((l) => l.teacherId), [T2]);
  assert.equal((await getStorage(T1)).body.data.override, null);
  assert.equal((await getStorage(T2)).body.data.override.limitBytes, "7000000000");
});

test("BigInt: values beyond Number.MAX_SAFE_INTEGER stay exact through the JSON", async () => {
  db.notesBytes.set(T1, B("9007199254740993"));
  const r = await putLimit({ limitBytes: "999999999999999" });
  assert.equal(r.body.data.usage.committedBytes.notes, "9007199254740993");
  assert.equal(r.body.data.usage.overQuotaBytes, "8007199254740994", "9007199254740993 - 999999999999999, exactly");
});

// ==== History ==============================================================================================

test("history: newest first, paginated, admin email and limits as strings, read only", async () => {
  for (const gb of ["1", "2", "3"]) {
    await putLimit({ limitGB: gb });
    db.changes[db.changes.length - 1].changedAt = new Date(NOW + db.changes.length * 1000);
  }
  const first = await getHistory(T1, "?page=1&pageSize=2");
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.data.items.map((i) => [i.previousLimitBytes, i.newLimitBytes]), [["2000000000", "3000000000"], ["1000000000", "2000000000"]]);
  assert.equal(first.body.data.items[0].changedByAdminEmail, "admin@example.test");
  assert.deepEqual([first.body.data.pagination.totalItems, first.body.data.pagination.totalPages, first.body.data.pagination.hasNextPage], [3, 2, true]);
  const second = await getHistory(T1, "?page=2&pageSize=2");
  assert.deepEqual(second.body.data.items.map((i) => i.newLimitBytes), ["1000000000"]);
  assert.equal(db.changes.length, 3, "reading changed nothing");
});
