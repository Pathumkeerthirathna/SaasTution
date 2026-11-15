/*
 * Teacher storage quota, Stage 3.2: enforcement for Lecture Notes uploads and
 * assignment submissions (services/storage-reservation-service.ts and the two
 * upload routes).
 *
 *   npm run test:storage-quota
 *
 * The REAL routes, reservation service, usage service and file storage run
 * (temporary folders; FILE_STORAGE_ROOT and the rollback copies are real
 * files). lib/prisma.ts is an in-memory FAKE that models what the quota logic
 * relies on:
 *   - pg_advisory_xact_lock: a per-key mutex held until the transaction ends
 *     (with an optional lock timeout);
 *   - a transaction that throws is rolled back (its writes undone);
 *   - every operation yields, so concurrent requests interleave.
 * It is NOT PostgreSQL: real locking / isolation is
 * tests/storage-quota/usage.db.test.cjs (skipped without a local test database).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
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

const B = (n) => BigInt(n);
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const L2 = "aaaaaaaa-0000-4000-8000-000000000002";
const A1 = "bbbbbbbb-0000-4000-8000-000000000001";
const A2 = "bbbbbbbb-0000-4000-8000-000000000002";

// ---- The fake database --------------------------------------------------------------------------------

const db = {};
function resetDb() {
  Object.assign(db, {
    nowMs: Date.parse("2026-11-16T10:00:00.000Z"),
    tables: { lectures: [], assignments: [], notes: [], submissions: [], recordings: [], sessions: [], reservations: [], limits: [], subscriptions: [] },
    locks: new Map(),
    lockTimeoutMs: null,
    maxConcurrentHolders: 0,
    hooks: {},
    logged: [],
    events: [],
    session: { teacherId: T1, studentId: "student-1" },
  });
}
resetDb();

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function acquire(key) {
  const started = Date.now();
  for (;;) {
    const holder = db.locks.get(key);
    if (!holder) break;
    if (db.lockTimeoutMs !== null) {
      const remaining = db.lockTimeoutMs - (Date.now() - started);
      if (remaining <= 0) throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "P2010", meta: { code: "55P03" } });
      await Promise.race([holder.promise, new Promise((r) => setTimeout(r, remaining))]);
    } else {
      await holder.promise;
    }
  }
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  db.locks.set(key, { promise });
  return () => {
    db.locks.delete(key);
    release();
  };
}

const teacherOfLecture = (lectureId) => db.tables.lectures.find((l) => l.id === lectureId)?.teacherId;
const teacherOfAssignment = (assignmentId) => teacherOfLecture(db.tables.assignments.find((a) => a.id === assignmentId)?.lectureId);
const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null])) : { ...row });

function makeClient(ctx) {
  const write = (undo) => ctx.undo?.push(undo);
  const client = {
    async $executeRaw(strings, ...values) {
      await tick();
      const sql = strings.join("?");
      if (/pg_advisory_xact_lock/.test(sql)) {
        if (!ctx.inTx) throw new Error("an xact lock outside a transaction");
        ctx.held.push(await acquire(values[0]));
        const holders = db.locks.size;
        db.maxConcurrentHolders = Math.max(db.maxConcurrentHolders, holders);
      }
      return 0;
    },
    async $executeRawUnsafe() {
      await tick();
      return 0;
    },
    async $queryRaw(strings, ...values) {
      await tick();
      const t = values[0];
      const notes = db.tables.notes.filter((n) => n.storageKey && teacherOfLecture(n.lectureId) === t).reduce((s, n) => s + B(n.sizeBytes), B(0));
      const subs = db.tables.submissions.filter((s) => s.storageKey && teacherOfAssignment(s.assignmentId) === t).reduce((s, x) => s + B(x.sizeBytes), B(0));
      return [{ notesBytes: notes, submissionsBytes: subs }];
    },
    lecture: {
      async findFirst({ where }) {
        await tick();
        const l = db.tables.lectures.find((x) => x.id === where.id && x.status === where.status && x.teacherId === where.class?.teacherId);
        return l ? { id: l.id, title: "L", classId: `class-${l.teacherId}`, date: new Date(), endDate: null, class: { id: `class-${l.teacherId}`, name: "C", schedule: "" } } : null;
      },
    },
    classStudent: { findMany: async () => [] },
    noteStudent: { createMany: async () => ({ count: 0 }) },
    note: {
      async create({ data, select }) {
        await tick();
        if (db.hooks.noteCreate) await db.hooks.noteCreate(data);
        const row = { ...data, status: 0 };
        db.tables.notes.push(row);
        write(() => db.tables.notes.splice(db.tables.notes.indexOf(row), 1));
        return pick(row, select);
      },
    },
    assignment: {
      async findFirst({ where }) {
        await tick();
        const a = db.tables.assignments.find((x) => x.id === where.id && x.status === where.status && x.enrolled.includes(where.lecture.class.students.some.studentId));
        return a ? { id: a.id, dueDate: new Date(), lectureId: a.lectureId, lecture: { classId: `class-${teacherOfLecture(a.lectureId)}`, class: { teacherId: teacherOfLecture(a.lectureId) } } } : null;
      },
      // Stage 3.6: the submit commit re-checks the assignment is still active.
      async count({ where }) {
        await tick();
        return db.tables.assignments.filter((x) => x.id === where.id && x.status === where.status).length;
      },
    },
    assignmentSubmission: {
      async findUnique({ where, select }) {
        await tick();
        const k = where.assignmentId_studentId;
        const s = db.tables.submissions.find((x) => x.assignmentId === k.assignmentId && x.studentId === k.studentId);
        return s ? pick(s, select) : null;
      },
      async updateMany({ where, data }) {
        await tick();
        if (db.hooks.beforeUpdateMany) await db.hooks.beforeUpdateMany();
        const s = db.tables.submissions.find((x) => x.id === where.id && x.fileUrl === where.fileUrl && (x.storageKey ?? null) === (where.storageKey ?? null));
        if (!s) return { count: 0 };
        const before = { ...s };
        Object.assign(s, data);
        write(() => Object.assign(s, before));
        return { count: 1 };
      },
      async create({ data }) {
        await tick();
        if (db.hooks.beforeSubmissionCreate) await db.hooks.beforeSubmissionCreate(data);
        if (db.tables.submissions.some((x) => x.assignmentId === data.assignmentId && x.studentId === data.studentId)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { ...data };
        db.tables.submissions.push(row);
        write(() => db.tables.submissions.splice(db.tables.submissions.indexOf(row), 1));
        return { id: data.id };
      },
    },
    storageReservation: {
      async create({ data, select }) {
        await tick();
        // The migration's CHECKs / unique index, as PostgreSQL would enforce them.
        if (data.bytes < B(1) || data.bytes > B(2147483647)) throw new Error("violates check constraint StorageReservation_bytes_range");
        if (!(data.expiresAt > data.createdAt)) throw new Error("violates check constraint StorageReservation_expiry_after_creation");
        if (!data.storageKey.startsWith(`Teachers/${data.teacherId}/`)) throw new Error("violates check constraint StorageReservation_storageKey_owner");
        if (db.tables.reservations.some((r) => r.storageKey === data.storageKey)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        const row = { ...data };
        db.tables.reservations.push(row);
        write(() => db.tables.reservations.splice(db.tables.reservations.indexOf(row), 1));
        return pick(row, select);
      },
      async findUnique({ where, select }) {
        await tick();
        const r = db.tables.reservations.find((x) => x.id === where.id);
        return r ? pick(r, select) : null;
      },
      async deleteMany({ where }) {
        await tick();
        if (!ctx.inTx && db.hooks.failRelease) throw new Error("connection lost");
        const match = (r) =>
          (where.id === undefined || r.id === where.id) &&
          (where.teacherId === undefined || r.teacherId === where.teacherId) &&
          (where.storageKey === undefined || r.storageKey === where.storageKey) &&
          (where.expiresAt === undefined || r.expiresAt.getTime() <= where.expiresAt.lte.getTime());
        const removed = db.tables.reservations.filter(match);
        db.tables.reservations = db.tables.reservations.filter((r) => !match(r));
        write(() => db.tables.reservations.push(...removed));
        return { count: removed.length };
      },
      async groupBy({ where }) {
        await tick();
        const live = db.tables.reservations.filter((r) => r.teacherId === where.teacherId && r.expiresAt.getTime() > where.expiresAt.gt.getTime());
        return ["NOTE", "SUBMISSION"]
          .map((category) => ({ category, rows: live.filter((r) => r.category === category) }))
          .filter((g) => g.rows.length)
          .map((g) => ({ category: g.category, _sum: { bytes: g.rows.reduce((s, r) => s + r.bytes, B(0)) } }));
      },
    },
    recordingUploadSession: { findMany: async ({ where }) => db.tables.sessions.filter((s) => s.teacherId === where.teacherId && where.state.in.includes(s.state)) },
    recordedLecture: {
      async aggregate({ where }) {
        await tick();
        const rows = db.tables.recordings.filter((r) => r.teacherId === where.teacherId && r.state === "READY");
        return { _sum: { sizeBytes: rows.length ? rows.reduce((s, r) => s + r.sizeBytes, B(0)) : null } };
      },
    },
    teacherStorageLimit: { findUnique: async ({ where }) => db.tables.limits.find((l) => l.teacherId === where.teacherId) ?? null },
    // Profile photos (PROFILE_IMAGE): none unless a test adds db.tables.profiles rows.
    teacherProfile: { findUnique: async ({ where }) => (db.tables.profiles ?? []).find((p) => p.teacherId === where.teacherId) ?? null },
    teacherSubscription: {
      async findFirst({ where }) {
        const now = where.OR[1].endDate.gt;
        const rows = db.tables.subscriptions
          .filter((s) => s.teacherId === where.teacherId && s.status === where.status && (s.endDate === null || s.endDate > now))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return rows[0] ? { plan: { storageGB: rows[0].storageGB } } : null;
      },
    },
  };
  return client;
}

const prisma = {
  ...makeClient({ inTx: false }),
  async $transaction(fn) {
    const ctx = { inTx: true, held: [], undo: [] };
    try {
      return await fn(makeClient(ctx));
    } catch (error) {
      for (const undo of ctx.undo.reverse()) undo();
      throw error;
    } finally {
      for (const release of ctx.held) release();
    }
  },
};
fake("lib/prisma.ts", { prisma });
fake("lib/server-clock.ts", { serverNow: async () => new Date(db.nowMs), serverNowSync: () => new Date(db.nowMs) });
fake("lib/error-logging/server-logger.ts", {
  logErrorEntry: (error, context) => {
    db.logged.push({ error, url: context?.request?.url });
    return null;
  },
});
fake("lib/session-events.ts", { emitStudentDataChange: (p) => db.events.push(p) });
const { AppError } = require(path.join(root, "lib", "error-handler.ts"));
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    if (!db.session.teacherId) throw new AppError("Unauthorized.", 401, "UNAUTHORIZED");
    return { role: "TEACHER", teacherId: db.session.teacherId, email: "t@example.test", name: "T" };
  },
  requireStudentSession: async () => ({ role: "STUDENT", studentId: db.session.studentId }),
});

const OR = require(path.join(root, "lib", "file-storage", "open-root.ts"));
const R = require(path.join(root, "services", "storage-reservation-service.ts"));
const { getTeacherStorageUsage } = require(path.join(root, "services", "teacher-storage-usage-service.ts"));
const notesRoute = require(path.join(root, "app", "api", "lectures", "[id]", "notes", "route.ts"));
const submitRoute = require(path.join(root, "app", "api", "assignments", "[assignmentId]", "submit", "route.ts"));
const NK = require(path.join(root, "lib", "notes", "storage-keys.ts"));

// ---- Sandbox and helpers ------------------------------------------------------------------------------

async function withSandbox(fn) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "q32-"));
  const app = path.join(base, "app");
  const files = path.join(base, "files");
  fs.mkdirSync(app);
  fs.mkdirSync(files);
  const prevCwd = process.cwd();
  const prevRoot = process.env.FILE_STORAGE_ROOT;
  const prevDual = process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE;
  process.env.FILE_STORAGE_ROOT = files;
  delete process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE; // the production default: dual-write ON
  OR.resetSharedFileStorageCacheForTests();
  process.chdir(app);
  try {
    return await fn({ base, app, files });
  } finally {
    process.chdir(prevCwd);
    if (prevRoot === undefined) delete process.env.FILE_STORAGE_ROOT;
    else process.env.FILE_STORAGE_ROOT = prevRoot;
    if (prevDual !== undefined) process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE = prevDual;
    OR.resetSharedFileStorageCacheForTests();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function filesBelow(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

function setup() {
  db.tables.lectures.push({ id: L1, teacherId: T1, status: 0 }, { id: L2, teacherId: T2, status: 0 });
  db.tables.assignments.push({ id: A1, lectureId: L1, status: 0, enrolled: ["student-1", "student-2", "student-3", "student-4"] });
  db.tables.assignments.push({ id: A2, lectureId: L2, status: 0, enrolled: ["student-1"] });
}
const limit = (teacherId, bytes) => db.tables.limits.push({ teacherId, limitBytes: B(bytes) });
/** A committed note of `size` bytes (a database reference; usage never reads files). */
const committedNote = (teacherId, size) =>
  db.tables.notes.push({ lectureId: teacherId === T1 ? L1 : L2, sizeBytes: size, storageKey: NK.noteFileKey({ teacherId, lectureId: teacherId === T1 ? L1 : L2, noteId: crypto.randomUUID(), storedName: NK.generateNoteStoredName("application/pdf") }) });

