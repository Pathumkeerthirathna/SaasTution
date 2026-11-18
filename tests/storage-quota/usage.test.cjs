/*
 * Teacher storage accounting, Stage 3.1: the pure rules (lib/storage-quota/usage.ts)
 * and getTeacherStorageUsage (services/teacher-storage-usage-service.ts).
 *
 *   npm run test:storage-quota
 *
 * No database: lib/prisma.ts is an in-memory FAKE that implements the
 * intended row selection (it cannot prove what PostgreSQL does with the SQL;
 * that is tests/storage-quota/usage.db.test.cjs, skipped without a local test
 * database). The SQL text is checked statically below.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

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

const NOW = new Date("2026-11-16T10:00:00.000Z");
const db = { tables: {}, sql: [], transactions: [], transactionKinds: [] };
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const B = (n) => BigInt(n);
const GB = BigInt(1_000_000_000);

function resetDb() {
  db.tables = { lectures: [], assignments: [], notes: [], submissions: [], recordings: [], sessions: [], reservations: [], limits: [], subscriptions: [] };
  db.sql = [];
  db.transactions = [];
  db.transactionKinds = [];
  db.recordedWhere = [];
}
resetDb();

const teacherOfLecture = (lectureId) => db.tables.lectures.find((l) => l.id === lectureId)?.teacherId;

/** The fake client. Each method implements the INTENDED selection of the service's query. */
const client = {
  recordingUploadSession: {
    async findMany({ where }) {
      return db.tables.sessions.filter((s) => s.teacherId === where.teacherId && where.state.in.includes(s.state));
    },
  },
  storageReservation: {
    async groupBy({ by, where, _sum }) {
      assert.deepEqual(by, ["category"]);
      assert.deepEqual(_sum, { bytes: true });
      const live = db.tables.reservations.filter((r) => r.teacherId === where.teacherId && r.expiresAt.getTime() > where.expiresAt.gt.getTime());
      return ["NOTE", "SUBMISSION"]
        .map((category) => ({ category, rows: live.filter((r) => r.category === category) }))
        .filter((g) => g.rows.length > 0)
        .map((g) => ({ category: g.category, _sum: { bytes: g.rows.reduce((t, r) => t + r.bytes, B(0)) } }));
    },
  },
  recordedLecture: {
    async aggregate({ where, _sum }) {
      db.recordedWhere.push(where);
      assert.deepEqual(_sum, { sizeBytes: true });
      const rows = db.tables.recordings.filter(
        (r) => r.teacherId === where.teacherId && r.state === where.state && r.storedFileName !== null && (r.purgedAt ?? null) === where.purgedAt
      );
      return { _sum: { sizeBytes: rows.length ? rows.reduce((t, r) => t + r.sizeBytes, B(0)) : null } };
    },
  },
  async $queryRaw(strings, ...values) {
    db.sql.push({ text: strings.join("?"), values });
    const teacherId = values[0];
    const notes = db.tables.notes.filter((n) => n.storageKey !== null && teacherOfLecture(n.lectureId) === teacherId).reduce((t, n) => t + B(n.sizeBytes), B(0));
    const subs = db.tables.submissions
      .filter((s) => s.storageKey !== null && teacherOfLecture(db.tables.assignments.find((a) => a.id === s.assignmentId)?.lectureId) === teacherId)
      .reduce((t, s) => t + B(s.sizeBytes), B(0));
    return [{ notesBytes: notes, submissionsBytes: subs }];
  },
  teacherStorageLimit: {
    async findUnique({ where }) {
      return db.tables.limits.find((l) => l.teacherId === where.teacherId) ?? null;
    },
  },
  // Profile photos (PROFILE_IMAGE): from db.tables.profiles (none by default).
  teacherProfile: {
    async findUnique({ where, select }) {
      assert.deepEqual(select, { profileImageStorageKey: true, profileImageSizeBytes: true });
      return (db.tables.profiles ?? []).find((p) => p.teacherId === where.teacherId) ?? null;
    },
  },
  teacherSubscription: {
    async findFirst({ where, orderBy }) {
      assert.deepEqual(orderBy, { updatedAt: "desc" });
      // The ACTIVE-subscription filter (activeSubscriptionWhere): status ACTIVE, endDate null or in the future.
      assert.equal(where.status, "ACTIVE");
      const now = where.OR[1].endDate.gt;
      assert.deepEqual(where.OR[0], { endDate: null });
      const rows = db.tables.subscriptions
        .filter((s) => s.teacherId === where.teacherId && s.status === where.status && (s.endDate === null || s.endDate > now))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return rows[0] ? { plan: { storageGB: rows[0].storageGB } } : null;
    },
  },
};
fake("lib/prisma.ts", {
  prisma: {
    ...client,
    async $transaction(fn, options) {
      db.transactions.push(options);
      db.transactionKinds.push(Array.isArray(fn) ? "batch" : "interactive");
      // Batch form ($transaction([...queries], options)): the queries in order.
      if (Array.isArray(fn)) {
        const results = [];
        for (const query of fn) results.push(await query);
        return results;
      }
      return fn(client);
    },
  },
});
fake("lib/server-clock.ts", { serverNow: async () => NOW, serverNowSync: () => NOW });

