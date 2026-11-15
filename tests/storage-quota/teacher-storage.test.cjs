/*
 * Teacher storage quota, Stage 3.5: GET /api/teacher/storage, the teacher's
 * own read-only storage usage.
 *
 *   npm run test:storage-quota
 *
 * The REAL route, session check (signed tokens in the session cookie) and
 * usage service (getTeacherStorageUsage) run; lib/prisma.ts is an in-memory
 * FAKE that records the teacher id of every query. It is not PostgreSQL.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

process.env.JWT_SECRET = "stage-3-5-test-secret-not-a-real-one-0123456789";
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
const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const GB = 1_000_000_000;

const db = {};
function resetDb() {
  Object.assign(db, {
    recordings: [], // { teacherId, sizeBytes }  (READY, stored file, not purged)
    sessions: [], // RecordingUploadSession rows
    reservations: [], // { teacherId, category, bytes, expiresAt }
    notes: new Map(),
    submissions: new Map(),
    limits: [],
    subscriptions: [],
    queriedTeachers: new Set(),
    fail: false,
  });
}
resetDb();

const seen = (teacherId) => db.queriedTeachers.add(teacherId);
const client = {
  recordingUploadSession: {
    async findMany({ where }) {
      seen(where.teacherId);
      return db.sessions.filter((s) => s.teacherId === where.teacherId && where.state.in.includes(s.state));
    },
  },
  storageReservation: {
    async groupBy({ where }) {
      seen(where.teacherId);
      const live = db.reservations.filter((r) => r.teacherId === where.teacherId && r.expiresAt > where.expiresAt.gt);
      return ["NOTE", "SUBMISSION"].map((c) => ({ category: c, _sum: { bytes: live.filter((r) => r.category === c).reduce((t, r) => t + r.bytes, B(0)) } })).filter((g) => g._sum.bytes > B(0));
    },
  },
  recordedLecture: {
    async aggregate({ where }) {
      seen(where.teacherId);
      const rows = db.recordings.filter((r) => r.teacherId === where.teacherId);
      return { _sum: { sizeBytes: rows.length ? rows.reduce((t, r) => t + r.sizeBytes, B(0)) : null } };
    },
  },
  async $queryRaw(strings, ...values) {
    if (db.fail) throw new Error("connection to 10.0.0.5:5432 refused (internal detail)");
    seen(values[0]);
    return [{ notesBytes: db.notes.get(values[0]) ?? B(0), submissionsBytes: db.submissions.get(values[0]) ?? B(0) }];
  },
  teacherStorageLimit: {
    async findUnique({ where }) {
      seen(where.teacherId);
      return db.limits.find((l) => l.teacherId === where.teacherId) ?? null;
    },
  },
  teacherSubscription: {
    async findFirst({ where }) {
      seen(where.teacherId);
      const now = where.OR[1].endDate.gt;
      const rows = db.subscriptions.filter((s) => s.teacherId === where.teacherId && s.status === where.status && (s.endDate === null || s.endDate > now)).sort((a, b) => b.updatedAt - a.updatedAt);
      return rows[0] ? { plan: { storageGB: rows[0].storageGB } } : null;
    },
  },
};
fake("lib/prisma.ts", { prisma: { ...client, $transaction: async (fn) => fn(client) } });
fake("lib/server-clock.ts", { serverNow: async () => new Date(NOW), serverNowSync: () => new Date(NOW) });
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });

const session = { cookie: null };
fakeAt(require.resolve("next/headers", { paths: [root] }), {
  cookies: () => ({ get: (name) => (name === "teacher_session" && session.cookie ? { name, value: session.cookie } : undefined) }),
  headers: () => new Headers(),
});

const { signAuthToken } = require(path.join(root, "lib", "auth.ts"));
const route = require(path.join(root, "app", "api", "teacher", "storage", "route.ts"));

async function signIn(role, sub = T1) {
  session.cookie = await signAuthToken({ sub, email: `${role.toLowerCase()}@example.test`, role, name: role, ...(role === "STUDENT" ? { sessionVersion: 0 } : {}) });
}
async function get(url = "http://localhost/api/teacher/storage", init) {
  const res = await route.GET(new Request(url, init));
  return { status: res.status, body: await res.json() };
}
const plan = (teacherId, storageGB, status = "ACTIVE") => db.subscriptions.push({ teacherId, storageGB, status, endDate: null, updatedAt: new Date("2026-01-01") });

test.beforeEach(async () => {
  resetDb();
  await signIn("TEACHER", T1);
});

// ==== Authorization =========================================================================================

test("auth: no session -> 401; admin or student session -> 401 (teachers only); no usage is read", async () => {
  for (const setup of [() => (session.cookie = null), () => signIn("ADMIN", "admin-1"), () => signIn("STUDENT", "student-1")]) {
    await setup();
    const r = await get();
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, "UNAUTHORIZED");
  }
  assert.equal(db.queriedTeachers.size, 0);
});

test("identity: the teacher comes from the session only - a teacherId query, header or body never changes it", async () => {
  db.notes.set(T1, B(100));
  db.notes.set(T2, B(999_999));
  const r = await get(`http://localhost/api/teacher/storage?teacherId=${T2}`, { headers: { "x-teacher-id": T2, "x-forwarded-user": T2 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.categories.notes.committedBytes, "100", "T1's own usage");
  assert.deepEqual([...db.queriedTeachers], [T1], "every query was for the session's teacher");

  await signIn("TEACHER", T2);
  db.queriedTeachers.clear();
  assert.equal((await get()).body.data.categories.notes.committedBytes, "999999");
  assert.deepEqual([...db.queriedTeachers], [T2]);
});

test("no admin-only data: no override value, plan figure, admin identity, history, ids or file internals", async () => {
  db.limits.push({ teacherId: T1, limitBytes: B(5 * GB) });
  plan(T1, 10);
  const { body } = await get();
  assert.deepEqual(Object.keys(body.data).sort(), [
    "categories", "committedBytes", "isOverLimitIncludingReservations", "isOverQuota", "isUnlimited", "limitBytes", "limitSource",
    "measuredAt", "overQuotaBytes", "remainingBytes", "reservedBytes", "totalBytes", "usagePercent",
  ]);
  assert.equal(body.data.limitSource, "INDIVIDUAL");
  const json = JSON.stringify(body);
  assert.doesNotMatch(json, /overrideBytes|planLimitBytes|updatedBy|changedBy|admin|history|teacherId|storageKey|Teachers\/|sha256|fileUrl|10000000000/);
});

// ==== Calculations (through the real usage service) =============================================================

test("normal usage: committed + reserved per category, totals, remaining and percentage against the plan limit", async () => {
  plan(T1, 10);
  db.recordings.push({ teacherId: T1, sizeBytes: B(3 * GB) });
  db.sessions.push({ teacherId: T1, state: "ACTIVE", expectedBytes: B(GB / 2), receivedBytes: B(0), leaseBytes: null, leaseExpiresAt: null, expiresAt: new Date(NOW + 3_600_000) });
  db.notes.set(T1, B(250_000_000));
  db.submissions.set(T1, B(125_000_000));
  db.reservations.push({ teacherId: T1, category: "SUBMISSION", bytes: B(25_000_000), expiresAt: new Date(NOW + 60_000) });
  const d = (await get()).body.data;
  assert.deepEqual(d.categories, {
    recordedLectures: { committedBytes: "3000000000", reservedBytes: "500000000", totalBytes: "3500000000" },
    notes: { committedBytes: "250000000", reservedBytes: "0", totalBytes: "250000000" },
    submissions: { committedBytes: "125000000", reservedBytes: "25000000", totalBytes: "150000000" },
  });
  assert.deepEqual([d.committedBytes, d.reservedBytes, d.totalBytes], ["3375000000", "525000000", "3900000000"]);
  assert.deepEqual([d.limitBytes, d.limitSource, d.remainingBytes, d.usagePercent], ["10000000000", "PLAN", "6100000000", 39]);
  assert.deepEqual([d.isUnlimited, d.isOverQuota, d.overQuotaBytes, d.isOverLimitIncludingReservations], [false, false, "0", false]);
});

test("zero usage", async () => {
  plan(T1, 1);
  const d = (await get()).body.data;
  assert.deepEqual([d.totalBytes, d.remainingBytes, d.usagePercent, d.isOverQuota], ["0", "1000000000", 0, false]);
});

test("unlimited: an unlimited plan, and no active subscription (suspended / none) - usage still shown, no remaining or percentage", async () => {
  db.notes.set(T1, B(42));
  plan(T1, null);
  let d = (await get()).body.data;
  assert.deepEqual([d.isUnlimited, d.limitBytes, d.limitSource, d.remainingBytes, d.usagePercent, d.totalBytes], [true, null, "UNLIMITED_PLAN", null, null, "42"]);
  db.subscriptions = [];
  plan(T1, 1, "SUSPENDED");
  d = (await get()).body.data;
  assert.deepEqual([d.isUnlimited, d.limitSource], [true, "NO_ACTIVE_SUBSCRIPTION"]);
});

test("individual limit (set by an admin) takes precedence over the plan; its value is the effective limit", async () => {
  plan(T1, 100);
  db.limits.push({ teacherId: T1, limitBytes: B(2 * GB) });
  const d = (await get()).body.data;
  assert.deepEqual([d.limitBytes, d.limitSource], ["2000000000", "INDIVIDUAL"]);
});

test("over quota (stored files above the limit), and 'limit reached' when only uploads in progress pass it", async () => {
  db.limits.push({ teacherId: T1, limitBytes: B(GB) });
  db.notes.set(T1, B(1_500_000_000));
  let d = (await get()).body.data;
  assert.deepEqual([d.isOverQuota, d.overQuotaBytes, d.remainingBytes, d.usagePercent, d.isOverLimitIncludingReservations], [true, "500000000", "0", 150, true]);

  db.notes.set(T1, B(900_000_000));
  db.reservations.push({ teacherId: T1, category: "NOTE", bytes: B(200_000_000), expiresAt: new Date(NOW + 60_000) });
  d = (await get()).body.data;
  assert.deepEqual([d.isOverQuota, d.isOverLimitIncludingReservations, d.remainingBytes], [false, true, "0"]);
});

test("expired reservations and ended sessions are not counted (the service's rules, unchanged)", async () => {
  plan(T1, 10);
  db.reservations.push({ teacherId: T1, category: "NOTE", bytes: B(5), expiresAt: new Date(NOW) });
  db.sessions.push({ teacherId: T1, state: "ACTIVE", expectedBytes: B(7), receivedBytes: B(0), leaseBytes: null, leaseExpiresAt: null, expiresAt: new Date(NOW - 1) });
  db.sessions.push({ teacherId: T1, state: "CANCELLED", expectedBytes: B(9), receivedBytes: B(0), leaseBytes: null, leaseExpiresAt: null, expiresAt: new Date(NOW + 1) });
  assert.equal((await get()).body.data.reservedBytes, "0");
});

test("BigInt beyond Number.MAX_SAFE_INTEGER stays exact (decimal strings)", async () => {
  db.recordings.push({ teacherId: T1, sizeBytes: B("9007199254740993") });
  db.notes.set(T1, B(7));
  const d = (await get()).body.data;
  assert.equal(d.categories.recordedLectures.totalBytes, "9007199254740993");
  assert.equal(d.totalBytes, "9007199254741000");
});

test("errors: a failing usage read is a 500 through the shared handler - generic (no internal details) in production", async () => {
  db.fail = true;
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = "production"; // the shared handler hides raw messages in production only (by design)
  try {
    const r = await get();
    assert.equal(r.status, 500);
    assert.equal(r.body.success, false);
    assert.equal(r.body.error.code, "INTERNAL_SERVER_ERROR");
    assert.doesNotMatch(JSON.stringify(r.body), /10\.0\.0\.5|internal detail/);
  } finally {
    process.env.NODE_ENV = saved;
  }
});

test("source: read only (GET only), the usage service is the only source, no filesystem access", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(root, "app", "api", "teacher", "storage", "route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.deepEqual(Object.keys(route).filter((k) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(k)), ["GET"]);
  assert.match(src, /getTeacherStorageUsage\(session\.teacherId\)/);
  assert.doesNotMatch(src, /searchParams|request\.json|headers\.get|node:fs|teacherStorageLimit|admin/i);
});