function uploadNote({ teacherId = T1, lectureId = L1, size = 100, type = "application/pdf" } = {}) {
  db.session.teacherId = teacherId;
  const form = new FormData();
  form.set("title", "Week 1");
  form.set("kind", "NOTE");
  form.set("file", new File([Buffer.alloc(size, 0x25)], "notes.pdf", { type }));
  return notesRoute.POST(new Request(`http://localhost/api/lectures/${lectureId}/notes`, { method: "POST", body: form }), { params: { id: lectureId } });
}

function submit({ studentId = "student-1", assignmentId = A1, size = 100, fill = 0x41 } = {}) {
  db.session.studentId = studentId;
  const form = new FormData();
  form.set("file", new File([Buffer.alloc(size, fill)], "answer.pdf", { type: "application/pdf" }));
  return submitRoute.POST(new Request(`http://localhost/api/assignments/${assignmentId}/submit`, { method: "POST", body: form }), { params: { assignmentId } });
}

const usage = (teacherId = T1) => getTeacherStorageUsage(teacherId);

test.beforeEach(() => {
  resetDb();
  setup();
});

// ==== Notes ==================================================================================================

test("notes: the exact boundary fits; one byte over is 413 STORAGE_QUOTA_EXCEEDED with the teacher's figures (decimal strings)", async () => {
  await withSandbox(async ({ files, app }) => {
    committedNote(T1, 900);
    limit(T1, 1000);
    const over = await uploadNote({ size: 101 });
    assert.equal(over.status, 413);
    const body = await over.json();
    assert.equal(body.error.code, "STORAGE_QUOTA_EXCEEDED");
    assert.deepEqual(body.error.details, { limitBytes: "1000", usedBytes: "900", reservedBytes: "0", requestedBytes: "101", remainingBytes: "100" });
    assert.deepEqual(filesBelow(files), [], "nothing written for a refused upload");
    assert.deepEqual(filesBelow(app), []);
    assert.equal(db.tables.reservations.length, 0);

    const exact = await uploadNote({ size: 100 });
    assert.equal(exact.status, 201);
    assert.equal(db.tables.reservations.length, 0, "the reservation is gone after the commit");
    const u = await usage();
    assert.deepEqual([u.committed.notes, u.remainingBytes], [B(1000), B(0)]);
  });
});