const U = require(path.join(root, "lib", "storage-quota", "usage.ts"));
const { getTeacherStorageUsage } = require(path.join(root, "services", "teacher-storage-usage-service.ts"));

test.beforeEach(() => resetDb());

// ---- Seed helpers -------------------------------------------------------------------------------------

const key = (kind, teacherId, n) =>
  kind === "note"
    ? `Teachers/${teacherId}/Lectures/l/Notes/n${n}/${"a".repeat(32)}.pdf`
    : `Teachers/${teacherId}/Lectures/l/Assignments/a/Submissions/s${n}/${"b".repeat(32)}.pdf`;
function lecture(id, teacherId) {
  db.tables.lectures.push({ id, teacherId });
}
function note(lectureId, sizeBytes, { storageKey = key("note", teacherOfLecture(lectureId), db.tables.notes.length), status = 0 } = {}) {
  db.tables.notes.push({ lectureId, sizeBytes, storageKey, status });
}
function submission(assignmentId, lectureId, sizeBytes, { storageKey } = {}) {
  if (!db.tables.assignments.some((a) => a.id === assignmentId)) db.tables.assignments.push({ id: assignmentId, lectureId });
  db.tables.submissions.push({ assignmentId, sizeBytes, storageKey: storageKey === undefined ? key("sub", teacherOfLecture(lectureId), db.tables.submissions.length) : storageKey });
}
function recording(teacherId, sizeBytes, { state = "READY", storedFileName = "x.mp4", purgedAt = null, status = 0 } = {}) {
  db.tables.recordings.push({ teacherId, sizeBytes: B(sizeBytes), state, storedFileName, purgedAt, status });
}
function session(teacherId, over) {
  db.tables.sessions.push({ teacherId, state: "ACTIVE", expectedBytes: B(0), receivedBytes: B(0), leaseBytes: null, leaseExpiresAt: null, expiresAt: new Date(NOW.getTime() + 3_600_000), ...over });
}
function reservation(teacherId, category, bytes, expiresInMs) {
  db.tables.reservations.push({ teacherId, category, bytes: B(bytes), expiresAt: new Date(NOW.getTime() + expiresInMs) });
}
function plan(teacherId, storageGB, updatedAt = new Date("2026-01-01"), { status = "ACTIVE", endDate = null } = {}) {
  db.tables.subscriptions.push({ teacherId, storageGB, updatedAt, status, endDate });
}

// ==== Limit resolution ===================================================================================

