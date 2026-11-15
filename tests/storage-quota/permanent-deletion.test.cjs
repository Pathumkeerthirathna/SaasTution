/*
 * Teacher storage quota, Stage 3.6: PERMANENT deletion of Notes and of
 * assignments (cascading to every submission and its PDF), the pending
 * lifecycle, the maintenance retry, the submission block while an assignment
 * is pending, and the client-side confirmation / outcome helpers.
 * (Recorded Lectures purge: tests/recorded-lectures/maintenance.test.cjs and
 * teacher-recordings.test.cjs.)
 *
 *   npm run test:storage-quota
 *
 * No database: lib/prisma.ts is an in-memory fake (cascades as the schema
 * declares them: NoteStudent -> Note, AssignmentSubmission -> Assignment) that
 * records transactions and the quota-lock statements. These tests prove the
 * application logic only, NOT PostgreSQL behaviour (advisory locks, READ
 * COMMITTED visibility); see docs/unified-file-storage.md.
 * Real filesystem in fresh temporary folders: "<base>/app" is process.cwd()
 * (legacy storage/) and "<base>/files" is FILE_STORAGE_ROOT.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// ---- Fakes ------------------------------------------------------------------------------------------------

const T = "teacher-a";
const T2 = "teacher-b";
const L = "lecture-1";
const L2 = "lecture-2";

const db = {};
function resetDb() {
  Object.assign(db, {
    teacherId: T,
    studentId: "student-1",
    lectures: [
      { id: L, status: 0, classId: "class-1", teacherId: T },
      { id: L2, status: 0, classId: "class-2", teacherId: T2 },
    ],
    notes: [],
    noteStudents: [],
    assignments: [],
    submissions: [],
    tx: [],
    logged: [],
    events: [],
    hooks: {},
    failFindMany: false,
  });
}
resetDb();

fake("lib/error-logging/server-logger.ts", {
  logErrorEntry: (error, context) => {
    db.logged.push({ error, url: context?.request?.url, label: context?.label });
    return null;
  },
});
fake("lib/session-events.ts", { emitStudentDataChange: (payload) => db.events.push(payload) });
const { AppError } = require(path.join(root, "lib", "error-handler.ts"));
fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    if (!db.teacherId) throw new AppError("Unauthorized.", 401, "UNAUTHORIZED");
    return { role: "TEACHER", teacherId: db.teacherId, email: "t@example.test", name: "T" };
  },
  requireStudentSession: async () => ({ role: "STUDENT", studentId: db.studentId }),
});

const lectureOf = (id) => db.lectures.find((l) => l.id === id);
function lectureMatches(lectureId, where) {
  const l = lectureOf(lectureId);
  if (!l) return false;
  if (where.status !== undefined && l.status !== where.status) return false;
  if (where.class?.teacherId !== undefined && l.teacherId !== where.class.teacherId) return false;
  return true;
}
function scalarMatches(value, condition) {
  if (condition !== null && typeof condition === "object" && Array.isArray(condition.in)) return condition.in.includes(value);
  if (condition !== null && typeof condition === "object" && "gt" in condition) return value > condition.gt;
  return (value ?? null) === (condition ?? null);
}
function matches(row, where = {}) {
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (key === "lecture") {
      if (!lectureMatches(row.lectureId, condition)) return false;
      continue;
    }
    if (!scalarMatches(row[key], condition)) return false;
  }
  return true;
}
function shape(row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const [key, on] of Object.entries(select)) {
    if (on === true) out[key] = row[key] ?? null;
    else if (key === "lecture") {
      const l = lectureOf(row.lectureId);
      const sel = on.select;
      out.lecture = {};
      if (sel.classId) out.lecture.classId = l.classId;
      if (sel.class) out.lecture.class = { teacherId: l.teacherId };
    }
  }
  return out;
}
const sortTake = (rows, orderBy, take) => {
  const sorted = orderBy?.id ? [...rows].sort((a, b) => (a.id < b.id ? -1 : 1)) : rows;
  return take === undefined ? sorted : sorted.slice(0, take);
};

function model(table, { cascade } = {}) {
  return {
    async findFirst({ where, select }) {
      const row = db[table].find((r) => matches(r, where));
      return row ? shape(row, select) : null;
    },
    async findMany({ where, select, orderBy, take }) {
      if (db.failFindMany) throw new Error("database unavailable");
      return sortTake(db[table].filter((r) => matches(r, where)), orderBy, take).map((r) => shape(r, select));
    },
    async count({ where }) {
      return db[table].filter((r) => matches(r, where)).length;
    },
    async updateMany({ where, data }) {
      const rows = db[table].filter((r) => matches(r, where));
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
    async deleteMany({ where }) {
      const rows = db[table].filter((r) => matches(r, where));
      db[table] = db[table].filter((r) => !rows.includes(r));
      if (cascade) for (const r of rows) cascade(r);
      return { count: rows.length };
    },
  };
}

function client() {
  return {
    note: model("notes", { cascade: (n) => (db.noteStudents = db.noteStudents.filter((s) => s.noteId !== n.id)) }),
    assignment: {
      ...model("assignments", { cascade: (a) => (db.submissions = db.submissions.filter((s) => s.assignmentId !== a.id)) }),
      async findFirst({ where, select }) {
        // The submit route's student lookup (enrolment is not modelled: always enrolled).
        const { lecture, ...rest } = where;
        const row = db.assignments.find((r) => matches(r, rest) && (!lecture || lectureMatches(r.lectureId, { status: lecture.status, class: lecture.class?.teacherId ? lecture.class : undefined })));
        if (!row) return null;
        if (select?.lecture?.select?.class?.select?.teacherId) {
          const l = lectureOf(row.lectureId);
          return { id: row.id, dueDate: new Date(), lectureId: row.lectureId, lecture: { classId: l.classId, class: { teacherId: l.teacherId } } };
        }
        return shape(row, select);
      },
    },
    assignmentSubmission: {
      ...model("submissions"),
      async findUnique({ where, select }) {
        const k = where.assignmentId_studentId;
        const row = db.submissions.find((s) => s.assignmentId === k.assignmentId && s.studentId === k.studentId);
        return row ? shape(row, select) : null;
      },
      async create({ data }) {
        db.submissions.push({ ...data });
        return { id: data.id };
      },
    },
  };
}

const prisma = {
  ...client(),
  async $transaction(fn) {
    const log = [];
    db.tx.push(log);
    const tx = {
      ...client(),
      async $executeRawUnsafe(sql) {
        log.push(sql);
      },
      async $executeRaw(strings, ...values) {
        log.push(`${strings.join("?")} [${values.join(",")}]`);
        if (db.hooks.onQuotaLock) await db.hooks.onQuotaLock();
      },
    };
    const snapshot = JSON.stringify({ notes: db.notes, noteStudents: db.noteStudents, assignments: db.assignments, submissions: db.submissions });
    try {
      return await fn(tx);
    } catch (error) {
      Object.assign(db, JSON.parse(snapshot)); // rollback
      throw error;
    }
  },
};
fake("lib/prisma.ts", { prisma });
// The quota itself is tested in enforcement.test.cjs: a pass-through reservation service whose
// commit runs the route's callback in a transaction (so the Stage 3.6 re-check runs there).
fake("services/storage-reservation-service.ts", {
  reserveTeacherStorage: async (input) => ({ id: `res-${input.storageKey}`, ...input, expiresAt: new Date(Date.now() + 900_000) }),
  commitTeacherStorageReservation: async (_handle, _audience, fn) =>
    prisma.$transaction(async (tx) => {
      if (db.hooks.beforeCommit) await db.hooks.beforeCommit();
      return fn(tx);
    }),
  releaseTeacherStorageReservation: async () => true,
});

const OR = require(path.join(root, "lib", "file-storage", "open-root.ts"));
const NK = require(path.join(root, "lib", "notes", "storage-keys.ts"));
const SK = require(path.join(root, "lib", "assignments", "submission-keys.ts"));
const SF = require(path.join(root, "lib", "stored-files", "stored-file.ts"));
const PD = require(path.join(root, "services", "permanent-deletion-service.ts"));
const UI = require(path.join(root, "lib", "permanent-deletion", "client.ts"));
const route = (...p) => require(path.join(root, "app", "api", ...p, "route.ts"));
const noteRoute = route("lectures", "[id]", "notes", "[noteId]");
const assignmentRoute = route("lectures", "[id]", "assignments", "[assignmentId]");
const submit = route("assignments", "[assignmentId]", "submit");

// ---- Sandbox ------------------------------------------------------------------------------------------------

async function withSandbox(fn, { configureRoot = true } = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "st36-"));
  const app = path.join(base, "app");
  const files = path.join(base, "files");
  fs.mkdirSync(path.join(app, "storage"), { recursive: true });
  fs.mkdirSync(files);
  const previousCwd = process.cwd();
  const previousRoot = process.env.FILE_STORAGE_ROOT;
  const previousDual = process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE;
  if (configureRoot) process.env.FILE_STORAGE_ROOT = files;
  else delete process.env.FILE_STORAGE_ROOT;
  process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE = "off";
  OR.resetSharedFileStorageCacheForTests();
  process.chdir(app);
  try {
    return await fn({ base, app, files, setRoot: (on) => {
      if (on) process.env.FILE_STORAGE_ROOT = files;
      else delete process.env.FILE_STORAGE_ROOT;
      OR.resetSharedFileStorageCacheForTests();
    } });
  } finally {
    process.chdir(previousCwd);
    if (previousRoot === undefined) delete process.env.FILE_STORAGE_ROOT;
    else process.env.FILE_STORAGE_ROOT = previousRoot;
    if (previousDual === undefined) delete process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE;
    else process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE = previousDual;
    OR.resetSharedFileStorageCacheForTests();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function put(dir, relative, content = "data") {
  const file = path.join(dir, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
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

/** A note with its new-storage file (and, with `pairedCopy`, the dual-write rollback copy referenced by fileUrl). */
function addNote(sandbox, { id, lectureId = L, teacherId = T, status = 0, pairedCopy = false, storageKey } = {}) {
  const key = storageKey === undefined ? NK.noteFileKey({ teacherId, lectureId, noteId: id, storedName: NK.generateNoteStoredName("application/pdf") }) : storageKey;
  let fileUrl = key ?? `lectures/${lectureId}/legacy-${id}.pdf`;
  if (key && storageKey === undefined) put(sandbox.files, key, `note ${id}`);
  if (key && pairedCopy) {
    fileUrl = NK.noteLegacyCopyPath(key);
    put(path.join(sandbox.app, "storage"), fileUrl, `note ${id}`);
  }
  if (!key) put(path.join(sandbox.app, "storage"), fileUrl, "legacy original");
  const row = { id, lectureId, status, title: `Note ${id}`, storageKey: key, fileUrl, sha256: key ? "a".repeat(64) : null, sizeBytes: 9 };
  db.notes.push(row);
  db.noteStudents.push({ id: `ns-${id}`, noteId: id, studentId: "student-1" });
  return row;
}