test("notes: success writes the new file and the rollback copy, but the copy is never counted", async () => {
  await withSandbox(async ({ files, app }) => {
    limit(T1, 10_000);
    assert.equal((await uploadNote({ size: 1234 })).status, 201);
    const note = db.tables.notes[0];
    assert.equal(note.sizeBytes, 1234);
    assert.deepEqual(filesBelow(files), [note.storageKey]);
    assert.equal(filesBelow(path.join(app, "storage")).length, 1, "the legacy rollback copy exists");
    const u = await usage();
    assert.equal(u.committed.notes, B(1234), "counted once, not twice");
    assert.equal(u.reserved.total, B(0));
  });
});

test("notes: unlimited plan, active plan limit, cancelled / expired plans ignored, override over an unlimited plan", async () => {
  await withSandbox(async () => {
    db.tables.subscriptions.push({ teacherId: T1, storageGB: null, status: "ACTIVE", endDate: null, updatedAt: new Date("2026-01-01") });
    assert.equal((await uploadNote({ size: 5000 })).status, 201, "unlimited plan");

    db.tables.subscriptions = [{ teacherId: T1, storageGB: 0, status: "ACTIVE", endDate: null, updatedAt: new Date("2026-01-01") }];
    assert.equal((await uploadNote({ size: 1 })).status, 413, "an active plan with 0 GB allows nothing");

    db.tables.subscriptions = [
      { teacherId: T1, storageGB: 0, status: "CANCELLED", endDate: null, updatedAt: new Date("2026-02-01") },
      { teacherId: T1, storageGB: 0, status: "EXPIRED", endDate: null, updatedAt: new Date("2026-03-01") },
    ];
    assert.equal((await uploadNote({ size: 1 })).status, 201, "cancelled / expired plans supply no limit");

    // 5000 + 1 bytes are committed now; an override of exactly that leaves nothing.
    limit(T1, 5001);
    db.tables.subscriptions = [{ teacherId: T1, storageGB: null, status: "ACTIVE", endDate: null, updatedAt: new Date("2026-01-01") }];
    assert.equal((await uploadNote({ size: 1 })).status, 413, "the override (5001 bytes, all used) applies over an unlimited plan");
  });
});