test("limit: override > plan storageGB (decimal GB) > unlimited; NULL plan and no subscription are unlimited; 0 is a real limit", () => {
  const r = U.resolveEffectiveStorageLimit;
  assert.deepEqual(r({ overrideBytes: null, subscription: { planStorageGB: null } }), { limitBytes: null, source: "UNLIMITED_PLAN", overrideBytes: null, planLimitBytes: null });
  assert.deepEqual(r({ overrideBytes: null, subscription: null }), { limitBytes: null, source: "NO_ACTIVE_SUBSCRIPTION", overrideBytes: null, planLimitBytes: null });
  assert.deepEqual(r({ overrideBytes: null, subscription: { planStorageGB: 5 } }), { limitBytes: B(5_000_000_000), source: "PLAN", overrideBytes: null, planLimitBytes: B(5_000_000_000) });
  assert.deepEqual(r({ overrideBytes: B(123), subscription: { planStorageGB: 5 } }), { limitBytes: B(123), source: "OVERRIDE", overrideBytes: B(123), planLimitBytes: B(5_000_000_000) });
  assert.deepEqual(r({ overrideBytes: B(7) * GB, subscription: { planStorageGB: null } }), { limitBytes: B(7) * GB, source: "OVERRIDE", overrideBytes: B(7) * GB, planLimitBytes: null }, "override with an unlimited plan");
  assert.deepEqual(r({ overrideBytes: B(9), subscription: null }).source, "OVERRIDE", "override without a subscription");
  assert.equal(r({ overrideBytes: B(0), subscription: { planStorageGB: null } }).limitBytes, B(0), "0 is not unlimited");
  assert.equal(r({ overrideBytes: null, subscription: { planStorageGB: 0 } }).limitBytes, B(0));
  assert.equal(U.BYTES_PER_GB, B(1_000_000_000), "decimal GB, not GiB");
});

test("limit: invalid overrides / plan values are rejected, never treated as unlimited", () => {
  for (const bad of [-1, 1.5, Number.NaN, Infinity, 1_000_001]) {
    assert.throws(() => U.planStorageLimitBytes(bad), { name: "InvalidStorageLimitError" }, String(bad));
  }
  assert.equal(U.planStorageLimitBytes(1_000_000), B("1000000000000000"), "1,000,000 GB = 1 PB, the maximum");
  for (const bad of [B(-1), U.MAX_STORAGE_LIMIT_BYTES + B(1)]) assert.throws(() => U.assertValidLimitBytes(bad), { name: "InvalidStorageLimitError" });
  assert.throws(() => U.assertValidLimitBytes(5), { name: "InvalidStorageLimitError" }, "a Number is not accepted where bytes are BigInt");
});

// ==== Recorded Lecture session reservations ==============================================================

test("recording sessions: ACTIVE reserves the declared size; expired with a current lease only received + lease; COMPLETING the declared size; others 0", () => {
  const f = (over) => U.recordingSessionReservedBytes({ state: "ACTIVE", expectedBytes: B(1000), receivedBytes: B(300), leaseBytes: null, leaseExpiresAt: null, expiresAt: new Date(NOW.getTime() + 1), ...over }, NOW.getTime());
  assert.equal(f({}), B(1000));
  assert.equal(f({ expiresAt: NOW }), B(0), "expiry is <= now (same as expireStaleUploads)");
  assert.equal(f({ expiresAt: NOW, leaseBytes: 200, leaseExpiresAt: new Date(NOW.getTime() + 1) }), B(500));
  assert.equal(f({ expiresAt: NOW, leaseBytes: 200, leaseExpiresAt: NOW }), B(0), "a lease expiring now is not current");
  assert.equal(f({ state: "COMPLETING", expiresAt: new Date(0) }), B(1000), "COMPLETING ignores the upload expiry");
  for (const state of ["COMPLETED", "CANCELLED", "EXPIRED", "FAILED"]) assert.equal(f({ state }), B(0), state);
});

test("recording sessions: the same totals as Recorded Lectures' own reservationRows (no drift between the two rules)", async () => {
  fake("lib/recorded-lectures/storage.ts", { openRecordedLectureStorage: async () => ({ ok: false }) });
  fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });
  fake("lib/session-events.ts", { emitStudentDataChange: () => {} });
  const { reservationRows } = require(path.join(root, "services", "recorded-lecture-upload-service.ts"));
  const now = NOW.getTime();
  const cases = [];
  for (const state of ["ACTIVE", "COMPLETING"]) {
    for (const expired of [false, true]) {
      for (const lease of [null, "current", "past"]) {
        cases.push({
          state,
          expectedBytes: B(10_000),
          receivedBytes: B(4_000),
          leaseBytes: lease ? 2_000 : null,
          leaseExpiresAt: lease === "current" ? new Date(now + 5_000) : lease === "past" ? new Date(now - 5_000) : null,
          expiresAt: new Date(expired ? now - 1 : now + 60_000),
        });
      }
    }
  }
  const tx = { recordingUploadSession: { findMany: async () => cases } };
  const rows = await reservationRows(tx, NOW);
  const theirs = rows.reduce((t, r) => t + B(r.expectedBytes), B(0));
  const ours = cases.reduce((t, c) => t + U.recordingSessionReservedBytes(c, now), B(0));
  assert.equal(ours, theirs);
});