function addAssignment(id, { lectureId = L, status = 0 } = {}) {
  const row = { id, lectureId, status, title: `Assignment ${id}` };
  db.assignments.push(row);
  return row;
}

function addSubmission(sandbox, { id, assignmentId, lectureId = L, teacherId = T, studentId = `student-${id}`, pairedCopy = false, legacyOnly = false, storageKey } = {}) {
  let key = null;
  let fileUrl;
  if (legacyOnly) {
    fileUrl = `assignments/${assignmentId}/170-old-${id}.pdf`;
    put(path.join(sandbox.app, "storage"), fileUrl, "%PDF legacy");
  } else {
    key = storageKey ?? SK.submissionFileKey({ teacherId, lectureId, assignmentId, submissionId: id, storedName: SK.generateSubmissionStoredName() });
    if (storageKey === undefined) put(sandbox.files, key, `%PDF ${id}`);
    fileUrl = key;
    if (pairedCopy) {
      fileUrl = SK.submissionLegacyCopyPath(key);
      put(path.join(sandbox.app, "storage"), fileUrl, `%PDF ${id}`);
    }
  }
  const row = { id, assignmentId, studentId, storageKey: key, fileUrl, sha256: key ? "b".repeat(64) : null, sizeBytes: 8, fileName: "a.pdf", mimeType: "application/pdf" };
  db.submissions.push(row);
  return row;
}