test("notes: live reservations count; an expired reservation does not, and is cleaned up by the next reservation", async () => {
  await withSandbox(async () => {
    limit(T1, 1000);
    const key = (n) => NK.noteFileKey({ teacherId: T1, lectureId: L1, noteId: `n${n}`, storedName: NK.generateNoteStoredName("application/pdf") });
    db.tables.reservations.push({ id: "live", teacherId: T1, category: "NOTE", bytes: B(950), storageKey: key(1), createdAt: new Date(db.nowMs), expiresAt: new Date(db.nowMs + 60_000) });
    db.tables.reservations.push({ id: "old", teacherId: T1, category: "SUBMISSION", bytes: B(1000), storageKey: key(2), createdAt: new Date(db.nowMs - 120_000), expiresAt: new Date(db.nowMs - 1) });
    const res = await uploadNote({ size: 51 });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.details.reservedBytes, "950", "the live reservation counts, the expired one does not");
    // A refused reservation rolls its whole transaction back (the expired row with it: it counts for nothing anyway).
    assert.equal((await uploadNote({ size: 50 })).status, 201);
    assert.deepEqual(db.tables.reservations.map((r) => r.id), ["live"], "the successful reservation's transaction removed the expired row");
  });
});

test("notes: a database failure after the files were written removes them and releases the reservation", async () => {
  await withSandbox(async ({ files, app }) => {
    limit(T1, 10_000);
    db.hooks.noteCreate = async () => {
      throw new Error("database unavailable");
    };
    assert.equal((await uploadNote({ size: 300 })).status, 500);
    assert.deepEqual(filesBelow(files), []);
    assert.deepEqual(filesBelow(path.join(app, "storage")), []);
    assert.equal(db.tables.reservations.length, 0);
    assert.equal(db.tables.notes.length, 0);
    assert.equal((await usage()).totalUsedAndReservedBytes, B(0));
  });
});