// ==== Usage summary =======================================================================================

test("summary: exact totals, remaining, percentage, over-quota and fits-within decisions", () => {
  const usage = U.summarizeTeacherStorageUsage({
    teacherId: T1,
    measuredAt: NOW,
    committed: { recordedLectures: B(600), notes: B(150), submissions: B(50), profileImages: B(0) },
    reserved: { recordedLectures: B(100), notes: B(25), submissions: B(0), profileImages: B(0) },
    limit: U.resolveEffectiveStorageLimit({ overrideBytes: B(1000), subscription: null }),
  });
  assert.equal(usage.committed.total, B(800));
  assert.equal(usage.reserved.total, B(125));
  assert.equal(usage.totalUsedAndReservedBytes, B(925));
  assert.equal(usage.remainingBytes, B(75));
  assert.equal(usage.usagePercent, 92.5);
  assert.equal(usage.isOverQuota, false);
  assert.equal(usage.overQuotaBytes, B(0));
  assert.equal(U.fitsWithinStorageLimit(usage, B(75)), true, "exactly up to the limit");
  assert.equal(U.fitsWithinStorageLimit(usage, B(76)), false, "one byte over");

  const reduced = U.summarizeTeacherStorageUsage({ ...usage, committed: { recordedLectures: B(600), notes: B(150), submissions: B(50), profileImages: B(0) }, reserved: { recordedLectures: B(0), notes: B(0), submissions: B(0), profileImages: B(0) }, limit: U.resolveEffectiveStorageLimit({ overrideBytes: B(500), subscription: null }) });
  assert.equal(reduced.isOverQuota, true, "a limit reduced below existing usage");
  assert.equal(reduced.overQuotaBytes, B(300));
  assert.equal(reduced.remainingBytes, B(0));
  assert.equal(reduced.usagePercent, 160);

  // Committed under the limit, committed + reserved over it: not "over quota", but nothing remains.
  const reservedOver = U.summarizeTeacherStorageUsage({
    ...usage,
    committed: { recordedLectures: B(900), notes: B(0), submissions: B(0), profileImages: B(0) },
    reserved: { recordedLectures: B(0), notes: B(200), submissions: B(0), profileImages: B(0) },
    limit: U.resolveEffectiveStorageLimit({ overrideBytes: B(1000), subscription: null }),
  });
  assert.deepEqual([reservedOver.isOverQuota, reservedOver.overQuotaBytes, reservedOver.remainingBytes, reservedOver.usagePercent], [false, B(0), B(0), 110]);
  assert.equal(U.fitsWithinStorageLimit(reservedOver, B(1)), false);

  const unlimited = U.summarizeTeacherStorageUsage({ ...usage, limit: U.resolveEffectiveStorageLimit({ overrideBytes: null, subscription: { planStorageGB: null } }) });
  assert.deepEqual([unlimited.isUnlimited, unlimited.remainingBytes, unlimited.usagePercent, unlimited.isOverQuota, unlimited.overQuotaBytes], [true, null, null, false, null]);
  assert.equal(U.fitsWithinStorageLimit(unlimited, B("999999999999999999")), true);

  const zero = U.summarizeTeacherStorageUsage({ ...usage, committed: { recordedLectures: B(0), notes: B(0), submissions: B(0), profileImages: B(0) }, reserved: { recordedLectures: B(0), notes: B(0), submissions: B(0), profileImages: B(0) }, limit: U.resolveEffectiveStorageLimit({ overrideBytes: B(0), subscription: null }) });
  assert.deepEqual([zero.isUnlimited, zero.remainingBytes, zero.usagePercent, zero.isOverQuota], [false, B(0), null, false]);
  assert.equal(U.fitsWithinStorageLimit(zero, B(1)), false, "a 0 limit allows nothing");
  assert.equal(U.fitsWithinStorageLimit(zero, B(0)), true);
});

