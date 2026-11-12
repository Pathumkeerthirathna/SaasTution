/*
 * Stage 5.4c: read-only, paginated attendance history
 * (services/lecture-attendance-history-service.ts).
 *
 *   npm run test:attendance-history
 *
 * No database: the real service runs through tsx against a read-only Prisma
 * double (find* only, honouring where / version > cursor / orderBy / take)
 * that throws on ANY other call, so a write, a transaction, raw SQL or a lock
 * would fail the test.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

let currentPrisma = null;
{
  const filename = path.join(root, "lib/prisma.ts");
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = { prisma: new Proxy({}, { get: (_, key) => currentPrisma[key] }) };
  require.cache[filename] = mod;
}

const history = require(path.join(root, "services", "lecture-attendance-history-service.ts"));

// ---- Data ------------------------------------------------------------------------------

const T1 = "teacher-1";
const T2 = "teacher-2";
const L1 = "lecture-1";
const t = (minute) => new Date(Date.UTC(2026, 8, 1, 12, minute));

function baseData() {
  return {
    lectures: [
      { id: L1, status: 0, classId: "class-1", teacherId: T1 },
      { id: "lecture-deleted", status: 1, classId: "class-1", teacherId: T1 },
      { id: "lecture-empty", status: 0, classId: "class-1", teacherId: T1 },
      { id: "lecture-other", status: 0, classId: "class-2", teacherId: T2 },
    ],
    students: [
      { id: "s1", teacherId: T1 },
      { id: "s2", teacherId: T1 },
      { id: "s-other", teacherId: T2 },
    ],
    registers: [{ lectureId: L1, classId: "class-1", version: 4 }],
    closures: [{ lectureId: L1, classId: "class-1", closedAt: t(90), closedByTeacherId: T1 }],
    // Deliberately stored out of order.
    registerAudits: [
      { id: "ra-4", lectureId: L1, version: 4, action: "FINALIZED", createdAt: t(20), actorRole: "TEACHER", actorId: T1, reason: null, // same createdAt as v3
        fromGraceMinutes: null, toGraceMinutes: null, fromScheduledStartAt: null, toScheduledStartAt: null, fromScheduledEndAt: null, toScheduledEndAt: null,
        finalizedAt: t(150), eligibleCount: 3, unknownEligibilityCount: 1, absentCreatedCount: 2, recalculatedCount: null },
      { id: "ra-3", lectureId: L1, version: 3, action: "SCHEDULE_SYNCED", createdAt: t(20), actorRole: "TEACHER", actorId: T1, reason: null,
        fromGraceMinutes: null, toGraceMinutes: null, fromScheduledStartAt: t(0), toScheduledStartAt: t(30), fromScheduledEndAt: null, toScheduledEndAt: null,
        finalizedAt: null, eligibleCount: null, unknownEligibilityCount: null, absentCreatedCount: null, recalculatedCount: 2 },
      { id: "ra-1", lectureId: L1, version: 1, action: "CREATED", createdAt: t(0), actorRole: "SYSTEM", actorId: null, reason: null,
        fromGraceMinutes: null, toGraceMinutes: 10, fromScheduledStartAt: null, toScheduledStartAt: t(0), fromScheduledEndAt: null, toScheduledEndAt: t(120),
        finalizedAt: null, eligibleCount: null, unknownEligibilityCount: null, absentCreatedCount: null, recalculatedCount: null },
      { id: "ra-2", lectureId: L1, version: 2, action: "GRACE_CHANGED", createdAt: t(5), actorRole: "TEACHER", actorId: T1, reason: "Bus strike",
        fromGraceMinutes: 10, toGraceMinutes: 20, fromScheduledStartAt: null, toScheduledStartAt: null, fromScheduledEndAt: null, toScheduledEndAt: null,
        finalizedAt: null, eligibleCount: null, unknownEligibilityCount: null, absentCreatedCount: null, recalculatedCount: 1 },
      { id: "ra-x", lectureId: "lecture-other", version: 1, action: "CREATED", createdAt: t(0), actorRole: "SYSTEM", actorId: null, reason: null,
        fromGraceMinutes: null, toGraceMinutes: 10, fromScheduledStartAt: null, toScheduledStartAt: t(0), fromScheduledEndAt: null, toScheduledEndAt: null,
        finalizedAt: null, eligibleCount: null, unknownEligibilityCount: null, absentCreatedCount: null, recalculatedCount: null },
    ],
    records: [{ id: "rec-s1", lectureId: L1, studentId: "s1", status: "PRESENT", statusSource: "TEACHER", version: 7, pendingReviewSince: null }],
    recordAudits: [],
  };
}

const STATUSES = ["ABSENT", "PRESENT", "LATE", "PRESENT", "PRESENT", "PRESENT", "PRESENT"];
function addRecordAudits(data) {
  const make = (version, extra) => ({
    id: `aa-${version}`, lectureAttendanceId: "rec-s1", lectureId: L1, studentId: "s1", version, createdAt: t(version),
    actorRole: "SYSTEM", actorId: null, reason: null, afterFinalization: false,
    fromStatus: version === 1 ? null : STATUSES[version - 2], toStatus: STATUSES[version - 1],
    fromTeacherStatus: null, toTeacherStatus: null, fromAutoStatus: null, toAutoStatus: null,
    scanEventId: null, attendanceVisitId: null, registerAuditId: null, ...extra,
  });
  data.recordAudits = [
    make(6, { action: "EVIDENCE_RECORDED", createdAt: t(4) }), // EARLIER createdAt than v5 (clock skew): version decides
    make(5, { action: "EVIDENCE_ACCEPTED", actorRole: "TEACHER", actorId: T1, reason: "Seen in class", toTeacherStatus: "PRESENT", afterFinalization: true }),
    make(1, { action: "TEACHER_SET", actorRole: "TEACHER", actorId: T1, toTeacherStatus: "ABSENT" }),
    make(3, { action: "AUTO_RECALCULATED", registerAuditId: "ra-2" }),
    make(2, { action: "EVIDENCE_RECORDED", scanEventId: "scan-secret-id", fromAutoStatus: null, toAutoStatus: "PRESENT" }),
    make(4, { action: "EVIDENCE_RECORDED", attendanceVisitId: "visit-1" }),
    make(7, { action: "EVIDENCE_DISMISSED", actorRole: "TEACHER", actorId: T1 }),
    { ...make(1, { action: "TEACHER_SET", actorRole: "TEACHER", actorId: T1 }), id: "aa-other", lectureAttendanceId: "rec-other" },
  ];
}

// ---- Read-only Prisma double ---------------------------------------------------------------

let calls;

function pick(row, select) {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && !(value instanceof Date) && "gt" in value) return row[key] > value.gt;
    return row[key] === value;
  });
}

function findMany(rows, { where, orderBy, take, select }) {
  let out = rows.filter((r) => matches(r, where));
  if (orderBy) {
    const [[key, dir]] = Object.entries(orderBy);
    out = out.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (dir === "desc" ? -1 : 1));
  }
  if (take !== undefined) out = out.slice(0, take);
  return out.map((r) => pick(r, select));
}

function install(data) {
  calls = [];
  const models = {
    lecture: {
      findFirst: async ({ where, select }) => {
        const l = data.lectures.find((x) => x.id === where.id && x.status === where.status && x.teacherId === where.class.teacherId);
        return l ? pick(l, select) : null;
      },
    },
    student: {
      findFirst: async ({ where, select }) => {
        const s = data.students.find((x) => x.id === where.id && x.teacherId === where.teacherId);
        return s ? pick(s, select) : null;
      },
    },
    lectureAttendanceRegister: {
      findUnique: async ({ where, select }) => {
        const r = data.registers.find((x) => x.lectureId === where.lectureId);
        return r ? pick(r, select) : null;
      },
    },
    lectureQrAttendanceClosure: {
      findUnique: async ({ where, select }) => {
        const c = data.closures.find((x) => x.lectureId === where.lectureId);
        return c ? pick(c, select) : null;
      },
    },
    lectureAttendanceRegisterAuditLog: { findMany: async (args) => findMany(data.registerAudits, args) },
    lectureAttendance: {
      findUnique: async ({ where, select }) => {
        const { lectureId, studentId } = where.lectureId_studentId;
        const r = data.records.find((x) => x.lectureId === lectureId && x.studentId === studentId);
        return r ? pick(r, select) : null;
      },
    },
    attendanceAuditLog: { findMany: async (args) => findMany(data.recordAudits, args) },
  };
  const READ = new Set(["findFirst", "findUnique", "findMany"]);
  currentPrisma = new Proxy({}, {
    get(_, model) {
      if (typeof model !== "string" || !(model in models)) throw new Error(`history touched prisma.${String(model)}`);
      return new Proxy(models[model], {
        get(target, method) {
          if (!READ.has(method) || !(method in target)) throw new Error(`WRITE OR UNKNOWN CALL: ${model}.${String(method)}`);
          return (...args) => {
            calls.push(`${model}.${method}`);
            return target[method](...args);
          };
        },
      });
    },
  });
}

async function allPages(fetchPage, limit) {
  const versions = [];
  const cursors = [];
  let cursor = null;
  for (let i = 0; i < 100; i += 1) {
    const result = await fetchPage({ cursor, limit });
    assert.ok(result.entries.length <= limit);
    versions.push(...result.entries.map((e) => e.version));
    cursors.push(result.nextCursor);
    if (result.nextCursor === null) return { versions, cursors };
    cursor = result.nextCursor;
  }
  throw new Error("pagination did not end");
}

// ---- Register history ----------------------------------------------------------------------

test("register history: oldest first by version (stable even with equal timestamps); sanitized entries", async () => {
  const data = baseData();
  install(data);
  const result = await history.getRegisterHistory(T1, L1);

  assert.deepEqual(result.entries.map((e) => [e.version, e.action]), [[1, "CREATED"], [2, "GRACE_CHANGED"], [3, "SCHEDULE_SYNCED"], [4, "FINALIZED"]]);
  assert.equal(result.registerExists, true);
  assert.equal(result.registerVersion, 4);
  assert.equal(result.nextCursor, null);
  assert.deepEqual(result.qrClosure, { closedAt: t(90), actor: { role: "TEACHER", teacherId: T1 } });

  const [created, grace, synced, finalized] = result.entries;
  assert.deepEqual(created.actor, { role: "SYSTEM", teacherId: null });
  assert.deepEqual(created.graceMinutes, { from: null, to: 10 });
  assert.deepEqual(grace, {
    version: 2, action: "GRACE_CHANGED", at: t(5), actor: { role: "TEACHER", teacherId: T1 }, reason: "Bus strike",
    graceMinutes: { from: 10, to: 20 }, scheduledStartAt: null, scheduledEndAt: null, finalization: null, recalculatedCount: 1,
  });
  assert.deepEqual(synced.scheduledStartAt, { from: t(0), to: t(30) });
  assert.deepEqual(finalized.finalization, { finalizedAt: t(150), eligibleCount: 3, unknownEligibilityCount: 1, absentCreatedCount: 2 });

  // Nothing internal: no row ids, no other lecture's rows.
  for (const entry of result.entries) {
    for (const key of ["id", "lectureId", "actorId", "actorRole"]) assert.equal(key in entry, false, key);
  }
  assert.ok(!JSON.stringify(result).includes("ra-"));
});

test("register history: pagination returns every entry exactly once, for every page size", async () => {
  const data = baseData();
  install(data);
  for (const limit of [1, 2, 3, 4, 5, 100]) {
    const { versions, cursors } = await allPages((page) => history.getRegisterHistory(T1, L1, page), limit);
    assert.deepEqual(versions, [1, 2, 3, 4], `limit ${limit}`);
    assert.equal(cursors.at(-1), null);
  }
  // An exact multiple ends without an empty extra page.
  const first = await history.getRegisterHistory(T1, L1, { limit: 2 });
  assert.deepEqual([first.entries.length, first.nextCursor], [2, "2"]);
  const second = await history.getRegisterHistory(T1, L1, { cursor: "2", limit: 2 });
  assert.deepEqual([second.entries.map((e) => e.version), second.nextCursor], [[3, 4], null]);
  // A cursor past the end is simply empty.
  assert.deepEqual((await history.getRegisterHistory(T1, L1, { cursor: "999" })).entries, []);
});

test("register history: no register yet is an empty, read-only answer (nothing created)", async () => {
  const data = baseData();
  install(data);
  const result = await history.getRegisterHistory(T1, "lecture-empty");
  assert.deepEqual(result, { lectureId: "lecture-empty", registerExists: false, registerVersion: 0, qrClosure: null, entries: [], nextCursor: null });
  assert.ok(!calls.includes("lectureAttendanceRegisterAuditLog.findMany"));
});

test("register history: a register with no audit rows yields an empty page", async () => {
  const data = baseData();
  data.registerAudits = [];
  install(data);
  const result = await history.getRegisterHistory(T1, L1);
  assert.deepEqual([result.registerExists, result.entries, result.nextCursor], [true, [], null]);
});

// ---- Student history ---------------------------------------------------------------------

test("student history: oldest first by version; causes mapped; ids never exposed", async () => {
  const data = baseData();
  addRecordAudits(data);
  install(data);
  const result = await history.getStudentAttendanceHistory(T1, L1, "s1");

  assert.deepEqual(result.entries.map((e) => e.version), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(result.entries.map((e) => e.cause), [null, "QR_SCAN", "REGISTER_CHANGE", "ONLINE_VISIT", null, null, null]);
  assert.deepEqual(result.record, { status: "PRESENT", statusSource: "TEACHER", version: 7, pendingReview: false });
  assert.equal(result.recordExists, true);

  const accepted = result.entries[4];
  assert.deepEqual(accepted, {
    version: 5, action: "EVIDENCE_ACCEPTED", at: t(5), actor: { role: "TEACHER", teacherId: T1 }, reason: "Seen in class", afterFinalization: true,
    status: { from: "PRESENT", to: "PRESENT" }, teacherStatus: { from: null, to: "PRESENT" }, autoStatus: { from: null, to: null }, cause: null,
  });
  assert.deepEqual(result.entries[1].autoStatus, { from: null, to: "PRESENT" });
  // Chronology: each entry's "from" status is the previous entry's "to".
  result.entries.slice(1).forEach((entry, i) => assert.equal(entry.status.from, result.entries[i].status.to));

  const json = JSON.stringify(result);
  for (const secret of ["scan-secret-id", "visit-1", "ra-2", "aa-", "rec-s1"]) assert.ok(!json.includes(secret), secret);
  for (const entry of result.entries) {
    for (const key of ["id", "lectureAttendanceId", "scanEventId", "attendanceVisitId", "registerAuditId", "studentId", "lectureId"]) {
      assert.equal(key in entry, false, key);
    }
  }
});

test("student history: pagination without duplicates or gaps", async () => {
  const data = baseData();
  addRecordAudits(data);
  install(data);
  for (const limit of [1, 2, 3, 6, 7, 50]) {
    const { versions } = await allPages((page) => history.getStudentAttendanceHistory(T1, L1, "s1", page), limit);
    assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7], `limit ${limit}`);
  }
  // Default and maximum page sizes.
  assert.equal(history.HISTORY_DEFAULT_LIMIT, 50);
  assert.equal(history.HISTORY_MAX_LIMIT, 100);
  const last = await history.getStudentAttendanceHistory(T1, L1, "s1", { cursor: "6", limit: 100 });
  assert.deepEqual([last.entries.map((e) => e.version), last.nextCursor], [[7], null]);
});

test("student history: no record is an empty answer; another teacher's student is 404", async () => {
  const data = baseData();
  install(data);
  assert.deepEqual(await history.getStudentAttendanceHistory(T1, L1, "s2"), {
    lectureId: L1, studentId: "s2", recordExists: false, record: null, entries: [], nextCursor: null,
  });
  await assert.rejects(history.getStudentAttendanceHistory(T1, L1, "s-other"), (e) => e.code === "STUDENT_NOT_FOUND" && e.statusCode === 404);
  await assert.rejects(history.getStudentAttendanceHistory(T1, L1, "missing"), (e) => e.code === "STUDENT_NOT_FOUND");
});

// ---- Authorization and validation -------------------------------------------------------------

test("wrong teacher, deleted or missing lecture: 404 LECTURE_NOT_FOUND, before any history is read", async () => {
  const data = baseData();
  addRecordAudits(data);
  install(data);
  for (const [teacherId, lectureId] of [[T2, L1], [T1, "lecture-deleted"], [T1, "missing"], [T1, "lecture-other"]]) {
    calls = [];
    await assert.rejects(history.getRegisterHistory(teacherId, lectureId), (e) => e.code === "LECTURE_NOT_FOUND" && e.statusCode === 404);
    await assert.rejects(history.getStudentAttendanceHistory(teacherId, lectureId, "s1"), (e) => e.code === "LECTURE_NOT_FOUND");
    assert.deepEqual(calls, ["lecture.findFirst", "lecture.findFirst"], "nothing else read");
  }
});

test("invalid pagination parameters and ids: 400 VALIDATION_ERROR, nothing read", async () => {
  install(baseData());
  const bad = [
    [{ limit: 0 }, "limit"], [{ limit: 101 }, "limit"], [{ limit: 1.5 }, "limit"], [{ limit: -3 }, "limit"],
    [{ limit: "10" }, "limit"], [{ limit: Number.NaN }, "limit"],
    [{ cursor: "" }, "cursor"], [{ cursor: "abc" }, "cursor"], [{ cursor: "-1" }, "cursor"], [{ cursor: "0" }, "cursor"],
    [{ cursor: "01" }, "cursor"], [{ cursor: "1.5" }, "cursor"], [{ cursor: "1e3" }, "cursor"], [{ cursor: 5 }, "cursor"],
    [{ cursor: "1234567890" }, "cursor"],
  ];
  for (const [input, field] of bad) {
    calls = [];
    await assert.rejects(history.getRegisterHistory(T1, L1, input), (e) => e.code === "VALIDATION_ERROR" && e.statusCode === 400 && e.details.field === field, JSON.stringify(input));
    await assert.rejects(history.getStudentAttendanceHistory(T1, L1, "s1", input), (e) => e.code === "VALIDATION_ERROR", JSON.stringify(input));
    assert.deepEqual(calls, []);
  }
  for (const [a, b, c] of [["", L1, "s1"], [T1, "", "s1"], [T1, L1, ""], [T1, L1, "x".repeat(192)]]) {
    await assert.rejects(history.getStudentAttendanceHistory(a, b, c), (e) => e.code === "VALIDATION_ERROR");
  }
  // null / undefined mean "first page, default size".
  assert.equal((await history.getRegisterHistory(T1, L1, { cursor: null, limit: null })).entries.length, 4);
});

// ---- Read-only and immutable -------------------------------------------------------------------

test("GET operations make no writes, transactions, raw SQL or locks (any such call would throw)", async () => {
  const data = baseData();
  addRecordAudits(data);
  install(data);
  await history.getRegisterHistory(T1, L1, { limit: 2 });
  await history.getRegisterHistory(T1, "lecture-empty");
  await history.getStudentAttendanceHistory(T1, L1, "s1", { limit: 3 });
  await history.getStudentAttendanceHistory(T1, L1, "s2");
  assert.ok(calls.every((c) => /\.(findFirst|findUnique|findMany)$/.test(c)), calls.join());

  const source = fs.readFileSync(path.join(root, "services", "lecture-attendance-history-service.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(source, /\$transaction|\$queryRaw|\$executeRaw|runAttendanceTransaction|lock[A-Z]|ensureRegister|\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  assert.doesNotMatch(source, /process\.env|new Date\(/, "no configuration, no clock");
});

test("audit information stays immutable: responses are copies, stored rows never change", async () => {
  const data = baseData();
  addRecordAudits(data);
  const snapshot = JSON.stringify([data.registerAudits, data.recordAudits, data.closures]);
  install(data);

  const register = await history.getRegisterHistory(T1, L1);
  const student = await history.getStudentAttendanceHistory(T1, L1, "s1");
  register.entries[0].action = "TAMPERED";
  register.entries[1].graceMinutes.to = 999;
  student.entries[0].status.to = "EXCUSED";
  student.entries[0].actor.teacherId = "someone-else";

  assert.equal(JSON.stringify([data.registerAudits, data.recordAudits, data.closures]), snapshot);
  const again = await history.getStudentAttendanceHistory(T1, L1, "s1");
  assert.equal(again.entries[0].status.to, "ABSENT");
  assert.equal(again.entries[0].actor.teacherId, T1);
  assert.equal((await history.getRegisterHistory(T1, L1)).entries[1].graceMinutes.to, 20);

  // The database keeps them append-only (unchanged triggers).
  const migration = fs.readFileSync(path.join(root, "prisma/migrations/20261110140000_add_lecture_attendance/migration.sql"), "utf8");
  for (const table of ["AttendanceAuditLog", "LectureAttendanceRegisterAuditLog"]) {
    assert.match(migration, new RegExp(`CREATE TRIGGER "${table}_no_update_delete"\\s+BEFORE UPDATE OR DELETE ON "${table}"`));
    assert.match(migration, new RegExp(`CREATE TRIGGER "${table}_no_truncate"\\s+BEFORE TRUNCATE ON "${table}"`));
  }
});