test("notes: ownership is still checked before any reservation (another teacher's lecture: 404, nothing reserved)", async () => {
  await withSandbox(async ({ files }) => {
    const res = await uploadNote({ teacherId: T2, lectureId: L1 });
    assert.equal(res.status, 404);
    assert.equal(db.tables.reservations.length, 0);
    assert.deepEqual(filesBelow(files), []);
  });
});

test("notes: five simultaneous uploads with room for two -> exactly two succeed; the quota is never exceeded", async () => {
  await withSandbox(async ({ files }) => {
    limit(T1, 250);
    const responses = await Promise.all(Array.from({ length: 5 }, () => uploadNote({ size: 100 })));
    const statuses = responses.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 201, 413, 413, 413]);
    const u = await usage();
    assert.equal(u.committed.notes, B(200));
    assert.ok(u.totalUsedAndReservedBytes <= B(250));
    assert.equal(db.tables.reservations.length, 0);
    assert.equal(filesBelow(files).length, 2, "only the two committed uploads have files");
  });
});

// ==== Submissions ==============================================================================================

test("submissions: first submission and resubmission; the FULL new size must fit even when it replaces a file", async () => {
  await withSandbox(async ({ files }) => {
    limit(T1, 1000);
    assert.equal((await submit({ size: 400 })).status, 201);
    assert.equal((await usage()).committed.submissions, B(400));

    // 400 committed + 601 new > 1000, although the 400 would be replaced.
    const tooBig = await submit({ size: 601 });
    assert.equal(tooBig.status, 413);
    assert.equal(db.tables.submissions[0].sizeBytes, 400, "the current submission is untouched");
    assert.equal(filesBelow(files).length, 1);

    assert.equal((await submit({ size: 600 })).status, 201, "400 + 600 = 1000 fits exactly");
    const u = await usage();
    assert.equal(u.committed.submissions, B(600), "after the commit only the new reference counts");
    assert.equal(u.reserved.total, B(0));
    assert.deepEqual(filesBelow(files), [db.tables.submissions[0].storageKey], "the replaced file was removed");
  });
});

