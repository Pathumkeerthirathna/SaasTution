/*
 * Stage 5.4a: attendance configuration, error table, lock helpers,
 * ensureRegister and the read-only getRegister.
 *
 *   npm run test:attendance-service
 *
 * No database. The services run through tsx against:
 *   - an in-memory model of the PostgreSQL behaviour they rely on (row locks
 *     KEY SHARE / SHARE / NO KEY UPDATE / UPDATE and their conflicts, held
 *     until the transaction ends; INSERT ... ON CONFLICT DO NOTHING waiting
 *     for another transaction's uncommitted insert of the same key; READ
 *     COMMITTED visibility; rollback);
 *   - a read-only Prisma double for getRegister that throws on ANY write.
 * Setting values used here are test values, not a real environment's.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");

// ---- lib/prisma.ts double: switchable per test -----------------------------------------

let currentPrisma = null;
const prismaProxy = new Proxy({}, {
  get(_, key) {
    if (!currentPrisma) throw new Error("no Prisma double installed");
    return currentPrisma[key];
  },
});

function fake(relativePath, exports) {
  const filename = path.join(root, relativePath);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

fake("lib/prisma.ts", { prisma: prismaProxy });

const config = require(path.join(root, "lib", "attendance", "config.ts"));
const errors = require(path.join(root, "lib", "attendance", "service-errors.ts"));
const lockLib = require(path.join(root, "lib", "attendance", "locks.ts"));
const service = require(path.join(root, "services", "lecture-attendance-service.ts"));
const { AppError } = require(path.join(root, "lib", "error-handler.ts"));

const APPROVAL = "APPROVAL_FEATURE_STARTED_AT";
const EVIDENCE = "ATTENDANCE_EVIDENCE_STARTED_AT";

// =========================================================================================
// 1. Configuration
// =========================================================================================

test("config: each setting is OK, MISSING or INVALID independently", () => {
  const ok = "2026-07-28T05:30:00+05:30";
  const cases = [
    [{}, "MISSING", "MISSING"],
    [{ [APPROVAL]: ok }, "OK", "MISSING"],
    [{ [EVIDENCE]: ok }, "MISSING", "OK"],
    [{ [APPROVAL]: ok, [EVIDENCE]: ok }, "OK", "OK"],
    [{ [APPROVAL]: "not a date", [EVIDENCE]: ok }, "INVALID", "OK"],
    [{ [APPROVAL]: ok, [EVIDENCE]: "2026-08-15T10:00:00" }, "OK", "INVALID"],
    [{ [APPROVAL]: "   ", [EVIDENCE]: "" }, "MISSING", "MISSING"],
    [{ [APPROVAL]: "garbage", [EVIDENCE]: "garbage" }, "INVALID", "INVALID"],
  ];
  for (const [env, approval, evidence] of cases) {
    assert.deepEqual(config.attendanceConfigurationStatus(env), { approval, evidence }, JSON.stringify(env));
    assert.equal(config.loadApprovalConfig(env).status, approval);
    assert.equal(config.loadEvidenceConfig(env).status, evidence);
  }
});

test("config: strict ISO instants with an explicit offset", () => {
  const instant = (raw) => config.loadEvidenceConfig({ [EVIDENCE]: raw });
  assert.equal(instant("2026-08-15T10:00:00+05:30").evidenceStartedAt.toISOString(), "2026-08-15T04:30:00.000Z");
  assert.equal(instant("2026-08-15T04:30Z").evidenceStartedAt.toISOString(), "2026-08-15T04:30:00.000Z");
  assert.equal(instant("2026-08-15T00:00:00.123-04:00").evidenceStartedAt.toISOString(), "2026-08-15T04:00:00.123Z");
  assert.equal(instant("  2026-08-15T04:30:00Z  ").status, "OK");

  for (const bad of [
    "2026-08-15T10:00:00", // no offset: would depend on the server's time zone
    "2026-08-15",
    "2026-08-15T10:00:00-00:00", // "offset unknown"
    "2026-08-15T10:00:00+14:01",
    "2026-02-30T10:00:00Z",
    "2026-08-15T24:00:00Z",
    "1786771200000",
    "2026-08-15 10:00:00Z",
  ]) {
    assert.equal(instant(bad).status, "INVALID", bad);
    assert.equal(instant(bad).evidenceStartedAt, null);
  }

  const approval = config.loadApprovalConfig({ [APPROVAL]: "2026-07-28T05:30:00+05:30" });
  assert.equal(approval.context.approvalFeatureStartedAt.toISOString(), "2026-07-28T00:00:00.000Z");
});

test("config: require* fail closed with separate 503 codes; no fallback instant", () => {
  for (const env of [{}, { [APPROVAL]: "2026-07-28" }]) {
    assert.throws(() => config.requireApprovalContext(env), (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "ATTENDANCE_APPROVAL_NOT_CONFIGURED");
      return true;
    });
  }
  for (const env of [{}, { [EVIDENCE]: "tomorrow" }]) {
    assert.throws(() => config.requireEvidenceStartedAt(env), (error) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "ATTENDANCE_EVIDENCE_NOT_CONFIGURED");
      return true;
    });
  }
  // Independent: one setting never stands in for the other.
  assert.throws(() => config.requireEvidenceStartedAt({ [APPROVAL]: "2026-07-28T00:00:00Z" }), /not configured/);
  assert.throws(() => config.requireApprovalContext({ [EVIDENCE]: "2026-07-28T00:00:00Z" }), /not configured/);
  assert.equal(config.requireEvidenceStartedAt({ [EVIDENCE]: "2026-08-15T04:30:00Z" }).toISOString(), "2026-08-15T04:30:00.000Z");
});

test("config: setting values never appear in errors, details or log lines", () => {
  const secretish = "2026-13-45T99:99:99+05:30-SECRET-VALUE";
  const lines = [];
  config.resetConfigurationWarnings();

  for (const [fn, setting] of [
    [config.requireApprovalContext, APPROVAL],
    [config.requireEvidenceStartedAt, EVIDENCE],
  ]) {
    const original = console.warn;
    console.warn = (line) => lines.push(String(line));
    try {
      assert.throws(() => fn({ [setting]: secretish }), (error) => {
        const everything = `${error.message} ${JSON.stringify(error.details)} ${error.stack}`;
        assert.ok(!everything.includes("SECRET"), everything);
        assert.ok(!everything.includes("2026-13-45"), everything);
        assert.deepEqual(error.details, { setting, status: "INVALID" });
        return true;
      });
    } finally {
      console.warn = original;
    }
  }

  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.ok(!line.includes("SECRET") && !line.includes("2026-13-45"), line);
    assert.match(line, /is invalid/);
  }
  assert.ok(!JSON.stringify(config.attendanceConfigurationStatus({ [APPROVAL]: secretish })).includes("SECRET"));
});

test("config: one warning per process per setting and status", () => {
  config.resetConfigurationWarnings();
  const lines = [];
  const log = (line) => lines.push(line);
  config.warnConfigurationOnce(EVIDENCE, "MISSING", log);
  config.warnConfigurationOnce(EVIDENCE, "MISSING", log);
  config.warnConfigurationOnce(EVIDENCE, "INVALID", log);
  config.warnConfigurationOnce(EVIDENCE, "OK", log);
  assert.equal(lines.length, 2);
  config.resetConfigurationWarnings();
});

test("config: LIVE from the evidence start instant itself, HISTORICAL before it", () => {
  const boundary = new Date("2026-08-15T04:30:00.000Z");
  assert.equal(config.classifyLecture(boundary, boundary), "LIVE");
  assert.equal(config.classifyLecture(new Date(boundary.getTime() + 1), boundary), "LIVE");
  assert.equal(config.classifyLecture(new Date(boundary.getTime() - 1), boundary), "HISTORICAL");
  assert.throws(() => config.classifyLecture(new Date(NaN), boundary), RangeError);
});

// =========================================================================================
// 2. Error table
// =========================================================================================

test("errors: codes map to their HTTP status; lock errors become 409 ATTENDANCE_BUSY", () => {
  const expected = {
    VALIDATION_ERROR: 400,
    ATTENDANCE_REQUEST_TOO_LARGE: 413,
    ATTENDANCE_REASON_REQUIRED: 400,
    LECTURE_NOT_FOUND: 404,
    STUDENT_NOT_FOUND: 404,
    ATTENDANCE_BUSY: 409,
    ATTENDANCE_RECORD_CHANGED: 409,
    ATTENDANCE_REGISTER_CHANGED: 409,
    ATTENDANCE_REGISTER_FINALIZED: 409,
    ATTENDANCE_NO_PENDING_REVIEW: 409,
    FINALIZATION_NOT_ALLOWED: 409,
    FINALIZATION_SESSION_ACTIVE: 409,
    FINALIZATION_PREVIEW_STALE: 409,
    FINALIZATION_EVIDENCE_PENDING: 409,
    LECTURE_ATTENDANCE_FINALIZED: 409,
    LECTURE_CANCELLED: 409,
    ATTENDANCE_LECTURE_HISTORICAL: 409,
    ATTENDANCE_LECTURE_LIVE: 409,
    FINALIZATION_ROSTER_LIMIT_EXCEEDED: 409,
    FINALIZATION_CANDIDATES_CHANGED: 409,
    FINALIZATION_INTEGRITY_ERROR: 500,
    ATTENDANCE_SCAN_ID_REUSED: 409,
    ATTENDANCE_QR_NOT_OPEN: 409,
    ATTENDANCE_QR_CLOSED: 409,
    ATTENDANCE_SCAN_RATE_LIMITED: 429,
    ATTENDANCE_STUDENT_NOT_ENROLLED: 409,
    ATTENDANCE_APPROVAL_NOT_CONFIGURED: 503,
    ATTENDANCE_EVIDENCE_NOT_CONFIGURED: 503,
    STUDENT_QR_NOT_CONFIGURED: 503,
  };
  assert.deepEqual(Object.keys(errors.ATTENDANCE_ERRORS).sort(), Object.keys(expected).sort());
  for (const [code, status] of Object.entries(expected)) {
    const error = errors.attendanceError(code, { x: 1 });
    assert.ok(error instanceof AppError);
    assert.equal(error.statusCode, status, code);
    assert.equal(error.code, code);
    assert.deepEqual(error.details, { x: 1 });
  }

  for (const sqlstate of ["55P03", "40P01", "40001"]) {
    const raw = Object.assign(new Error("lock"), { name: "PrismaClientKnownRequestError", code: "P2010", meta: { code: sqlstate } });
    assert.equal(errors.mapAttendanceLockError(raw).code, "ATTENDANCE_BUSY");
  }
  const other = new Error("boom");
  assert.equal(errors.mapAttendanceLockError(other), other);
});

// =========================================================================================
// 3. Lock order (AttendanceLocks, pure bookkeeping)
// =========================================================================================

/** A transaction double whose raw queries always find the row (or never, with `miss`). */
function stubLocks({ miss = [] } = {}) {
  const sqls = [];
  const tx = {
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join("?");
      sqls.push(sql);
      if (miss.some((pattern) => pattern.test(sql))) return [];
      if (/FROM "LectureAttendance"\s/.test(sql)) return values[1].map((studentId) => ({ studentId }));
      return [{ id: values[0], lectureId: values[0] }];
    },
  };
  return { locks: lockLib.createAttendanceLocksForTesting(tx), sqls };
}