const del = (r, url, params) => r.DELETE(new Request(`http://localhost${url}`, { method: "DELETE" }), { params });
const deleteNote = (noteId, lectureId = L) => del(noteRoute, `/api/lectures/${lectureId}/notes/${noteId}`, { id: lectureId, noteId });
const deleteAssignment = (assignmentId, lectureId = L) => del(assignmentRoute, `/api/lectures/${lectureId}/assignments/${assignmentId}`, { id: lectureId, assignmentId });
const json = async (response) => ({ status: response.status, body: await response.json() });

test.beforeEach(() => {
  resetDb();
  PD.resetPendingDeletionRetryStateForTests();
});

// ==== 1. Strict removal helpers ========================================================================

test("strict removal: DELETED, MISSING (already gone = deleted), never a directory; the quiet helpers keep their boolean contract", async () => {
  await withSandbox(async (s) => {
    const key = NK.noteFileKey({ teacherId: T, lectureId: L, noteId: "n1", storedName: NK.generateNoteStoredName("application/pdf") });
    put(s.files, key);
    assert.equal(await SF.removeStoredFileStrict(key), "DELETED");
    assert.equal(await SF.removeStoredFileStrict(key), "MISSING");
    // A directory where the file should be: refused (never a directory delete).
    fs.mkdirSync(path.join(s.files, ...key.split("/")));
    await assert.rejects(() => SF.removeStoredFileStrict(key), (e) => e.code === "UNSAFE_PATH");
    assert.ok(fs.existsSync(path.join(s.files, ...key.split("/"))));

    const copy = NK.noteLegacyCopyPath(NK.noteFileKey({ teacherId: T, lectureId: L, noteId: "n2", storedName: NK.generateNoteStoredName("application/pdf") }));
    put(path.join(s.app, "storage"), copy);
    assert.equal(await SF.removeLegacyCopyStrict(copy), "DELETED");
    assert.equal(await SF.removeLegacyCopyStrict(copy), "MISSING");
    fs.mkdirSync(path.join(s.app, "storage", ...copy.split("/")));
    await assert.rejects(() => SF.removeLegacyCopyStrict(copy));
    assert.equal(await SF.removeLegacyCopyQuietly(copy, "test"), false, "quiet: a failure is false and logged");
    assert.equal(db.logged.length, 1);
  });
});

test("strict removal: storage not configured throws (the caller keeps the reference); a link is never followed", async () => {
  await withSandbox(async (s) => {
    const key = NK.noteFileKey({ teacherId: T, lectureId: L, noteId: "n1", storedName: NK.generateNoteStoredName("application/pdf") });
    await assert.rejects(() => SF.removeStoredFileStrict(key), (e) => e.code === "STORAGE_UNAVAILABLE");
    s.setRoot(true);
    const outside = put(s.base, "outside/victim.pdf", "keep me");
    const linkDir = path.join(s.files, "Teachers", T);
    fs.mkdirSync(path.dirname(linkDir), { recursive: true });
    try {
      fs.symlinkSync(path.join(s.base, "outside"), linkDir, "junction");
    } catch {
      return; // links not allowed here: covered by the storage layer's own tests
    }
    await SF.removeStoredFileStrict(`Teachers/${T}/victim.pdf`).catch(() => undefined);
    assert.ok(fs.existsSync(outside), "nothing outside the storage root is deleted through a link");
  }, { configureRoot: false });
});

// ==== 2. Notes =======================================================================================

test("note DELETE: permanent - the file and its paired rollback copy are deleted, then the row (and its view rows); 200 deleted", async () => {
  await withSandbox(async (s) => {
    const note = addNote(s, { id: "n1", pairedCopy: true });
    const sibling = addNote(s, { id: "n2" });
    const res = await json(await deleteNote("n1"));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { deleted: true, pending: false });
    assert.equal(res.body.message, "Note deleted permanently.");
    assert.equal(db.notes.some((n) => n.id === "n1"), false, "the row is gone (no longer counted in usage)");
    assert.equal(db.noteStudents.some((v) => v.noteId === "n1"), false, "view rows cascade");
    assert.equal(fs.existsSync(path.join(s.files, ...note.storageKey.split("/"))), false);
    assert.equal(fs.existsSync(path.join(s.app, "storage", ...note.fileUrl.split("/"))), false, "the paired copy too");
    assert.deepEqual(filesBelow(s.files), [sibling.storageKey], "nothing else is touched");
    assert.deepEqual(db.events, [{ classId: "class-1" }], "students' views refresh");
  });
});