test("submissions: students get a generic 413 without the teacher's quota or figures", async () => {
  await withSandbox(async () => {
    limit(T1, 10);
    const res = await submit({ size: 11 });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.code, "STORAGE_QUOTA_EXCEEDED");
    assert.equal(body.error.details, undefined, "no figures");
    assert.doesNotMatch(body.error.message, /\d/, "no numbers in the message");
    assert.match(body.error.message, /teacher's storage space is full/);
  });
});

test("submissions: concurrent resubmissions end with one referenced file, no reservations, usage = that file", async () => {
  await withSandbox(async ({ files, app }) => {
    limit(T1, 100_000);
    await submit({ size: 100 });
    const responses = await Promise.all([200, 300, 400, 500].map((size, i) => submit({ size, fill: 0x42 + i })));
    for (const r of responses) assert.ok([201, 409].includes(r.status), String(r.status));
    const row = db.tables.submissions[0];
    assert.deepEqual(filesBelow(files), [row.storageKey]);
    assert.deepEqual(filesBelow(path.join(app, "storage")), [row.fileUrl]);
    assert.equal(db.tables.reservations.length, 0);
    assert.equal((await usage()).committed.submissions, B(row.sizeBytes));
  });
});

test("submissions: a lost compare-and-set releases only its own reservation and files; the current submission is untouched", async () => {
  await withSandbox(async ({ files }) => {
    limit(T1, 100_000);
    await submit({ size: 100 });
    const original = { ...db.tables.submissions[0] };
    let raced = false;
    db.hooks.beforeUpdateMany = async () => {
      if (raced) return;
      raced = true;
      db.tables.submissions[0].fileUrl = "changed-by-someone-else"; // another request won
    };
    assert.equal((await submit({ size: 200 })).status, 201, "the retry wins");
    assert.equal(db.tables.reservations.length, 0, "both attempts' reservations are gone");
    assert.equal(filesBelow(files).length, 1, "the first attempt's file was discarded");
    assert.ok(fs.existsSync(path.join(files, ...db.tables.submissions[0].storageKey.split("/"))));
    assert.notEqual(db.tables.submissions[0].storageKey, original.storageKey);
  });
});

test("submissions: a database failure after the write removes the new files, releases the reservation, keeps the old submission", async () => {
  await withSandbox(async ({ files }) => {
    limit(T1, 100_000);
    await submit({ size: 100 });
    const before = { ...db.tables.submissions[0] };
    db.hooks.beforeUpdateMany = async () => {
      throw new Error("connection lost");
    };
    assert.equal((await submit({ size: 200 })).status, 500);
    assert.deepEqual(db.tables.submissions[0], before);
    assert.deepEqual(filesBelow(files), [before.storageKey]);
    assert.equal(db.tables.reservations.length, 0);
  });
});

test("submissions: four first submissions by different students with room for two -> exactly two", async () => {
  await withSandbox(async () => {
    limit(T1, 250);
    const responses = await Promise.all(["student-1", "student-2", "student-3", "student-4"].map((studentId) => submit({ studentId, size: 100 })));
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 201, 413, 413]);
    assert.equal((await usage()).committed.submissions, B(200));
    assert.equal(db.tables.reservations.length, 0);
  });
});

// ==== Mixed and isolation ========================================================================================