test("summary: BigInt beyond Number.MAX_SAFE_INTEGER stays exact; serialization uses decimal strings (no BigInt in JSON)", () => {
  const big = B(Number.MAX_SAFE_INTEGER) + B(10);
  const usage = U.summarizeTeacherStorageUsage({
    teacherId: T1,
    measuredAt: NOW,
    committed: { recordedLectures: big, notes: B(1), submissions: B(1), profileImages: B(0) },
    reserved: { recordedLectures: B(0), notes: B(0), submissions: B(1), profileImages: B(0) },
    limit: U.resolveEffectiveStorageLimit({ overrideBytes: null, subscription: null }),
  });
  assert.equal(usage.committed.total, B("9007199254741003"));
  assert.equal(usage.totalUsedAndReservedBytes, B("9007199254741004"));
  const json = JSON.stringify(U.serializeTeacherStorageUsage(usage));
  const parsed = JSON.parse(json);
  assert.equal(parsed.committedBytes.recordedLectures, "9007199254741001");
  assert.equal(parsed.totalUsedAndReservedBytes, "9007199254741004");
  assert.equal(BigInt(parsed.committedBytes.total), B("9007199254741003"), "round-trips exactly");
  assert.equal(parsed.limit.limitBytes, null);
  assert.equal(parsed.measuredAt, NOW.toISOString());
  assert.throws(() => JSON.stringify(usage), TypeError, "the raw usage object is never sent as JSON");
  assert.throws(() => U.summarizeTeacherStorageUsage({ ...usage, committed: { recordedLectures: B(-1), notes: B(0), submissions: B(0), profileImages: B(0) } }));
});

// ==== getTeacherStorageUsage ================================================================================

function seedTeacher(t) {
  lecture(`lec-${t}`, t);
  return `lec-${t}`;
}

test("usage: the three categories, exact bytes; soft-deleted notes still count; legacy rows (no storageKey) excluded", async () => {
  const l = seedTeacher(T1);
  note(l, 1000);
  note(l, 2000, { status: 1 }); // soft-deleted: its file still exists
  note(l, 999_999, { storageKey: null }); // legacy row: excluded
  submission("a1", l, 300);
  submission("a1", l, 400);
  submission("a1", l, 777_777, { storageKey: null }); // legacy
  recording(T1, 5_000_000_000);
  recording(T1, 7, { status: 2 }); // deleted by the teacher, file not yet purged: counts
  const usage = await getTeacherStorageUsage(T1);
  assert.deepEqual(usage.committed, { recordedLectures: B(5_000_000_007), notes: B(3000), submissions: B(700), profileImages: B(0), total: B(5_000_003_707) });
  assert.deepEqual(usage.reserved, { recordedLectures: B(0), notes: B(0), submissions: B(0), profileImages: B(0), total: B(0) });
  assert.equal(usage.measuredAt, NOW, "database time (serverNow)");
});

test("usage (3.6 / 3.7 lifecycle): pending deletions still count until finalized; finalized rows and purged recordings do not", async () => {
  const l = seedTeacher(T1);
  note(l, 1000); // normal
  note(l, 2000, { status: 2 }); // pending permanent deletion: its file may still exist
  submission("a-pending", l, 300); // a submission of an assignment pending deletion (row not yet finalized)
  recording(T1, 40, { status: 2 }); // pending purge
  recording(T1, 50, { status: 1, purgedAt: new Date("2026-11-01") }); // purged
  let usage = await getTeacherStorageUsage(T1);
  assert.deepEqual(usage.committed, { recordedLectures: B(40), notes: B(3000), submissions: B(300), profileImages: B(0), total: B(3340) });
  // Finalize: the rows are deleted (Note, submission) / the recording purged.
  db.tables.notes.splice(1, 1);
  db.tables.submissions.length = 0;
  db.tables.recordings[0].purgedAt = new Date("2026-11-02");
  usage = await getTeacherStorageUsage(T1);
  assert.deepEqual(usage.committed, { recordedLectures: B(0), notes: B(1000), submissions: B(0), profileImages: B(0), total: B(1000) });
});