test("note DELETE: a file already missing counts as deleted (idempotent retry after a partial deletion)", async () => {
  await withSandbox(async (s) => {
    const note = addNote(s, { id: "n1" });
    fs.rmSync(path.join(s.files, ...note.storageKey.split("/")));
    assert.equal((await deleteNote("n1")).status, 200);
    assert.equal(db.notes.length, 0);
  });
});

test("note DELETE: file deletion fails -> 202 pending; the row stays (status 2: hidden, still counted); a retry finishes it", async () => {
  await withSandbox(async (s) => {
    const note = addNote(s, { id: "n1" });
    s.setRoot(false); // storage unavailable
    const res = await json(await deleteNote("n1"));
    assert.equal(res.status, 202);
    assert.deepEqual(res.body.data, { deleted: false, pending: true });
    assert.match(res.body.message, /still being deleted/);
    assert.equal(db.notes[0].status, 2);
    assert.equal(db.notes[0].storageKey, note.storageKey, "still referenced, so usage still counts it");
    assert.ok(fs.existsSync(path.join(s.files, ...note.storageKey.split("/"))));
    assert.ok(db.logged.some((l) => l.url === "http://internal/storage/permanent-deletion"), "logged");
    s.setRoot(true);
    const again = await json(await deleteNote("n1"));
    assert.equal(again.status, 200, "the teacher's repeated DELETE retries a pending deletion");
    assert.equal(db.notes.length, 0);
    assert.deepEqual(filesBelow(s.files), []);
  });
});

test("note: maintenance retry (retryPendingDeletions) finishes pending notes; nothing active is touched", async () => {
  await withSandbox(async (s) => {
    const pending = addNote(s, { id: "n1", status: 2 });
    const active = addNote(s, { id: "n2" });
    const old = addNote(s, { id: "n3", status: 1 });
    const report = await PD.retryPendingDeletions();
    assert.deepEqual(report.notes, { examined: 1, deleted: 1, pending: 0, failed: 0, backoff: 0 });
    assert.deepEqual(db.notes.map((n) => n.id), ["n2", "n3"], "active and previously soft-deleted (status 1) notes are not touched");
    assert.deepEqual(filesBelow(s.files), [active.storageKey, old.storageKey].sort());
    assert.equal(fs.existsSync(path.join(s.files, ...pending.storageKey.split("/"))), false);
  });
});

test("note: a storage key that does not verify (another teacher / note) is NEVER deleted; the note stays pending, logged", async () => {
  await withSandbox(async (s) => {
    const victimKey = NK.noteFileKey({ teacherId: T2, lectureId: L2, noteId: "other", storedName: NK.generateNoteStoredName("application/pdf") });
    put(s.files, victimKey, "someone else's");
    const ownKey = NK.noteFileKey({ teacherId: T, lectureId: L, noteId: "different-note", storedName: NK.generateNoteStoredName("application/pdf") });
    put(s.files, ownKey, "another note's");
    addNote(s, { id: "n1", storageKey: victimKey });
    addNote(s, { id: "n2", storageKey: ownKey });
    for (const id of ["n1", "n2"]) {
      const res = await deleteNote(id);
      assert.equal(res.status, 202, id);
    }
    assert.deepEqual(filesBelow(s.files), [ownKey, victimKey].sort(), "nothing deleted");
    assert.deepEqual(db.notes.map((n) => n.status), [2, 2]);
    assert.ok(db.logged.length >= 2);
  });
});

test("note: rollback copy only when fileUrl is EXACTLY the copy paired with the key; legacy-only notes keep their legacy original", async () => {
  await withSandbox(async (s) => {
    // fileUrl points somewhere else (e.g. an older version's file): never deleted.
    const n1 = addNote(s, { id: "n1" });
    n1.fileUrl = "lectures/lecture-1/170-keep.pdf";
    const kept = put(path.join(s.app, "storage"), n1.fileUrl, "keep");
    // Legacy-only (storageKey null): the row goes, the unverifiable legacy file stays (documented retention).
    const n2 = addNote(s, { id: "n2", storageKey: null });
    assert.equal((await deleteNote("n1")).status, 200);
    assert.equal((await deleteNote("n2")).status, 200);
    assert.ok(fs.existsSync(kept));
    assert.ok(fs.existsSync(path.join(s.app, "storage", ...n2.fileUrl.split("/"))));
    assert.equal(db.notes.length, 0);
  });
});

test("note DELETE: ownership - another teacher, another lecture, a removed or unknown note: 404 and nothing changes", async () => {
  await withSandbox(async (s) => {
    const n1 = addNote(s, { id: "n1" });
    addNote(s, { id: "n3", status: 1 });
    db.teacherId = T2;
    assert.equal((await deleteNote("n1")).status, 404);
    db.teacherId = T;
    assert.equal((await deleteNote("n1", L2)).status, 404);
    assert.equal((await deleteNote("n3")).status, 404, "a note removed by an earlier version is not addressable");
    assert.equal((await deleteNote("missing")).status, 404);
    db.teacherId = null;
    assert.equal((await deleteNote("n1")).status, 401);
    assert.equal(db.notes.find((n) => n.id === "n1").status, 0);
    assert.ok(fs.existsSync(path.join(s.files, ...n1.storageKey.split("/"))));
  });
});