test("Notes and submissions of the same teacher at the same time share one quota: exactly three of six fit", async () => {
  await withSandbox(async () => {
    limit(T1, 300);
    const responses = await Promise.all([
      uploadNote({ size: 100 }),
      submit({ studentId: "student-1", size: 100 }),
      uploadNote({ size: 100 }),
      submit({ studentId: "student-2", size: 100 }),
      uploadNote({ size: 100 }),
      submit({ studentId: "student-3", size: 100 }),
    ]);
    assert.equal(responses.filter((r) => r.status === 201).length, 3);
    assert.equal(responses.filter((r) => r.status === 413).length, 3);
    const u = await usage();
    assert.equal(u.committed.total, B(300));
    assert.equal(db.tables.reservations.length, 0);
  });
});

test("two teachers are independent: one full, the other uploads at the same time", async () => {
  await withSandbox(async () => {
    limit(T1, 0);
    limit(T2, 1000);
    const [a, b, c] = await Promise.all([uploadNote({ teacherId: T1, lectureId: L1, size: 10 }), uploadNote({ teacherId: T2, lectureId: L2, size: 10 }), submit({ assignmentId: A2, size: 10 })]);
    assert.deepEqual([a.status, b.status, c.status], [413, 201, 201]);
    assert.equal((await usage(T2)).committed.total, B(20));
    assert.equal((await usage(T1)).committed.total, B(0));
  });
});

// ==== The reservation service directly =============================================================================

const noteKey = (teacherId = T1) => NK.noteFileKey({ teacherId, lectureId: L1, noteId: crypto.randomUUID(), storedName: NK.generateNoteStoredName("application/pdf") });

test("service: a reservation that expired before the commit is re-checked: refused when the space is gone, accepted when it is still free", async () => {
  limit(T1, 1000);
  const r1 = await R.reserveTeacherStorage({ teacherId: T1, category: "NOTE", storageKey: noteKey(), bytes: B(600), audience: "TEACHER" });
  db.nowMs += R.STORAGE_RESERVATION_TTL_MS + 1;
  committedNote(T1, 500); // meanwhile the space was used
  let called = false;
  await assert.rejects(R.commitTeacherStorageReservation(r1, "TEACHER", async () => (called = true)), { code: "STORAGE_QUOTA_EXCEEDED" });
  assert.equal(called, false, "nothing is written without capacity");

  const r2 = await R.reserveTeacherStorage({ teacherId: T1, category: "NOTE", storageKey: noteKey(), bytes: B(400), audience: "TEACHER" });
  db.nowMs += R.STORAGE_RESERVATION_TTL_MS + 1;
  assert.equal(await R.commitTeacherStorageReservation(r2, "TEACHER", async () => "written"), "written", "re-checked and still fits");
  assert.equal(db.tables.reservations.filter((r) => r.id === r2.id).length, 0);
});

test("service: a reservation of another teacher, category, key or size can never be used", async () => {
  limit(T1, 1000);
  const r = await R.reserveTeacherStorage({ teacherId: T1, category: "NOTE", storageKey: noteKey(), bytes: B(10), audience: "TEACHER" });
  for (const forged of [{ ...r, teacherId: T2 }, { ...r, category: "SUBMISSION" }, { ...r, storageKey: noteKey() }, { ...r, bytes: B(1) }]) {
    let called = false;
    await assert.rejects(R.commitTeacherStorageReservation(forged, "TEACHER", async () => (called = true)), /does not belong|STORAGE_QUOTA/);
    assert.equal(called, false);
  }
  assert.equal(db.tables.reservations.length, 1, "the real reservation is untouched");
});

test("service: a failing write inside the commit rolls back; the reservation stays until released", async () => {
  limit(T1, 1000);
  const r = await R.reserveTeacherStorage({ teacherId: T1, category: "NOTE", storageKey: noteKey(), bytes: B(10), audience: "TEACHER" });
  await assert.rejects(R.commitTeacherStorageReservation(r, "TEACHER", async () => {
    throw new Error("insert failed");
  }), /insert failed/);
  assert.equal(db.tables.reservations.length, 1);
  assert.equal(await R.releaseTeacherStorageReservation(r, "test"), true);
  assert.equal(db.tables.reservations.length, 0);
});