test("construction: only runAttendanceTransaction (or the guarded test factory) creates AttendanceLocks", () => {
  const tx = { $queryRaw: async () => [] };
  // Private constructor: at run time a direct `new` (any token) throws.
  assert.throws(() => new lockLib.AttendanceLocks(Symbol("AttendanceLocks"), tx), /only be created by runAttendanceTransaction/);
  assert.throws(() => new lockLib.AttendanceLocks(undefined, tx), /only be created by runAttendanceTransaction/);
  assert.throws(() => lockLib.AttendanceLocks.fromTransaction(Symbol("AttendanceLocks"), tx), /only be created by runAttendanceTransaction/);

  // The test factory refuses a top-level client (anything with a $transaction function).
  const topLevel = { $transaction: async () => {}, $queryRaw: async () => [] };
  assert.throws(() => lockLib.createAttendanceLocksForTesting(topLevel), /refuses a top-level Prisma client/);
  assert.ok(lockLib.createAttendanceLocksForTesting(tx) instanceof lockLib.AttendanceLocks);

  const source = fs.readFileSync(path.join(root, "lib", "attendance", "locks.ts"), "utf8");
  assert.match(source, /private constructor\(token: typeof CONSTRUCTION_TOKEN, tx: Tx\)/);
  assert.doesNotMatch(source, /export const CONSTRUCTION_TOKEN|export \{[^}]*CONSTRUCTION_TOKEN/);
  // The compile-time guard exists (checked by tsc: each forbidden construction must fail to compile).
  const guard = fs.readFileSync(path.join(root, "tests", "attendance", "locks-construction.typecheck.ts"), "utf8");
  assert.equal(guard.match(/^\s*\/\/ @ts-expect-error /gm).length, 4);
});

test("construction: only tests import the test factory", () => {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js|cjs)$/.test(entry.name) && fs.readFileSync(full, "utf8").includes("createAttendanceLocksForTesting")) {
        hits.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  for (const dir of ["app", "services", "lib", "components", "scripts"]) {
    if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  }
  assert.deepEqual(hits, ["lib/attendance/locks.ts"]);
});

test("lock order: the full approved order is accepted", async () => {
  const { locks } = stubLocks();
  await lockLib.lockStudentShared(locks, "s1");
  await lockLib.lockLectureShared(locks, "L");
  await lockLib.lockClassKeyShared(locks, "C");
  await lockLib.lockRegisterKeyShared(locks, "L");
  await lockLib.lockRecords(locks, "L", ["s3", "s1", "s2"]);
  await lockLib.lockRecords(locks, "L", ["s4"]);
  locks.beginWrites();
  assert.deepEqual(locks.trail, [
    "STUDENT:SHARE:s1",
    "LECTURE:SHARE:L",
    "CLASS:KEY_SHARE:C",
    "REGISTER:KEY_SHARE:L",
    "RECORDS:NO_KEY_UPDATE:L:s1",
    "RECORDS:NO_KEY_UPDATE:L:s2",
    "RECORDS:NO_KEY_UPDATE:L:s3",
    "RECORDS:NO_KEY_UPDATE:L:s4",
  ]);
});