test("note DELETE: two concurrent requests end with one clean deletion (no error, nothing left)", async () => {
  await withSandbox(async (s) => {
    addNote(s, { id: "n1", pairedCopy: true });
    const results = await Promise.all([deleteNote("n1"), deleteNote("n1")]);
    // On Windows a second unlink of a file already being deleted can fail with EPERM (not ENOENT):
    // that request then answers 202 (safe: still pending) and the retry finishes it.
    for (const r of results) assert.ok([200, 202, 404].includes(r.status), String(r.status));
    if (db.notes.length > 0) {
      assert.equal(db.notes[0].status, 2, "never left active");
      await PD.retryPendingDeletions();
    }
    assert.equal(db.notes.length, 0);
    assert.deepEqual(filesBelow(s.files), []);
    assert.deepEqual(filesBelow(path.join(s.app, "storage")), []);
  });
});

// ==== 3. Assignments: cascade ==========================================================================

test("assignment DELETE: every submission's files (new + paired copy), every submission row, then the assignment; 200", async () => {
  await withSandbox(async (s) => {
    addAssignment("a1");
    addAssignment("a2");
    const s1 = addSubmission(s, { id: "s1", assignmentId: "a1", pairedCopy: true });
    const s2 = addSubmission(s, { id: "s2", assignmentId: "a1" });
    const s3 = addSubmission(s, { id: "s3", assignmentId: "a1", legacyOnly: true });
    const other = addSubmission(s, { id: "s4", assignmentId: "a2" });
    const res = await json(await deleteAssignment("a1"));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { deleted: true, pending: false });
    assert.equal(res.body.message, "Assignment and all submissions deleted permanently.");
    assert.deepEqual(db.assignments.map((a) => a.id), ["a2"]);
    assert.deepEqual(db.submissions.map((x) => x.id), ["s4"]);
    assert.deepEqual(filesBelow(s.files), [other.storageKey], "only the other assignment's file remains");
    assert.equal(fs.existsSync(path.join(s.app, "storage", ...s1.fileUrl.split("/"))), false);
    assert.ok(fs.existsSync(path.join(s.app, "storage", ...s3.fileUrl.split("/"))), "the legacy-only original is retained");
    assert.ok(!fs.existsSync(path.join(s.files, ...s2.storageKey.split("/"))));
    // Finalize: one transaction, SET LOCAL lock_timeout then the teacher's quota lock.
    const finalize = db.tx.at(-1);
    assert.match(finalize[0], /SET LOCAL lock_timeout/);
    assert.match(finalize[1], /pg_advisory_xact_lock/);
    assert.match(finalize[1], /storage-quota:teacher:teacher-a/);
  });
});

test("assignment: a failing file deletion -> 202 pending; the assignment stays (status 2) with the failing submission still referenced; a retry finishes", async () => {
  await withSandbox(async (s) => {
    addAssignment("a1");
    addSubmission(s, { id: "s1", assignmentId: "a1" });
    const s2 = addSubmission(s, { id: "s2", assignmentId: "a1" });
    addSubmission(s, { id: "s3", assignmentId: "a1" });
    // s2's file cannot be removed (a directory where the file should be: refused, never a directory delete).
    const target = path.join(s.files, ...s2.storageKey.split("/"));
    fs.rmSync(target);
    fs.mkdirSync(target);
    const res = await json(await deleteAssignment("a1"));
    assert.equal(res.status, 202);
    assert.deepEqual(res.body.data, { deleted: false, pending: true });
    assert.equal(db.assignments[0].status, 2);
    assert.deepEqual(db.submissions.map((x) => x.id), ["s2", "s3"], "stops at the failure: s1 done, s2 kept (still counted), s3 not reached");
    assert.ok(fs.existsSync(target));
    fs.rmdirSync(target);
    assert.equal((await deleteAssignment("a1")).status, 200, "the repeated DELETE retries the pending deletion");
    assert.equal(db.assignments.length, 0);
    assert.equal(db.submissions.length, 0);
    assert.deepEqual(filesBelow(s.files), []);
  });
});

test("assignment: a submission key that does not verify is never deleted; the assignment is never finalized", async () => {
  await withSandbox(async (s) => {
    addAssignment("a1");
    const foreign = SK.submissionFileKey({ teacherId: T2, lectureId: L2, assignmentId: "x", submissionId: "y", storedName: SK.generateSubmissionStoredName() });
    put(s.files, foreign, "%PDF foreign");
    addSubmission(s, { id: "s1", assignmentId: "a1", storageKey: foreign });
    assert.equal((await deleteAssignment("a1")).status, 202);
    assert.deepEqual(filesBelow(s.files), [foreign]);
    assert.equal(db.assignments[0].status, 2);
    assert.equal(db.submissions.length, 1);
    const report = await PD.retryPendingDeletions();
    assert.deepEqual(report.assignments, { examined: 1, deleted: 0, pending: 0, failed: 1, backoff: 0 });
    assert.deepEqual(filesBelow(s.files), [foreign], "maintenance never deletes it either");
  });
});

test("assignment finalize race: a submission committed just before the lock is deleted (files first) by the next pass, never cascade-deleted with its file left", async () => {
  await withSandbox(async (s) => {
    addAssignment("a1");
    addSubmission(s, { id: "s1", assignmentId: "a1" });
    let late = null;
    db.hooks.onQuotaLock = async () => {
      if (late) return;
      late = addSubmission(s, { id: "s9", assignmentId: "a1" }); // committed by a racing submit before the lock was granted
    };
    assert.equal((await deleteAssignment("a1")).status, 200);
    assert.ok(late);
    assert.equal(db.assignments.length, 0);
    assert.equal(db.submissions.length, 0);
    assert.deepEqual(filesBelow(s.files), [], "the late submission's PDF was deleted too");
    assert.equal(db.tx.length, 2, "first finalize saw it and did not delete; the second pass finalized");
  });
});