test("service: a release that fails is logged; the reservation stops counting when it expires", async () => {
  limit(T1, 100);
  const r = await R.reserveTeacherStorage({ teacherId: T1, category: "NOTE", storageKey: noteKey(), bytes: B(100), audience: "TEACHER" });
  db.hooks.failRelease = true;
  assert.equal(await R.releaseTeacherStorageReservation(r, "test cleanup"), false);
  assert.equal(db.logged.length, 1);
  assert.equal(db.logged[0].url, "http://internal/storage-quota/reservation");
  db.hooks.failRelease = false;
  assert.equal((await usage()).remainingBytes, B(0), "still reserved");
  db.nowMs += R.STORAGE_RESERVATION_TTL_MS;
  assert.equal((await usage()).remainingBytes, B(100), "expired: counted no more");
});

test("service: a failed Notes cleanup (release fails) still answers the original error and recovers by expiry", async () => {
  await withSandbox(async ({ files }) => {
    limit(T1, 1000);
    db.hooks.noteCreate = async () => {
      db.hooks.failRelease = true; // the release after this failure will fail too
      throw new Error("database unavailable");
    };
    assert.equal((await uploadNote({ size: 300 })).status, 500);
    assert.deepEqual(filesBelow(files), [], "the files were still removed");
    db.hooks = {};
    assert.equal(db.tables.reservations.length, 1, "the reservation could not be released");
    db.nowMs += R.STORAGE_RESERVATION_TTL_MS;
    assert.equal((await usage()).reserved.total, B(0));
    assert.equal((await uploadNote({ size: 1000 })).status, 201, "the full quota is usable again");
  });
});

test("service: the quota lock is held by one decision at a time per teacher; a lock timeout is 503 STORAGE_QUOTA_BUSY, not a failure", async () => {
  limit(T1, 1000);
  db.lockTimeoutMs = 50;
  let release;
  const holding = prisma.$transaction(async (tx) => {
    await tx.$executeRaw(["SELECT pg_advisory_xact_lock(hashtextextended(", ", 0))"], `storage-quota:teacher:${T1}`);
    await new Promise((r) => (release = r));
  });
  await tick();
  await tick();
  await assert.rejects(R.reserveTeacherStorage({ teacherId: T1, category: "NOTE", storageKey: noteKey(), bytes: B(1), audience: "TEACHER" }), { code: "STORAGE_QUOTA_BUSY", statusCode: 503 });
  // Another teacher is not blocked.
  limit(T2, 1000);
  await R.reserveTeacherStorage({ teacherId: T2, category: "NOTE", storageKey: NK.noteFileKey({ teacherId: T2, lectureId: L2, noteId: crypto.randomUUID(), storedName: NK.generateNoteStoredName("application/pdf") }), bytes: B(1), audience: "TEACHER" });
  release();
  await holding;
  db.lockTimeoutMs = null;
});

test("service: sizes outside the reservation range are refused before any database work", async () => {
  for (const bytes of [B(0), B(-1), B(2147483648)]) {
    await assert.rejects(R.reserveTeacherStorage({ teacherId: T1, category: "NOTE", storageKey: noteKey(), bytes, audience: "TEACHER" }), /Invalid reservation size/);
  }
  assert.equal(db.tables.reservations.length, 0);
});

// ==== Source guards ==============================================================================================

test("source: both routes reserve BEFORE writing and commit through the reservation service; nothing else changed in the flow", () => {
  const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const notes = read("app", "api", "lectures", "[id]", "notes", "route.ts");
  const post = notes.slice(notes.indexOf("export async function POST"));
  const at = (src, needle) => {
    const i = src.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };
  assert.ok(at(post, "await assertTeacherOwnsLecture(") < at(post, "await reserveTeacherStorage("));
  assert.ok(at(post, "await reserveTeacherStorage(") < at(post, "await storeUpload("));
  assert.ok(at(post, "await storeUpload(") < at(post, "await addNoteToLectureForTeacher("));
  assert.match(post, /reservation,\n\s+\}\);/);

  const sub = read("app", "api", "assignments", "[assignmentId]", "submit", "route.ts");
  const loop = sub.slice(sub.indexOf("for (let attempt = 1"));
  assert.ok(at(loop, "await reserveTeacherStorage(") < at(loop, "await storeUpload("));
  assert.ok(at(loop, "await storeUpload(") < at(loop, "await commitTeacherStorageReservation("));
  assert.match(loop, /audience: "STUDENT"/);
  assert.doesNotMatch(loop, /prisma\.assignmentSubmission\.(updateMany|create)\(/, "the row writes happen only inside the commit transaction");
});