test("usage: recordings - only READY with a stored file and not purged; never counted twice with their session", async () => {
  seedTeacher(T1);
  recording(T1, 100); // READY
  recording(T1, 200, { state: "VERIFYING" }); // its session is COMPLETING: reserved, not committed
  session(T1, { state: "COMPLETING", expectedBytes: B(200) });
  recording(T1, 300, { state: "UPLOADING" }); // its session is ACTIVE
  session(T1, { state: "ACTIVE", expectedBytes: B(300), receivedBytes: B(120) });
  recording(T1, 400, { state: "FAILED" }); // never counted
  recording(T1, 500, { purgedAt: new Date("2026-11-01") }); // purged: file removed
  recording(T1, 600, { storedFileName: null }); // no stored file reference
  session(T1, { state: "COMPLETED", expectedBytes: B(100) }); // the READY one's session: not reserved
  session(T1, { state: "CANCELLED", expectedBytes: B(9999) });
  const usage = await getTeacherStorageUsage(T1);
  assert.equal(usage.committed.recordedLectures, B(100));
  assert.equal(usage.reserved.recordedLectures, B(500), "200 (COMPLETING) + 300 (ACTIVE, the full declared size)");
  assert.deepEqual(db.recordedWhere[0], { teacherId: T1, state: "READY", storedFileName: { not: null }, purgedAt: null });
});

test("usage: expired sessions without a current lease reserve nothing; with a current lease, received + lease", async () => {
  seedTeacher(T1);
  session(T1, { expectedBytes: B(10_000), receivedBytes: B(4_000), expiresAt: new Date(NOW.getTime() - 1) });
  session(T1, { expectedBytes: B(10_000), receivedBytes: B(4_000), expiresAt: new Date(NOW.getTime() - 1), leaseBytes: 1_000, leaseExpiresAt: new Date(NOW.getTime() + 30_000) });
  const usage = await getTeacherStorageUsage(T1);
  assert.equal(usage.reserved.recordedLectures, B(5_000));
});

test("usage: Notes / submission reservations count until they expire (database time), per category", async () => {
  seedTeacher(T1);
  reservation(T1, "NOTE", 111, 60_000);
  reservation(T1, "NOTE", 222, 1);
  reservation(T1, "NOTE", 999, 0); // expires exactly now: excluded
  reservation(T1, "SUBMISSION", 333, 60_000);
  reservation(T1, "SUBMISSION", 888, -60_000); // expired
  const usage = await getTeacherStorageUsage(T1);
  assert.equal(usage.reserved.notes, B(333));
  assert.equal(usage.reserved.submissions, B(333));
  assert.equal(usage.reserved.total, B(666));
});

test("usage: two teachers are independent (rows, sessions, reservations, limits)", async () => {
  const l1 = seedTeacher(T1);
  const l2 = seedTeacher(T2);
  note(l1, 10);
  note(l2, 20);
  submission("a1", l1, 1);
  submission("a2", l2, 2);
  recording(T1, 100);
  recording(T2, 200);
  session(T2, { expectedBytes: B(50) });
  reservation(T2, "NOTE", 5, 60_000);
  db.tables.limits.push({ teacherId: T2, limitBytes: B(1000) });
  plan(T1, 3);
  const [a, b] = [await getTeacherStorageUsage(T1), await getTeacherStorageUsage(T2)];
  assert.deepEqual([a.committed.total, a.reserved.total, a.limit.source, a.limit.limitBytes], [B(111), B(0), "PLAN", B(3_000_000_000)]);
  assert.deepEqual([b.committed.total, b.reserved.total, b.limit.source, b.limit.limitBytes], [B(222), B(55), "OVERRIDE", B(1000)]);
});

test("usage: the effective limit comes from the override, else the latest ACTIVE subscription's plan, else unlimited", async () => {
  seedTeacher(T1);
  assert.equal((await getTeacherStorageUsage(T1)).limit.source, "NO_ACTIVE_SUBSCRIPTION");
  plan(T1, null, new Date("2026-01-01"));
  assert.equal((await getTeacherStorageUsage(T1)).limit.source, "UNLIMITED_PLAN");
  plan(T1, 2, new Date("2026-06-01")); // the latest subscription
  plan(T1, 50, new Date("2026-03-01"));
  const viaPlan = await getTeacherStorageUsage(T1);
  assert.deepEqual([viaPlan.limit.source, viaPlan.limit.limitBytes], ["PLAN", B(2_000_000_000)]);
  db.tables.limits.push({ teacherId: T1, limitBytes: B(10) * GB });
  const viaOverride = await getTeacherStorageUsage(T1);
  assert.deepEqual([viaOverride.limit.source, viaOverride.limit.limitBytes, viaOverride.limit.planLimitBytes], ["OVERRIDE", B(10) * GB, B(2) * GB]);
});