test("lock order: every violation throws AttendanceLockOrderError before its SQL is sent", async () => {
  const L_ = lockLib;
  const violations = [
    ["Lecture after Register", (l) => L_.lockRegisterKeyShared(l, "L"), (l) => L_.lockLectureShared(l, "L")],
    ["Student after Lecture", (l) => L_.lockLectureShared(l, "L"), (l) => L_.lockStudentShared(l, "s1")],
    ["Class after Register", (l) => L_.lockRegisterForUpdate(l, "L"), (l) => L_.lockClassKeyShared(l, "C")],
    ["Register after records", (l) => L_.lockRecords(l, "L", ["s1"]), (l) => L_.lockRegisterKeyShared(l, "L")],
    ["second Student", (l) => L_.lockStudentShared(l, "s1"), (l) => L_.lockStudentShared(l, "s2")],
    ["second Lecture", (l) => L_.lockLectureShared(l, "L"), (l) => L_.lockLectureShared(l, "L2")],
    ["second Register", (l) => L_.lockRegisterKeyShared(l, "L"), (l) => L_.lockRegisterKeyShared(l, "L2")],
    ["records out of order", (l) => L_.lockRecords(l, "L", ["s2"]), (l) => L_.lockRecords(l, "L", ["s1"])],
    ["upgrade Register KEY SHARE to UPDATE", (l) => L_.lockRegisterKeyShared(l, "L"), (l) => L_.lockRegisterForUpdate(l, "L")],
    ["upgrade Lecture SHARE to NO KEY UPDATE", (l) => L_.lockLectureShared(l, "L"), (l) => L_.lockLectureForUpdate(l, "L")],
    ["lock after writes", async (l) => { await L_.lockLectureShared(l, "L"); l.beginWrites(); }, (l) => L_.lockRegisterKeyShared(l, "L")],
    ["register insert after records", (l) => L_.lockRecords(l, "L", ["s1"]), (l) =>
      L_.insertRegisterIfAbsent(l, { lectureId: "L", classId: "C", scheduledStartAt: new Date(0), scheduledEndAt: null, graceMinutes: 10, now: new Date(0) })],
  ];

  for (const [name, setup, violate] of violations) {
    const { locks, sqls } = stubLocks();
    await setup(locks);
    const sent = sqls.length;
    await assert.rejects(violate(locks), (error) => {
      assert.equal(error.name, "AttendanceLockOrderError", name);
      assert.match(error.message, /^Attendance lock order violated: /);
      return true;
    }, name);
    assert.equal(sqls.length, sent, `${name}: the violating statement must not be sent`);
  }
});

test("lock order: re-locking a held row in an equal or weaker mode is allowed at any point", async () => {
  const { locks } = stubLocks();
  await lockLib.lockLectureShared(locks, "L");
  await lockLib.lockClassKeyShared(locks, "C");
  await lockLib.lockRegisterForUpdate(locks, "L");
  await lockLib.lockLectureShared(locks, "L"); // held SHARE: no wait possible
  await lockLib.lockRegisterKeyShared(locks, "L"); // held UPDATE covers KEY SHARE
  assert.equal(locks.trail.length, 5);
});

test("lock order: a lock that finds no row holds nothing and does not move the order", async () => {
  const { locks } = stubLocks({ miss: [/FROM "LectureAttendanceRegister"/] });
  assert.equal(await lockLib.lockRegisterKeyShared(locks, "L"), null);
  await lockLib.lockLectureShared(locks, "L"); // allowed: the register miss held nothing
  await lockLib.lockClassKeyShared(locks, "C");
  assert.deepEqual(locks.trail, ["LECTURE:SHARE:L", "CLASS:KEY_SHARE:C"]);
});