test("assignment: bounded per call (maxSubmissions) -> pending; the maintenance retry finishes the rest", async () => {
  await withSandbox(async (s) => {
    addAssignment("a1", { status: 2 });
    for (let i = 0; i < 5; i++) addSubmission(s, { id: `s${i}`, assignmentId: "a1" });
    assert.equal(await PD.purgePendingAssignment("a1", { maxSubmissions: 2 }), "PENDING");
    assert.equal(db.submissions.length, 3);
    assert.equal(db.assignments.length, 1);
    const report = await PD.retryPendingDeletions({ maxSubmissionsPerAssignment: 10 });
    assert.deepEqual(report.assignments, { examined: 1, deleted: 1, pending: 0, failed: 0, backoff: 0 });
    assert.equal(db.assignments.length, 0);
    assert.deepEqual(filesBelow(s.files), []);
  });
});

test("assignment DELETE: ownership - another teacher's or lecture's assignment: 404, nothing changes", async () => {
  await withSandbox(async (s) => {
    addAssignment("a1");
    addSubmission(s, { id: "s1", assignmentId: "a1" });
    db.teacherId = T2;
    assert.equal((await deleteAssignment("a1")).status, 404);
    db.teacherId = T;
    assert.equal((await deleteAssignment("a1", L2)).status, 404);
    assert.equal(db.assignments[0].status, 0);
    assert.equal(db.submissions.length, 1);
    assert.equal(filesBelow(s.files).length, 1);
  });
});

// ==== 4. No new submissions while pending ===============================================================

const submitForm = () => {
  const form = new FormData();
  form.set("file", new File([Buffer.from("%PDF-1.4 answer")], "answer.pdf", { type: "application/pdf" }));
  return form;
};
const doSubmit = (assignmentId) =>
  submit.POST(new Request(`http://localhost/api/assignments/${assignmentId}/submit`, { method: "POST", body: submitForm() }), { params: { assignmentId } });

test("submit: an assignment pending deletion accepts no submission (404); a mark that lands just before the commit is caught inside it; no file is left", async () => {
  await withSandbox(async (s) => {
    addAssignment("a1", { status: 2 });
    const refused = await json(await doSubmit("a1"));
    assert.equal(refused.status, 404);
    assert.equal(refused.body.error.code, "ASSIGNMENT_NOT_FOUND");

    addAssignment("a2");
    db.hooks.beforeCommit = async () => {
      db.assignments.find((a) => a.id === "a2").status = 2; // the teacher's DELETE marks it meanwhile
    };
    const raced = await json(await doSubmit("a2"));
    assert.equal(raced.status, 404);
    assert.equal(db.submissions.length, 0, "no row");
    assert.deepEqual(filesBelow(s.files), [], "the new file was discarded");

    db.hooks.beforeCommit = null;
    addAssignment("a3");
    assert.equal((await doSubmit("a3")).status, 201, "an active assignment still accepts submissions");
  });
});

// ==== 5. Maintenance retry =================================================================================

test("retryPendingDeletions never throws (a database failure is logged) and respects its deadline", async () => {
  await withSandbox(async (s) => {
    addNote(s, { id: "n1", status: 2 });
    db.failFindMany = true;
    const failed = await PD.retryPendingDeletions();
    assert.deepEqual(failed.notes, { examined: 0, deleted: 0, pending: 0, failed: 0, backoff: 0 });
    assert.ok(db.logged.some((l) => l.url === "http://internal/storage/permanent-deletion"));
    db.failFindMany = false;
    const late = await PD.retryPendingDeletions({ deadlineMs: Date.now() - 1 });
    assert.equal(late.notes.examined, 0);
    assert.equal(db.notes.length, 1);
  });
});

test("scheduler: the existing tick (same overlap guard) runs the recording purge and the Notes / assignment retry; no second scheduler or endpoint", () => {
  const scheduler = code(read("services", "recorded-lecture-maintenance-scheduler.ts"));
  const tick = scheduler.slice(scheduler.indexOf("export async function runMaintenanceTick"), scheduler.indexOf("function newState"));
  assert.ok(tick.indexOf("if (state.running) return null;") < tick.indexOf("retryPendingDeletions("), "inside the overlap guard");
  assert.match(tick, /purge: true/);
  assert.match(tick, /retryPendingDeletions\(\{ deadlineMs: Date\.now\(\) \+ PENDING_DELETION_BUDGET_MS \}\)/);
  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(e.name) && /retryPendingDeletions\(|purgeRemovedRecordings\(/.test(code(read(...rel.split("/"))))) callers.push(rel);
    }
  };
  for (const dir of ["app", "components", "lib", "services"]) walk(dir);
  assert.deepEqual(callers.sort(), [
    "services/permanent-deletion-service.ts",
    "services/recorded-lecture-maintenance-scheduler.ts",
    "services/recorded-lecture-maintenance-service.ts",
  ]);
  assert.doesNotMatch(code(read("services", "permanent-deletion-service.ts")), /setInterval|setTimeout/, "no timer of its own");
});

// ==== 6. Security (source) ===================================================================================