test("usage (3.2): cancelled, expired, suspended and ended subscriptions never supply the plan limit; the override still applies", async () => {
  seedTeacher(T1);
  plan(T1, 1, new Date("2026-09-01"), { status: "CANCELLED" });
  plan(T1, 2, new Date("2026-09-02"), { status: "EXPIRED" });
  plan(T1, 3, new Date("2026-09-03"), { status: "SUSPENDED" });
  plan(T1, 4, new Date("2026-09-04"), { status: "ACTIVE", endDate: new Date(NOW.getTime() - 1) }); // ended
  let usage = await getTeacherStorageUsage(T1);
  assert.deepEqual([usage.limit.source, usage.limit.limitBytes], ["NO_ACTIVE_SUBSCRIPTION", null], "no active plan: unlimited");

  plan(T1, 5, new Date("2026-01-01"), { status: "ACTIVE", endDate: new Date(NOW.getTime() + 86_400_000) }); // older but active
  usage = await getTeacherStorageUsage(T1);
  assert.deepEqual([usage.limit.source, usage.limit.limitBytes], ["PLAN", B(5) * GB], "an older ACTIVE subscription wins over newer inactive ones");

  db.tables.limits.push({ teacherId: T1, limitBytes: B(123) });
  db.tables.subscriptions = db.tables.subscriptions.filter((s) => s.status !== "ACTIVE");
  usage = await getTeacherStorageUsage(T1);
  assert.deepEqual([usage.limit.source, usage.limit.limitBytes, usage.limit.planLimitBytes], ["OVERRIDE", B(123), null], "the override applies regardless of subscription status");
});

test("usage: one REPEATABLE READ snapshot by default; a caller's transaction is used as given", async () => {
  seedTeacher(T1);
  await getTeacherStorageUsage(T1);
  assert.deepEqual(db.transactions, [{ isolationLevel: "RepeatableRead" }]);
  db.transactions = [];
  await getTeacherStorageUsage(T1, { db: client, now: new Date("2030-01-01") });
  assert.deepEqual(db.transactions, [], "no nested transaction");
});

test("usage SQL: BIGINT sums, storageKey required, teacher through Lecture -> Class (and Assignment), no status filter, parameterised", async () => {
  seedTeacher(T1);
  await getTeacherStorageUsage(T1);
  const { text, values } = db.sql[0];
  assert.deepEqual(values, [T1, T1], "the teacher id is a bound parameter, never interpolated");
  const sqlText = text.replace(/\s+/g, " ");
  assert.equal((sqlText.match(/COALESCE\(SUM\([ns]\."sizeBytes"\), 0\)::bigint/g) ?? []).length, 2);
  assert.match(sqlText, /FROM "Note" n JOIN "Lecture" l ON l\."id" = n\."lectureId" JOIN "Class" c ON c\."id" = l\."classId" WHERE c\."teacherId" = \? AND n\."storageKey" IS NOT NULL/);
  assert.match(sqlText, /FROM "AssignmentSubmission" s JOIN "Assignment" a ON a\."id" = s\."assignmentId" JOIN "Lecture" l ON l\."id" = a\."lectureId" JOIN "Class" c ON c\."id" = l\."classId" WHERE c\."teacherId" = \? AND s\."storageKey" IS NOT NULL/);
  assert.doesNotMatch(sqlText, /"status"|"fileUrl"/, "soft-deleted rows count; the legacy fileUrl (rollback copies) is never used");
});

test("source: accounting never touches the filesystem, legacy storage or System/ (database rows only)", () => {
  const fs = require("node:fs");
  for (const p of [["services", "teacher-storage-usage-service.ts"], ["lib", "storage-quota", "usage.ts"], ["lib", "storage-quota", "locks.ts"]]) {
    const src = fs.readFileSync(path.join(root, ...p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /node:fs|readdir|listDirectory|stat\(|process\.cwd|TemporaryUploads|fileUrl/, p.join("/"));
  }
});