test("lock SQL: static parameterised statements only; the lock mode is literal text", () => {
  const source = fs.readFileSync(path.join(root, "lib", "attendance", "locks.ts"), "utf8");
  assert.doesNotMatch(source, /\$queryRawUnsafe\(|Prisma\.raw\(|Prisma\.sql`/);
  const unsafe = source.match(/\$executeRawUnsafe\(([^)]*)\)/g) || [];
  assert.deepEqual(unsafe, ["$executeRawUnsafe(`SET LOCAL lock_timeout = '${ATTENDANCE_LOCK_TIMEOUT_MS}ms'`)"]);
  for (const mode of ["FOR SHARE", "FOR NO KEY UPDATE", "FOR KEY SHARE", "FOR UPDATE"]) assert.ok(source.includes(mode), mode);
  assert.equal(lockLib.ATTENDANCE_LOCK_TIMEOUT_MS, 3000);
  assert.deepEqual(lockLib.ATTENDANCE_TRANSACTION_OPTIONS, { maxWait: 5000, timeout: 15000 });
  assert.doesNotMatch(source, /isolationLevel/);
});

// =========================================================================================
// 4. In-memory PostgreSQL model for runAttendanceTransaction / ensureRegister
// =========================================================================================

const CONFLICTS = {
  KEY_SHARE: new Set(["UPDATE"]),
  SHARE: new Set(["NO_KEY_UPDATE", "UPDATE"]),
  NO_KEY_UPDATE: new Set(["SHARE", "NO_KEY_UPDATE", "UPDATE"]),
  UPDATE: new Set(["KEY_SHARE", "SHARE", "NO_KEY_UPDATE", "UPDATE"]),
};

function lockTimeoutError() {
  return Object.assign(new Error("canceling statement due to lock timeout"), {
    name: "PrismaClientKnownRequestError",
    code: "P2010",
    meta: { code: "55P03" },
  });
}

let log;
let pg;

function resetPg() {
  log = [];
  pg = {
    held: [],
    waiting: [],
    failWhenBlocked: false,
    failAuditInsert: false,
    pendingInserts: new Map(), // register lectureId -> owner of an uncommitted insert
    ended: new Map(), // tx label -> { promise, resolve }
    committed: {
      lectures: {
        L1: { id: "L1", classId: "C1", status: 0, classStatus: "SCHEDULED", date: new Date("2026-09-01T12:30:00.000Z"), endDate: new Date("2026-09-01T14:30:00.000Z") },
        L2: { id: "L2", classId: "C1", status: 1, classStatus: "SCHEDULED", date: new Date("2026-09-02T12:30:00.000Z"), endDate: null },
        L3: { id: "L3", classId: "C1", status: 0, classStatus: "SCHEDULED", date: new Date("2026-09-03T12:30:00.000Z"), endDate: null },
      },
      classes: { C1: { id: "C1", teacherId: "T1", status: 0, attendanceGraceMinutes: 15 } },
      registers: {},
      registerAudits: [],
    },
    transactions: [],
    seq: 0,
  };
}

const lockPg = {
  canGrant(row, owner, mode) {
    return pg.held.every((h) => h.row !== row || h.owner === owner || !CONFLICTS[mode].has(h.mode));
  },
  async acquire(row, owner, mode) {
    if (this.canGrant(row, owner, mode) && !pg.waiting.some((w) => w.row === row)) {
      pg.held.push({ row, owner, mode });
      return;
    }
    if (pg.failWhenBlocked) throw lockTimeoutError();
    log.push(`${owner}:waits:${row}:${mode}`);
    await new Promise((grant) => pg.waiting.push({ row, owner, mode, grant }));
    log.push(`${owner}:granted:${row}:${mode}`);
  },
  release(owner) {
    pg.held = pg.held.filter((h) => h.owner !== owner);
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < pg.waiting.length; i += 1) {
        const w = pg.waiting[i];
        const firstForRow = pg.waiting.findIndex((x) => x.row === w.row) === i;
        if (firstForRow && this.canGrant(w.row, w.owner, w.mode)) {
          pg.waiting.splice(i, 1);
          pg.held.push({ row: w.row, owner: w.owner, mode: w.mode });
          w.grant();
          progressed = true;
          break;
        }
      }
    }
  },
};

function makeTx(label) {
  const local = { registers: {}, registerAudits: [] };
  const statements = [];

  const visibleRegister = (id) => local.registers[id] ?? pg.committed.registers[id] ?? null;

  const client = {
    $executeRawUnsafe: async (sql) => {
      statements.push(sql);
      if (/^SET LOCAL lock_timeout = '3000ms'$/.test(sql)) return 0;
      throw new Error("unexpected raw SQL: " + sql);
    },
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join("?").replace(/\s+/g, " ").trim();
      statements.push(sql);

      let match;
      if ((match = /FROM "LectureAttendanceRegister" WHERE "lectureId" = \? FOR (KEY SHARE|UPDATE)$/.exec(sql))) {
        const mode = match[1] === "KEY SHARE" ? "KEY_SHARE" : "UPDATE";
        const id = values[0];
        if (!visibleRegister(id)) return []; // no row (an uncommitted insert is invisible): nothing locked
        await lockPg.acquire(`register:${id}`, label, mode);
        log.push(`${label}:lock:register:${mode}`);
        const row = visibleRegister(id); // re-read after the wait (READ COMMITTED)
        return row ? [{ ...row }] : [];
      }
      if ((match = /FROM "Lecture" WHERE "id" = \? FOR (SHARE|NO KEY UPDATE)$/.exec(sql))) {
        const mode = match[1] === "SHARE" ? "SHARE" : "NO_KEY_UPDATE";
        const row = pg.committed.lectures[values[0]];
        if (!row) return [];
        await lockPg.acquire(`lecture:${row.id}`, label, mode);
        log.push(`${label}:lock:lecture:${mode}`);
        return [{ ...pg.committed.lectures[row.id] }];
      }
      if (/FROM "Class" WHERE "id" = \? FOR KEY SHARE$/.test(sql)) {
        const row = pg.committed.classes[values[0]];
        if (!row) return [];
        await lockPg.acquire(`class:${row.id}`, label, "KEY_SHARE");
        log.push(`${label}:lock:class:KEY_SHARE`);
        return [{ ...pg.committed.classes[row.id] }];
      }
      if (/^INSERT INTO "LectureAttendanceRegister"/.test(sql) && /ON CONFLICT \("lectureId"\) DO NOTHING RETURNING "lectureId"$/.test(sql)) {
        const [lectureId, classId, start, end, grace, createdAt, updatedAt] = values;
        // Timestamps must arrive as UTC ISO text (explicitly cast in SQL).
        for (const v of [start, createdAt, updatedAt]) assert.equal(typeof v, "string");
        assert.ok(end === null || typeof end === "string");
        assert.match(sql, /CAST\(\? AS timestamptz\) AT TIME ZONE 'UTC'/);

        for (;;) {
          if (pg.committed.registers[lectureId] || local.registers[lectureId]) {
            log.push(`${label}:insert-register:conflict`);
            return [];
          }
          const owner = pg.pendingInserts.get(lectureId);
          if (owner && owner !== label) {
            if (pg.failWhenBlocked) throw lockTimeoutError();
            log.push(`${label}:insert-register:waits-for:${owner}`);
            await pg.ended.get(owner).promise;
            continue;
          }
          break;
        }

        // Foreign keys: FOR KEY SHARE on the lecture and the class.
        await lockPg.acquire(`lecture:${lectureId}`, label, "KEY_SHARE");
        await lockPg.acquire(`class:${classId}`, label, "KEY_SHARE");

        local.registers[lectureId] = {
          lectureId,
          classId,
          scheduledStartAt: new Date(start),
          scheduledEndAt: end === null ? null : new Date(end),
          graceMinutes: grace,
          finalizedAt: null,
          finalizedByTeacherId: null,
          version: 1,
          createdAt: new Date(createdAt),
          updatedAt: new Date(updatedAt),
        };
        pg.pendingInserts.set(lectureId, label);
        await lockPg.acquire(`register:${lectureId}`, label, "UPDATE");
        log.push(`${label}:insert-register:inserted`);
        return [{ lectureId }];
      }
      throw new Error("unexpected raw SQL: " + sql);
    },
    lectureAttendanceRegisterAuditLog: {
      create: async ({ data }) => {
        if (pg.failAuditInsert) {
          log.push(`${label}:audit:failed`);
          throw Object.assign(new Error("simulated audit insert failure"), { name: "PrismaClientKnownRequestError", code: "P2004" });
        }
        const all = [...pg.committed.registerAudits, ...local.registerAudits];
        if (all.some((a) => a.lectureId === data.lectureId && a.version === data.version)) {
          throw Object.assign(new Error("Unique constraint failed"), { name: "PrismaClientKnownRequestError", code: "P2002" });
        }
        if (!visibleRegister(data.lectureId)) throw new Error("foreign key: register missing");
        const row = { id: `audit-${all.length + 1}`, ...data };
        local.registerAudits.push(row);
        log.push(`${label}:audit:${data.action}`);
        return row;
      },
    },
  };

  return {
    label,
    client,
    statements,
    commit() {
      Object.assign(pg.committed.registers, local.registers);
      pg.committed.registerAudits.push(...local.registerAudits);
      log.push(`${label}:commit`);
    },
  };
}

function installLockingPrisma() {
  currentPrisma = {
    $transaction: async (fn, options) => {
      const label = `tx${++pg.seq}`;
      const tx = makeTx(label);
      let resolveEnded;
      pg.ended.set(label, { promise: new Promise((r) => { resolveEnded = r; }), resolve: () => resolveEnded() });
      pg.transactions.push({ label, options, statements: tx.statements });
      try {
        const result = await fn(tx.client);
        tx.commit();
        return result;
      } catch (error) {
        log.push(`${label}:rollback`);
        throw error;
      } finally {
        for (const [key, owner] of pg.pendingInserts) if (owner === label) pg.pendingInserts.delete(key);
        lockPg.release(label);
        pg.ended.get(label).resolve();
      }
    },
  };
}

const NOW = new Date("2026-09-01T10:00:00.000Z");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const ensure = (lectureId, mode = "KEY_SHARE", actor = { role: "SYSTEM" }, after = async () => {}) =>
  lockLib.runAttendanceTransaction(async (locks) => {
    const result = await service.ensureRegister(locks, lectureId, { mode, now: NOW, actor });
    await after(locks);
    return { ...result, trail: [...locks.trail] };
  });

test("transaction: SET LOCAL lock_timeout first, standard options, no isolation override", async () => {
  resetPg();
  installLockingPrisma();
  await ensure("L1");
  const [tx] = pg.transactions;
  assert.equal(tx.statements[0], "SET LOCAL lock_timeout = '3000ms'");
  assert.deepEqual(tx.options, { maxWait: 5000, timeout: 15000 });
});

test("ensureRegister: creates the register from the lecture and the class, with one CREATED audit", async () => {
  resetPg();
  installLockingPrisma();
  const result = await ensure("L1", "KEY_SHARE", { role: "TEACHER", teacherId: "T1" });

  assert.equal(result.created, true);
  const stored = pg.committed.registers.L1;
  assert.equal(stored.scheduledStartAt.toISOString(), "2026-09-01T12:30:00.000Z");
  assert.equal(stored.scheduledEndAt.toISOString(), "2026-09-01T14:30:00.000Z");
  assert.equal(stored.graceMinutes, 15);
  assert.equal(stored.version, 1);
  assert.equal(stored.finalizedAt, null);
  assert.equal(stored.createdAt.toISOString(), NOW.toISOString());

  assert.equal(pg.committed.registerAudits.length, 1);
  const audit = pg.committed.registerAudits[0];
  assert.deepEqual(
    { action: audit.action, version: audit.version, actorRole: audit.actorRole, actorId: audit.actorId, toGraceMinutes: audit.toGraceMinutes },
    { action: "CREATED", version: 1, actorRole: "TEACHER", actorId: "T1", toGraceMinutes: 15 }
  );
  assert.equal(audit.toScheduledStartAt.toISOString(), "2026-09-01T12:30:00.000Z");
  assert.equal(audit.createdAt.toISOString(), NOW.toISOString());
  assert.equal("fromGraceMinutes" in audit, false);

  // Lock order of the creation path.
  assert.deepEqual(result.trail, ["LECTURE:SHARE:L1", "CLASS:KEY_SHARE:C1", "REGISTER:UPDATE:L1", "REGISTER:KEY_SHARE:L1"]);

  // A SYSTEM creation names nobody; a lecture without an end time keeps null.
  const system = await ensure("L3");
  assert.equal(system.created, true);
  assert.equal(pg.committed.registers.L3.scheduledEndAt, null);
  const systemAudit = pg.committed.registerAudits.find((a) => a.lectureId === "L3");
  assert.equal(systemAudit.actorRole, "SYSTEM");
  assert.equal(systemAudit.actorId, null);
});

test("ensureRegister: an existing register is locked after the lecture is re-checked under its lock (no insert, no audit)", async () => {
  resetPg();
  installLockingPrisma();
  await ensure("L1");
  const second = await ensure("L1", "UPDATE");
  assert.equal(second.created, false);
  // W3: the fast path re-checks the lecture (and its class) under the lock too.
  assert.deepEqual(second.trail, ["LECTURE:SHARE:L1", "CLASS:KEY_SHARE:C1", "REGISTER:UPDATE:L1"]);
  assert.equal(pg.committed.registerAudits.length, 1);
});

test("ensureRegister race: two creators, exactly one register and one CREATED audit", async () => {
  resetPg();
  installLockingPrisma();
  const gate = deferred();

  // First creator inserts and then stays open (uncommitted) until the gate opens.
  const first = ensure("L1", "KEY_SHARE", { role: "SYSTEM" }, async () => {
    log.push("tx1:holding");
    await gate.promise;
  });
  while (!log.includes("tx1:holding")) await tick();

  const second = ensure("L1", "KEY_SHARE", { role: "TEACHER", teacherId: "T1" });
  while (!log.includes("tx2:insert-register:waits-for:tx1")) await tick();

  // While tx1 is open, tx2 cannot see or create the register.
  assert.equal(pg.committed.registerAudits.length, 0);
  gate.resolve();

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(Object.keys(pg.committed.registers).length, 1);
  assert.equal(pg.committed.registerAudits.length, 1);
  assert.equal(pg.committed.registerAudits[0].actorRole, "SYSTEM");
  assert.ok(log.indexOf("tx1:commit") < log.indexOf("tx2:insert-register:conflict"));
  assert.equal(b.register.lectureId, "L1");
  assert.equal(b.register.version, 1);
  // Both took the creation path in the approved order.
  assert.deepEqual(b.trail, ["LECTURE:SHARE:L1", "CLASS:KEY_SHARE:C1", "REGISTER:KEY_SHARE:L1"]);
});

test("ensureRegister race: when the first creator rolls back, the second creates it", async () => {
  resetPg();
  installLockingPrisma();
  const gate = deferred();

  const first = ensure("L1", "KEY_SHARE", { role: "SYSTEM" }, async () => {
    log.push("tx1:holding");
    await gate.promise;
    throw new Error("simulated failure after the insert");
  });
  while (!log.includes("tx1:holding")) await tick();
  const second = ensure("L1");
  while (!log.includes("tx2:insert-register:waits-for:tx1")) await tick();
  gate.resolve();

  await assert.rejects(first, /simulated failure/);
  const b = await second;
  assert.equal(b.created, true);
  assert.equal(pg.committed.registerAudits.length, 1);
  assert.ok(log.includes("tx1:rollback"));
});

test("ensureRegister: a failing CREATED audit rolls the register back (one transaction, nothing partial)", async () => {
  resetPg();
  installLockingPrisma();
  pg.failAuditInsert = true;

  await assert.rejects(ensure("L1", "KEY_SHARE", { role: "TEACHER", teacherId: "T1" }), /simulated audit insert failure/);

  // The register insert and the audit attempt happened in the SAME transaction, in that order, then it rolled back.
  assert.equal(pg.transactions.length, 1);
  const insertAt = log.indexOf("tx1:insert-register:inserted");
  const auditAt = log.indexOf("tx1:audit:failed");
  const rollbackAt = log.indexOf("tx1:rollback");
  assert.ok(insertAt >= 0 && insertAt < auditAt && auditAt < rollbackAt, log.join(" | "));
  assert.ok(!log.includes("tx1:commit"));

  // Nothing partial is committed, and nothing is left pending or locked.
  assert.deepEqual(pg.committed.registers, {});
  assert.deepEqual(pg.committed.registerAudits, []);
  assert.equal(pg.pendingInserts.size, 0);
  assert.deepEqual(pg.held, []);

  // A later attempt starts from scratch and succeeds.
  pg.failAuditInsert = false;
  const retry = await ensure("L1");
  assert.equal(retry.created, true);
  assert.equal(Object.keys(pg.committed.registers).length, 1);
  assert.equal(pg.committed.registerAudits.length, 1);
});

test("ensureRegister: a removed lecture is 404 and nothing is written", async () => {
  resetPg();
  installLockingPrisma();
  await assert.rejects(ensure("L2"), (error) => error.code === "LECTURE_NOT_FOUND" && error.statusCode === 404);
  await assert.rejects(ensure("missing"), (error) => error.code === "LECTURE_NOT_FOUND");
  assert.deepEqual(pg.committed.registers, {});
  assert.deepEqual(pg.committed.registerAudits, []);
});

test("ensureRegister: an invalid server time is refused before any lock", async () => {
  resetPg();
  installLockingPrisma();
  await assert.rejects(
    lockLib.runAttendanceTransaction((locks) => service.ensureRegister(locks, "L1", { mode: "KEY_SHARE", now: new Date(NaN), actor: { role: "SYSTEM" } })),
    RangeError
  );
  assert.equal(pg.transactions[0].statements.length, 1); // only SET LOCAL
});

test("fee-waiver rule edit holding Class FOR UPDATE: creation waits for it, or 409 ATTENDANCE_BUSY on timeout", async () => {
  // Waits, then proceeds once the rule edit commits.
  resetPg();
  installLockingPrisma();
  pg.held.push({ row: "class:C1", owner: "fee-rule", mode: "UPDATE" });
  const creation = ensure("L1");
  while (!log.some((entry) => entry.startsWith("tx1:waits:class:C1"))) await tick();
  assert.equal(pg.committed.registerAudits.length, 0);
  lockPg.release("fee-rule");
  assert.equal((await creation).created, true);

  // Lock timeout: classified as retryable, nothing written.
  resetPg();
  installLockingPrisma();
  pg.held.push({ row: "class:C1", owner: "fee-rule", mode: "UPDATE" });
  pg.failWhenBlocked = true;
  await assert.rejects(ensure("L1"), (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "ATTENDANCE_BUSY");
    assert.equal(error.statusCode, 409);
    return true;
  });
  assert.deepEqual(pg.committed.registers, {});
});

test("finalization-style FOR UPDATE on the register blocks KEY SHARE writers (409 on timeout)", async () => {
  resetPg();
  installLockingPrisma();
  await ensure("L1");
  pg.held.push({ row: "register:L1", owner: "finalizer", mode: "UPDATE" });
  pg.failWhenBlocked = true;
  await assert.rejects(ensure("L1"), (error) => error.code === "ATTENDANCE_BUSY");
  pg.failWhenBlocked = false;
  lockPg.release("finalizer");
  assert.equal((await ensure("L1")).created, false);
});

test("non-lock errors pass through unchanged", async () => {
  resetPg();
  installLockingPrisma();
  const boom = new Error("boom");
  await assert.rejects(lockLib.runAttendanceTransaction(async () => { throw boom; }), (error) => error === boom);
});

// =========================================================================================
// 5. getRegister: read only, degraded by configuration
// =========================================================================================

const T = "T1";
const C = "C1";
const L = "L1";
const START = new Date("2026-09-01T12:30:00.000Z");
const END = new Date("2026-09-01T14:30:00.000Z");
const FEATURE_ENV = "2026-07-28T00:00:00Z";
const LIVE_ENV = "2026-08-15T00:00:00Z"; // the lecture starts after it
const HISTORICAL_ENV = "2026-10-01T00:00:00Z"; // the lecture starts before it
const APPROVED_AT = new Date("2026-08-01T00:00:00.000Z");
const SL = (5 * 60 + 30) * 60_000;
const digits = (iso) => new Date(new Date(iso).getTime() + SL);
const minutesAfterStart = (m) => new Date(START.getTime() + m * 60_000);

function approvedStudent(id, name) {
  return { id, name, teacherId: T, registrationNumber: `R-${id}`, status: 0, confirmationStatus: "APPROVED", confirmedAt: APPROVED_AT, approvedAt: APPROVED_AT };
}

function baseData() {
  return {
    lecture: { id: L, title: "Kinematics", classId: C, status: 0, date: START, endDate: END, classStatus: "SCHEDULED", teacherId: T, class: { attendanceGraceMinutes: 10 } },
    register: null,
    records: [],
    sessions: [{ id: "S1", lectureId: L, isActive: true, startedAt: minutesAfterStart(-5) }, { id: "S0", lectureId: L, isActive: false, startedAt: minutesAfterStart(-60) }],
    students: [
      approvedStudent("s-absent", "Amal"),
      approvedStudent("s-visitor", "Bimal"),
      approvedStudent("s-teacher", "Chamal"),
      { ...approvedStudent("s-broken", "Dinesh"), confirmedAt: new Date("2026-08-02T00:00:00.000Z") }, // history mismatch: UNKNOWN
      { id: "s-pending", name: "Eshan", teacherId: T, registrationNumber: null, status: 0, confirmationStatus: "PENDING", confirmedAt: null, approvedAt: null },
      approvedStudent("s-removed", "Farah"),
      { ...approvedStudent("s-other-teacher", "Gihan"), teacherId: "T2" },
    ],
    history: ["s-absent", "s-visitor", "s-teacher", "s-broken", "s-removed", "s-other-teacher"].map((id) => ({
      id: `h-${id}`, studentId: id, fromStatus: "PENDING", toStatus: "APPROVED", decidedAt: APPROVED_AT, previousConfirmedAt: null,
    })),
    enrolments: [
      ...["s-absent", "s-visitor", "s-teacher", "s-broken", "s-pending"].map((id) => ({
        id: `e-${id}`, classId: C, studentId: id, assignedAt: digits("2026-08-05T00:00:00Z"), removedAt: null, isActive: true,
      })),
      // Removed before the lecture (still a candidate: any enrolment row counts).
      { id: "e-s-removed", classId: C, studentId: "s-removed", assignedAt: digits("2026-08-05T00:00:00Z"), removedAt: digits("2026-08-20T00:00:00Z"), isActive: false },
    ],
    visits: [
      { id: "v1", studentId: "s-visitor", joinedAt: minutesAfterStart(5), lectureId: L },
      { id: "v2", studentId: "s-teacher", joinedAt: minutesAfterStart(2), lectureId: L },
      { id: "v3", studentId: "s-broken", joinedAt: minutesAfterStart(1), lectureId: L },
      { id: "v4", studentId: "s-visitor", joinedAt: minutesAfterStart(40), lectureId: L },
    ],
  };
}

function teacherRecord(studentId, extra = {}) {
  return {
    id: `r-${studentId}`, lectureId: L, classId: C, studentId, status: "ABSENT", statusSource: "TEACHER", autoStatus: null,
    teacherStatus: "ABSENT", firstOnlineAt: null, firstQrAt: null, teacherDecidedAt: minutesAfterStart(30), teacherDecidedById: T,
    pendingReviewSince: null, version: 1, createdAt: minutesAfterStart(30), updatedAt: minutesAfterStart(30), ...extra,
  };
}

let calls;

/** Read-only Prisma double: find* only; ANY other access throws. */
function installReadOnlyPrisma(data) {
  calls = [];
  const inIds = (where) => (where && where.studentId && where.studentId.in) || null;
  const models = {
    lecture: {
      findFirst: async ({ where }) => {
        const l = data.lecture;
        return l.id === where.id && l.status === where.status && l.teacherId === where.class.teacherId ? { ...l } : null;
      },
    },
    lectureAttendanceRegister: { findUnique: async ({ where }) => (data.register && data.register.lectureId === where.lectureId ? { ...data.register } : null) },
    lectureAttendance: { findMany: async ({ where }) => data.records.filter((r) => r.lectureId === where.lectureId).sort((a, b) => (a.studentId < b.studentId ? -1 : 1)) },
    classSession: { findMany: async ({ where }) => data.sessions.filter((s) => s.lectureId === where.lectureId && s.isActive === where.isActive).map(({ id, startedAt }) => ({ id, startedAt })) },
    classStudent: {
      findMany: async ({ where }) =>
        data.enrolments.filter((e) => e.classId === where.classId && data.students.find((s) => s.id === e.studentId)?.teacherId === where.student.teacherId),
    },
    student: { findMany: async ({ where }) => data.students.filter((s) => where.id.in.includes(s.id) && s.teacherId === where.teacherId) },
    studentConfirmationHistory: { findMany: async ({ where }) => data.history.filter((h) => inIds(where).includes(h.studentId)) },
    attendance: {
      findMany: async ({ where }) =>
        data.visits.filter((v) => v.lectureId === where.classSession.lectureId && inIds(where).includes(v.studentId)).map(({ studentId, joinedAt }) => ({ studentId, joinedAt })),
    },
  };

  const readOnly = new Set(["findFirst", "findUnique", "findMany", "count"]);
  currentPrisma = new Proxy({}, {
    get(_, modelName) {
      if (typeof modelName !== "string" || !(modelName in models)) {
        throw new Error(`getRegister touched prisma.${String(modelName)} (not allowed: read-only)`);
      }
      return new Proxy(models[modelName], {
        get(target, method) {
          if (!readOnly.has(method) || !(method in target)) throw new Error(`WRITE OR UNKNOWN CALL: ${modelName}.${String(method)}`);
          return (...args) => {
            calls.push(`${modelName}.${method}`);
            return target[method](...args);
          };
        },
      });
    },
  });
}

const env = (approval, evidence) => ({
  ...(approval !== undefined ? { [APPROVAL]: approval } : {}),
  ...(evidence !== undefined ? { [EVIDENCE]: evidence } : {}),
});
const view = (data, envValue, now = minutesAfterStart(60)) => {
  installReadOnlyPrisma(data);
  return service.getRegister(T, L, { now, env: envValue });
};
const byId = (list) => Object.fromEntries(list.map((entry) => [entry.studentId, entry]));

test("getRegister: another teacher's or a removed lecture is 404", async () => {
  const data = baseData();
  installReadOnlyPrisma(data);
  await assert.rejects(service.getRegister("T2", L, { env: env(FEATURE_ENV, LIVE_ENV) }), (error) => error.code === "LECTURE_NOT_FOUND");
  data.lecture.status = 1;
  await assert.rejects(view(data, env(FEATURE_ENV, LIVE_ENV)), (error) => error.code === "LECTURE_NOT_FOUND");
});

test("getRegister: without a register, a computed register (version 0) from the lecture and the class; read only", async () => {
  const data = baseData();
  data.records = [teacherRecord("s-teacher")];
  const result = await view(data, env(FEATURE_ENV, LIVE_ENV));

  assert.deepEqual(result.register, {
    exists: false,
    scheduledStartAt: START,
    scheduledEndAt: END,
    graceMinutes: 10,
    finalizedAt: null,
    finalizedByTeacherId: null,
    version: 0,
  });
  assert.deepEqual(result.configuration, { approval: "OK", evidence: "OK" });
  assert.equal(result.classification, "LIVE");
  assert.deepEqual(result.activeSessions, [{ id: "S1", startedAt: minutesAfterStart(-5) }]);
  assert.deepEqual(result.finalization, { readiness: { allowed: false, reason: "SCHEDULED_END_NOT_PASSED" }, configured: true });
  assert.ok(calls.every((call) => /\.(findFirst|findUnique|findMany)$/.test(call)), calls.join());

  // Candidates: every enrolment row of the class (removed included), this teacher's students only.
  assert.deepEqual(result.roster.map((r) => r.studentId), ["s-absent", "s-visitor", "s-teacher", "s-broken", "s-pending", "s-removed"]);
  const roster = byId(result.roster);
  assert.equal(roster["s-absent"].absenceDecision, "CREATE_ABSENT");
  assert.equal(roster["s-visitor"].absenceDecision, "CREATE_ABSENT");
  assert.equal(roster["s-teacher"].absenceDecision, "HAS_RECORD");
  assert.equal(roster["s-broken"].absenceDecision, "MANUAL_REVIEW");
  assert.equal(roster["s-pending"].absenceDecision, "NOT_ELIGIBLE");
  assert.equal(roster["s-removed"].absenceDecision, "NOT_ELIGIBLE");
  assert.deepEqual(roster["s-broken"].eligibility, { outcome: "UNKNOWN", reason: "APPROVAL_UNKNOWN", approvalReason: "BROKEN_HISTORY" });
  assert.deepEqual(roster["s-removed"].eligibility, { outcome: "NOT_ELIGIBLE", reason: "NOT_ENROLLED", approvalReason: "KNOWN_APPROVED" });
  assert.equal(roster["s-teacher"].hasRecord, true);
  assert.equal(roster["s-absent"].registrationNumber, "R-s-absent");

  assert.deepEqual(result.absencePreview, {
    absentStudentIds: ["s-absent", "s-visitor"],
    manualReviewStudentIds: ["s-broken"],
    eligibleCount: 3,
    unknownEligibilityCount: 1,
    absentCreatedCount: 2,
  });

  // LIVE: the visitor (no record) and the teacher-marked visitor (record without
  // firstOnlineAt) are not represented; the UNKNOWN visitor without a record is reported.
  assert.deepEqual(result.onlineEvidence, {
    pending: [
      { studentId: "s-visitor", earliestEligibleVisitAt: minutesAfterStart(5) },
      { studentId: "s-teacher", earliestEligibleVisitAt: minutesAfterStart(2) },
    ],
    unknownVisits: [{ studentId: "s-broken", earliestUnknownVisitAt: minutesAfterStart(1) }],
  });
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.reviewQueue, []);
});

test("getRegister: HISTORICAL counts a teacher decision as represented; the UNKNOWN rule is unchanged", async () => {
  const data = baseData();
  data.records = [teacherRecord("s-teacher")];
  const result = await view(data, env(FEATURE_ENV, HISTORICAL_ENV));
  assert.equal(result.classification, "HISTORICAL");
  assert.deepEqual(result.onlineEvidence.pending.map((p) => p.studentId), ["s-visitor"]);
  assert.deepEqual(result.onlineEvidence.unknownVisits.map((p) => p.studentId), ["s-broken"]);
});

test("getRegister: a record whose firstOnlineAt covers the earliest eligible visit is represented (LIVE)", async () => {
  const data = baseData();
  data.records = [
    teacherRecord("s-teacher", { firstOnlineAt: minutesAfterStart(2), autoStatus: "PRESENT" }),
    { ...teacherRecord("s-visitor"), status: "PRESENT", statusSource: "AUTO", teacherStatus: null, teacherDecidedAt: null, teacherDecidedById: null, firstOnlineAt: minutesAfterStart(40), autoStatus: "LATE" },
  ];
  const result = await view(data, env(FEATURE_ENV, LIVE_ENV));
  // s-visitor's record only covers the 40-minute visit, not the 5-minute one.
  assert.deepEqual(result.onlineEvidence.pending, [{ studentId: "s-visitor", earliestEligibleVisitAt: minutesAfterStart(5) }]);
});

for (const [label, approvalValue, status] of [["missing", undefined, "MISSING"], ["invalid", "2026-07-28", "INVALID"]]) {
  test(`getRegister: approval setting ${label}: still answers; eligibility, preview and evidence check unavailable`, async () => {
    const data = baseData();
    data.records = [teacherRecord("s-teacher", { pendingReviewSince: minutesAfterStart(20), firstOnlineAt: minutesAfterStart(2), autoStatus: "PRESENT" })];
    const result = await view(data, env(approvalValue, LIVE_ENV));

    assert.deepEqual(result.configuration, { approval: status, evidence: "OK" });
    assert.equal(result.register.exists, false);
    assert.equal(result.classification, "LIVE");
    assert.equal(result.roster.length, 6);
    assert.ok(result.roster.every((r) => r.eligibility === null && r.absenceDecision === null));
    assert.equal(result.absencePreview, null);
    assert.equal(result.onlineEvidence, null);
    assert.equal(result.finalization.configured, false);
    assert.deepEqual(result.reviewQueue, [{ studentId: "s-teacher", pendingReviewSince: minutesAfterStart(20) }]);
    // Approval history and visits are not even read.
    assert.ok(!calls.includes("studentConfirmationHistory.findMany"));
    assert.ok(!calls.includes("attendance.findMany"));
  });
}

for (const [label, evidenceValue, status] of [["missing", undefined, "MISSING"], ["invalid", "2026-08-15T00:00:00", "INVALID"]]) {
  test(`getRegister: evidence setting ${label}: classification and evidence check unavailable; eligibility still shown`, async () => {
    const result = await view(baseData(), env(FEATURE_ENV, evidenceValue));
    assert.deepEqual(result.configuration, { approval: "OK", evidence: status });
    assert.equal(result.classification, null);
    assert.equal(result.onlineEvidence, null);
    assert.equal(result.finalization.configured, false);
    // Eligibility comes from the approval setting only; nothing becomes eligible because evidence is off.
    assert.equal(byId(result.roster)["s-pending"].eligibility.outcome, "NOT_ELIGIBLE");
    assert.deepEqual(result.absencePreview.absentStudentIds, ["s-absent", "s-visitor", "s-teacher"]);
    assert.ok(!calls.includes("attendance.findMany"));
  });
}

test("getRegister: both settings missing: the register, records and sessions are still shown", async () => {
  const data = baseData();
  data.records = [teacherRecord("s-teacher")];
  const result = await view(data, {});
  assert.deepEqual(result.configuration, { approval: "MISSING", evidence: "MISSING" });
  assert.equal(result.records.length, 1);
  assert.equal(result.activeSessions.length, 1);
  assert.equal(result.register.graceMinutes, 10);
  assert.deepEqual(result.finalization.readiness, { allowed: false, reason: "SCHEDULED_END_NOT_PASSED" });
});

test("getRegister: a finalized register keeps its frozen schedule and classification (R5)", async () => {
  const data = baseData();
  // The lecture was later edited to start after the boundary; the frozen register still starts before it.
  data.lecture.date = new Date("2026-10-05T12:30:00.000Z");
  data.lecture.endDate = new Date("2026-10-05T14:30:00.000Z");
  data.register = {
    lectureId: L, classId: C, scheduledStartAt: START, scheduledEndAt: END, graceMinutes: 20,
    finalizedAt: minutesAfterStart(180), finalizedByTeacherId: T, version: 2, createdAt: START, updatedAt: minutesAfterStart(180),
  };
  const result = await view(data, env(FEATURE_ENV, HISTORICAL_ENV), minutesAfterStart(600));

  assert.equal(result.register.exists, true);
  assert.equal(result.register.scheduledStartAt, START);
  assert.equal(result.register.graceMinutes, 20);
  assert.equal(result.register.version, 2);
  assert.equal(result.classification, "HISTORICAL");
  assert.equal(result.absencePreview, null);
  assert.ok(result.roster.every((r) => r.absenceDecision === null));
  assert.deepEqual(result.finalization.readiness, { allowed: false, reason: "ALREADY_FINALIZED" });
});

test("getRegister: an open register is classified by its current scheduledStartAt", async () => {
  const data = baseData();
  data.register = {
    lectureId: L, classId: C, scheduledStartAt: new Date("2026-10-05T12:30:00.000Z"), scheduledEndAt: null, graceMinutes: 10,
    finalizedAt: null, finalizedByTeacherId: null, version: 3, createdAt: START, updatedAt: START,
  };
  const result = await view(data, env(FEATURE_ENV, HISTORICAL_ENV));
  assert.equal(result.classification, "LIVE");
  assert.deepEqual(result.finalization.readiness, { allowed: false, reason: "LECTURE_NOT_STARTED" });
});

test("getRegister: no setting value reaches the response", async () => {
  const value = "2026-07-28T00:00:00+05:30";
  const result = await view(baseData(), env(value, "garbage-SECRET"));
  const json = JSON.stringify(result);
  assert.ok(!json.includes("SECRET"));
  assert.ok(!json.includes(value));
});

test("getRegister: source has no write, lock or transaction call", () => {
  const source = fs.readFileSync(path.join(root, "services", "lecture-attendance-service.ts"), "utf8");
  // getRegister's body only (later functions in the file legitimately lock and write).
  const start = source.indexOf("export async function getRegister");
  const body = source.slice(start, source.indexOf("\n}\n", start) + 3);
  assert.ok(body.includes("finalizationReadiness"), "the whole getRegister body was captured");
  assert.doesNotMatch(body, /\$transaction|\$executeRaw|\$queryRaw|\.create\(|\.update\(|\.upsert\(|\.delete|createMany|updateMany|lock[A-Z]/);
});

test("evidenceRepresentation: NOT_ELIGIBLE visits are ignored; earliest eligible visit decides", () => {
  const context = { approvalFeatureStartedAt: new Date(FEATURE_ENV) };
  const student = { confirmationStatus: "APPROVED", confirmedAt: APPROVED_AT, approvedAt: APPROVED_AT, status: 0 };
  const history = [{ id: "h", fromStatus: "PENDING", toStatus: "APPROVED", decidedAt: APPROVED_AT, previousConfirmedAt: null }];
  const enrolments = [{ id: "e", classId: C, assignedAt: digits("2026-08-05T00:00:00Z"), removedAt: digits(minutesAfterStart(10).toISOString()), isActive: false }];

  const result = service.evidenceRepresentation({
    classification: "LIVE",
    classId: C,
    context,
    students: [
      // Visit after removal: NOT_ELIGIBLE, not evidence.
      { studentId: "a", student, history, enrolments, record: null, visitTimes: [minutesAfterStart(20)] },
      // Earliest eligible visit is at 3 minutes (the later one is not eligible).
      { studentId: "b", student, history, enrolments, record: null, visitTimes: [minutesAfterStart(20), minutesAfterStart(3)] },
      { studentId: "c", student, history, enrolments, record: { statusSource: "AUTO", firstOnlineAt: minutesAfterStart(3) }, visitTimes: [minutesAfterStart(3)] },
    ],
  });
  assert.deepEqual(result, { pending: [{ studentId: "b", earliestEligibleVisitAt: minutesAfterStart(3) }], unknownVisits: [] });
});