test("security: deletion only through the strict single-file helpers; the rollback copy only as the key's derived pair; no directory or recursive delete", () => {
  const src = code(read("services", "permanent-deletion-service.ts"));
  assert.doesNotMatch(src, /node:fs|rmSync|\brm\(|rmdir|recursive|unlink/);
  assert.equal((src.match(/removeLegacyCopyStrict\(/g) || []).length, 1);
  assert.match(src, /const pairedCopy = legacyCopyPathFor\(kind, storageKey\);\s*if \(pairedCopy && fileUrl === pairedCopy\) await removeLegacyCopyStrict\(pairedCopy\);/);
  assert.match(src, /parsed\.teacherId !== row\.lecture\.class\.teacherId \|\| parsed\.lectureId !== row\.lectureId \|\| parsed\.noteId !== row\.id/);
  assert.match(src, /parsed\.submissionId !== submission\.id/);
  // The teacher comes from the database (ownership), never from the request.
  for (const rel of [["app", "api", "lectures", "[id]", "notes", "[noteId]", "route.ts"], ["app", "api", "lectures", "[id]", "assignments", "[assignmentId]", "route.ts"]]) {
    const route = code(read(...rel));
    assert.match(route, /requireTeacherSession\(\)/);
    assert.match(route, /session\.teacherId/);
    assert.match(route, /status: 202/);
  }
});

// ==== 7. Client helpers (confirmation and outcome) ============================================================

test("client: confirmations say permanent / cannot be undone; the assignment one names ALL submissions and PDFs", () => {
  assert.match(UI.noteDeletionConfirmText("Week 1"), /Permanently delete note "Week 1"\?[\s\S]*cannot be undone/);
  const a = UI.assignmentDeletionConfirmText("Essay");
  assert.match(a, /ALL student submissions/);
  assert.match(a, /ALL submitted PDF files/);
  assert.match(a, /cannot be undone/);
  assert.match(UI.RECORDING_DELETION_WARNING, /deleted permanently[\s\S]*cannot be undone/);
});

test("client: success ONLY for 200 + deleted; 202 + pending is pending; anything else an error with the server's message", () => {
  const L_ = UI.NOTE_DELETION_LABELS;
  assert.equal(UI.readDeletionOutcome(200, { success: true, data: { deleted: true, pending: false } }, L_).kind, "deleted");
  assert.equal(UI.readDeletionOutcome(202, { success: true, data: { deleted: false, pending: true } }, L_).kind, "pending");
  assert.equal(UI.readDeletionOutcome(200, { success: true, data: { deleted: false } }, L_).kind, "error", "never success without deleted: true");
  assert.equal(UI.readDeletionOutcome(202, { success: true, data: {} }, L_).kind, "error");
  assert.deepEqual(UI.readDeletionOutcome(404, { success: false, error: { message: "Note not found." } }, L_), { kind: "error", message: "Note not found." });
  assert.deepEqual(UI.readDeletionOutcome(502, null, L_), { kind: "error", message: "Failed to delete note." });
});

test("client panels: the irreversible confirmation, pending shown separately from success, duplicate clicks ignored", () => {
  for (const [file, confirmFn, labels] of [
    ["lecture-note-panel.tsx", "noteDeletionConfirmText", "NOTE_DELETION_LABELS"],
    ["lecture-assignment-panel.tsx", "assignmentDeletionConfirmText", "ASSIGNMENT_DELETION_LABELS"],
  ]) {
    const src = read("components", file);
    assert.match(src, new RegExp(`window\\.confirm\\(${confirmFn}\\(`), file);
    assert.match(src, new RegExp(`readDeletionOutcome\\(response\\.status, \\w+, ${labels}\\)`), file);
    assert.match(src, /setPendingMessage\(outcome\.message\)/, file);
    assert.match(src, /role="status" className="notice-info/, file);
    assert.match(src, /if \(deletingRef\.current\) \{\s*return;\s*\}/, file);
    assert.match(src, /Delete permanently/, file);
    assert.doesNotMatch(src, /deleted successfully/, file);
  }
  const rl = read("components", "recorded-lectures", "teacher-recordings-client.tsx");
  assert.match(rl, /Permanently delete part/);
  assert.match(rl, /RECORDING_DELETION_WARNING/);
  assert.match(rl, /response\.status === 202/);
  assert.match(rl, /if \(!confirmDelete \|\| deleting\) return;/);
});

// ==== 8. Stage 3.7: crash recovery, path safety, fairness ====================================================

test("crash after the mark (status 2 committed, files untouched): the maintenance retry finishes notes AND a whole assignment", async () => {
  await withSandbox(async (s) => {
    const note = addNote(s, { id: "n1", status: 2, pairedCopy: true });
    addAssignment("a1", { status: 2 });
    addSubmission(s, { id: "s1", assignmentId: "a1", pairedCopy: true });
    addSubmission(s, { id: "s2", assignmentId: "a1" });
    const report = await PD.retryPendingDeletions();
    assert.equal(report.notes.deleted, 1);
    assert.equal(report.assignments.deleted, 1);
    assert.deepEqual([db.notes.length, db.assignments.length, db.submissions.length], [0, 0, 0]);
    assert.deepEqual(filesBelow(s.files), []);
    assert.deepEqual(filesBelow(path.join(s.app, "storage")), []);
    assert.ok(note);
  });
});

test("crash after the physical delete but before finalize (files gone, rows pending): the retry finalizes; usage rows stay until then", async () => {
  await withSandbox(async (s) => {
    const note = addNote(s, { id: "n1", status: 2, pairedCopy: true });
    fs.rmSync(path.join(s.files, ...note.storageKey.split("/")));
    fs.rmSync(path.join(s.app, "storage", ...note.fileUrl.split("/")));
    addAssignment("a1", { status: 2 });
    const sub = addSubmission(s, { id: "s1", assignmentId: "a1" });
    fs.rmSync(path.join(s.files, ...sub.storageKey.split("/")));
    assert.equal(db.notes.length + db.submissions.length, 2, "before the retry the rows (= usage) are still there");
    await PD.retryPendingDeletions();
    assert.deepEqual([db.notes.length, db.assignments.length, db.submissions.length], [0, 0, 0]);
  });
});

test("a traversal or absolute storage key is never resolved or deleted (key verification first)", async () => {
  await withSandbox(async (s) => {
    const outside = put(s.base, "outside/secret.pdf", "keep");
    const inside = put(s.files, `Teachers/${T}/keep.pdf`, "keep");
    const keys = [
      `Teachers/${T}/Lectures/${L}/Notes/n1/../../../../../outside/secret.pdf`,
      `Teachers/${T}/Lectures/${L}/Notes/n1/../../../keep.pdf`,
      outside,
      `Teachers/${T}/Lectures/${L}/Notes/n1/${"a".repeat(32)}.pdf/..`,
    ];
    keys.forEach((key, i) => addNote(s, { id: `n${i + 1}`, storageKey: key }));
    db.notes.forEach((n) => (n.status = 2));
    const report = await PD.retryPendingDeletions();
    assert.equal(report.notes.failed, keys.length);
    assert.ok(fs.existsSync(outside));
    assert.ok(fs.existsSync(inside));
    assert.equal(db.notes.length, keys.length, "never finalized");
  });
});

test("permission denied (any storage I/O error) during deletion: pending, nothing finalized, quota rows kept; the error log has no physical path", async () => {
  await withSandbox(async (s) => {
    addAssignment("a1");
    const sub = addSubmission(s, { id: "s1", assignmentId: "a1" });
    const opened = await OR.getSharedFileStorage();
    const { StorageError } = require(path.join(root, "lib", "file-storage", "types.ts"));
    const original = opened.storage.remove;
    opened.storage.remove = async () => {
      throw new StorageError("IO_ERROR");
    };
    try {
      assert.equal((await deleteAssignment("a1")).status, 202);
    } finally {
      opened.storage.remove = original;
    }
    assert.equal(db.submissions.length, 1);
    assert.equal(db.assignments[0].status, 2);
    assert.ok(fs.existsSync(path.join(s.files, ...sub.storageKey.split("/"))));
    for (const entry of db.logged) {
      const text = `${entry.error?.message ?? ""}`;
      assert.ok(!text.includes(s.base) && !text.includes(s.files), text);
    }
    assert.equal((await deleteAssignment("a1")).status, 200, "retry after the problem is fixed");
  });
});

test("rollback-copy removal failures are reported without the absolute path (never the raw Node error)", () => {
  const src = code(read("lib", "stored-files", "stored-file.ts"));
  const fn = src.slice(src.indexOf("export async function removeLegacyCopyStrict"), src.indexOf("export type StoredUploadResult"));
  assert.match(fn, /if \(error instanceof LegacyCopyError\) throw error;/);
  assert.match(fn, /throw new LegacyCopyError\("IO_ERROR"/);
  assert.doesNotMatch(fn.slice(fn.indexOf("catch (error)")), /throw error;\s*\}\s*\}$/);
});

test("fairness: items that keep failing never starve the others (the next pass continues after them)", async () => {
  await withSandbox(async (s) => {
    for (const id of ["n1", "n2", "n3"]) {
      const foreign = NK.noteFileKey({ teacherId: T2, lectureId: L2, noteId: `x${id}`, storedName: NK.generateNoteStoredName("application/pdf") });
      addNote(s, { id, status: 2, storageKey: foreign }); // never verifies
    }
    addNote(s, { id: "n9", status: 2 });
    const first = await PD.retryPendingDeletions({ maxNotes: 2 });
    assert.deepEqual([first.notes.failed, first.notes.deleted], [2, 0]);
    const second = await PD.retryPendingDeletions({ maxNotes: 2 });
    assert.equal(second.notes.deleted, 1, "n9 is reached on the next pass, after n1 / n2");
    assert.ok(!db.notes.some((n) => n.id === "n9"));
  });
});

test("backoff: a failed item is retried after 1, 2, 4 ... minutes (logged once per attempt, not every tick); success clears it", async () => {
  await withSandbox(async (s) => {
    addNote(s, { id: "n1", status: 2 });
    s.setRoot(false);
    const first = await PD.retryPendingDeletions();
    assert.equal(first.notes.failed, 1);
    const logged = db.logged.length;
    const second = await PD.retryPendingDeletions();
    assert.deepEqual([second.notes.examined, second.notes.backoff], [0, 1], "skipped while backing off");
    assert.equal(db.logged.length, logged, "no new log entry");
    assert.deepEqual([1, 2, 3, 7, 8, 30].map((n) => PD.pendingDeletionBackoffMs(n) / 60_000), [1, 2, 4, 60, 60, 60]);
    s.setRoot(true);
  });
});

test("backoff never blocks the teacher's own retry (DELETE ignores it)", async () => {
  await withSandbox(async (s) => {
    addNote(s, { id: "n1" });
    s.setRoot(false);
    assert.equal((await deleteNote("n1")).status, 202);
    assert.equal((await PD.retryPendingDeletions()).notes.failed, 1);
    s.setRoot(true);
    assert.equal((await deleteNote("n1")).status, 200);
  });
});
