/*
 * Unified storage, Stage 2: the shared storage opener, the Notes / submission
 * storage keys, the shared write / read module, and the Notes and assignment
 * submission routes on top of them.
 *
 *   npm run test:storage-migration
 *
 * No database: lib/prisma.ts is an in-memory fake that RECORDS every access
 * query (so the existing authorization clauses can be compared exactly), and
 * lib/auth-session.ts is a fake session. Real filesystem in fresh temporary
 * folders: "<base>/app" is process.cwd() (with the legacy storage/ and
 * public/uploads/ folders) and "<base>/files" is FILE_STORAGE_ROOT. Symbolic-
 * link cases use junctions / links where the platform allows them.
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
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// ---- Fakes ---------------------------------------------------------------------------------------------

const state = {};
function resetState() {
  Object.assign(state, {
    teacherId: "teacher-a",
    studentId: "student-1",
    notes: [],
    submissions: [],
    assignments: [],
    lectures: [],
    queries: [],
    notesCreated: [],
    hooks: {},
    logged: [],
    events: [],
  });
}
resetState();

fake("lib/error-logging/server-logger.ts", {
  logErrorEntry: (error, context) => {
    state.logged.push({ error, url: context?.request?.url });
    return null;
  },
});
fake("lib/session-events.ts", { emitStudentDataChange: (payload) => state.events.push(payload) });

const { AppError } = require(path.join(root, "lib", "error-handler.ts"));

fake("lib/auth-session.ts", {
  requireTeacherSession: async () => {
    if (!state.teacherId) throw new AppError("Unauthorized.", 401, "UNAUTHORIZED");
    return { role: "TEACHER", teacherId: state.teacherId, email: "t@example.test", name: "T" };
  },
  requireStudentSession: async () => {
    if (!state.studentId) throw new AppError("Unauthorized.", 401, "UNAUTHORIZED");
    return { role: "STUDENT", studentId: state.studentId };
  },
});

/**
 * An UPDATE as PostgreSQL runs it with the migration's trigger
 * (unified_storage_clear_stale_storage_key; its SQL is checked in migration-guard.test.cjs):
 * a changed fileUrl with an unchanged storageKey clears storageKey and sha256.
 */
function applyUpdateWithTrigger(row, data) {
  const next = { ...row, ...data };
  if ("fileUrl" in data && next.fileUrl !== row.fileUrl && (next.storageKey ?? null) === (row.storageKey ?? null)) {
    next.storageKey = null;
    next.sha256 = null;
  }
  Object.assign(row, next);
}

const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k] === true).map((k) => [k, row[k] ?? null])) : row);

const prisma = {
  lecture: {
    async findFirst({ where }) {
      state.queries.push(["lecture.findFirst", where]);
      const l = state.lectures.find((x) => x.id === where.id && x.status === where.status && x.teacherId === where.class?.teacherId);
      return l ? { id: l.id, title: "L", classId: l.classId, date: new Date(), endDate: null, class: { id: l.classId, name: "C", schedule: "" } } : null;
    },
  },
  classStudent: { findMany: async () => [] },
  noteStudent: {
    createMany: async () => ({ count: 0 }),
    findUnique: async () => ({ viewed: true }),
  },
  note: {
    async create({ data }) {
      if (state.hooks.noteCreate) await state.hooks.noteCreate(data);
      state.notesCreated.push(data);
      return { id: data.id, lectureId: data.lectureId, title: data.title, kind: data.kind, mimeType: data.mimeType, sizeBytes: data.sizeBytes };
    },
    async findFirst({ where, select }) {
      state.queries.push(["note.findFirst", where]);
      const n = state.notes.find((x) => {
        if (x.id !== where.id || x.status !== where.status) return false;
        if (where.lectureId !== undefined && x.lectureId !== where.lectureId) return false;
        if (where.visibility && (x.visibility !== where.visibility || x.access !== where.access)) return false;
        if (where.lecture?.status !== undefined && x.lectureStatus !== where.lecture.status) return false;
        if (where.lecture?.class?.teacherId !== undefined && x.teacherId !== where.lecture.class.teacherId) return false;
        if (where.lecture?.class?.students && !x.enrolled.includes(where.lecture.class.students.some.studentId)) return false;
        return true;
      });
      return n ? pick(n, select) : null;
    },
    async update({ where, select }) {
      const n = state.notes.find((x) => x.id === where.id);
      return pick(n, select);
    },
  },
  assignment: {
    async findFirst({ where }) {
      state.queries.push(["assignment.findFirst", where]);
      const a = state.assignments.find(
        (x) => x.id === where.id && x.status === where.status && x.lectureStatus === where.lecture.status && x.enrolled.includes(where.lecture.class.students.some.studentId)
      );
      return a ? { id: a.id, dueDate: new Date(), lectureId: a.lectureId, lecture: { classId: a.classId, class: { teacherId: a.teacherId } } } : null;
    },
    // Stage 3.6: the submit commit re-checks the assignment is still active (not pending deletion).
    async count({ where }) {
      return state.assignments.filter((x) => x.id === where.id && x.status === where.status).length;
    },
  },
  assignmentSubmission: {
    async findUnique({ where, select }) {
      const key = where.assignmentId_studentId;
      const s = state.submissions.find((x) => x.assignmentId === key.assignmentId && x.studentId === key.studentId);
      return s ? pick(s, select) : null;
    },
    async findFirst({ where, select }) {
      state.queries.push(["assignmentSubmission.findFirst", where]);
      const s = state.submissions.find((x) => x.id === where.id && x.assignmentId === where.assignmentId);
      const a = s && state.assignments.find((x) => x.id === s.assignmentId);
      if (!s || !a) return null;
      if (a.lectureId !== where.assignment.lectureId || a.status !== where.assignment.status || a.lectureStatus !== where.assignment.lecture.status) return null;
      if (a.teacherId !== where.assignment.lecture.class.teacherId) return null;
      return { ...pick(s, select), student: { name: "Student One" } };
    },
    async updateMany({ where, data }) {
      if (state.hooks.beforeUpdateMany) await state.hooks.beforeUpdateMany();
      const s = state.submissions.find((x) => x.id === where.id && x.fileUrl === where.fileUrl && (x.storageKey ?? null) === (where.storageKey ?? null));
      if (!s) return { count: 0 };
      applyUpdateWithTrigger(s, data);
      return { count: 1 };
    },
    async create({ data }) {
      if (state.hooks.beforeCreate) await state.hooks.beforeCreate(data);
      if (state.submissions.some((x) => x.assignmentId === data.assignmentId && x.studentId === data.studentId)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      state.submissions.push({ ...data });
      return { id: data.id };
    },
  },
};
fake("lib/prisma.ts", { prisma });
// Storage quota (Stage 3.2) is tested in tests/storage-quota/enforcement.test.cjs. Here the
// reservation service is a pass-through (an unlimited quota): these tests cover file storage,
// authorization and the existing route behaviour, unchanged.
fake("services/storage-reservation-service.ts", {
  reserveTeacherStorage: async (input) => ({ id: `res-${input.storageKey}`, ...input, expiresAt: new Date(Date.now() + 900_000) }),
  commitTeacherStorageReservation: async (_handle, _audience, fn) => fn(prisma),
  releaseTeacherStorageReservation: async () => true,
});

const OR = require(path.join(root, "lib", "file-storage", "open-root.ts"));
const NK = require(path.join(root, "lib", "notes", "storage-keys.ts"));
const SK = require(path.join(root, "lib", "assignments", "submission-keys.ts"));
const SF = require(path.join(root, "lib", "stored-files", "stored-file.ts"));
const route = (...p) => require(path.join(root, "app", "api", ...p, "route.ts"));
const notesUpload = route("lectures", "[id]", "notes");
const teacherDownload = route("lectures", "notes", "[id]", "download");
const teacherPreview = route("lectures", "notes", "[id]", "preview");
const studentNoteFile = route("student", "lectures", "[lectureId]", "notes", "[noteId]", "file");
const publicPreview = route("public", "class-notes", "[id]", "preview");
const submit = route("assignments", "[assignmentId]", "submit");
const submitFile = route("assignments", "[assignmentId]", "submit", "file");
const teacherSubmissionFile = route("lectures", "[id]", "assignments", "[assignmentId]", "submissions", "[submissionId]", "file");

// ---- Sandbox ------------------------------------------------------------------------------------------

function tempBase() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "st2-"));
}

/**
 * cwd = <base>/app (legacy storage/ and public/uploads/), FILE_STORAGE_ROOT = <base>/files.
 * dualWrite: "off" (new storage only: the Stage 2 behaviour after the rollback window) by
 * default here; "unset" = the variable unset = the production default (ON).
 */
async function withSandbox(fn, { configureRoot = true, dualWrite = "off" } = {}) {
  const base = tempBase();
  const app = path.join(base, "app");
  const files = path.join(base, "files");
  fs.mkdirSync(path.join(app, "storage"), { recursive: true });
  fs.mkdirSync(path.join(app, "public", "uploads"), { recursive: true });
  fs.mkdirSync(files);
  const previousCwd = process.cwd();
  const previousRoot = process.env.FILE_STORAGE_ROOT;
  const previousDual = process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE;
  if (configureRoot) process.env.FILE_STORAGE_ROOT = files;
  else delete process.env.FILE_STORAGE_ROOT;
  if (dualWrite === "unset") delete process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE;
  else process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE = dualWrite;
  OR.resetSharedFileStorageCacheForTests();
  process.chdir(app);
  try {
    return await fn({ base, app, files });
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

function put(dir, relative, content) {
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

const bodyOf = async (response) => Buffer.from(await response.arrayBuffer());
const pdfForm = (bytes, { notes, name = "My Answer.pdf", type = "application/pdf" } = {}) => {
  const form = new FormData();
  if (notes) form.set("notes", notes);
  form.set("file", new File([bytes], name, { type }));
  return form;
};

test.beforeEach(() => resetState());

// ==== 1. Generic storage opener =========================================================================

test("opener: FILE_STORAGE_ROOT validation (not set, relative, inside / containing the app, missing, a file)", async () => {
  const base = tempBase();
  try {
    const app = path.join(base, "app");
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(base, "a-file"), "x");
    const cases = [
      [{}, "ROOT_NOT_SET"],
      [{ FILE_STORAGE_ROOT: "relative/files" }, "ROOT_NOT_ABSOLUTE"],
      [{ FILE_STORAGE_ROOT: path.join(app, "files") }, "ROOT_INSIDE_APPLICATION"],
      [{ FILE_STORAGE_ROOT: base }, "ROOT_CONTAINS_APPLICATION"],
      [{ FILE_STORAGE_ROOT: path.join(base, "missing") }, "ROOT_MISSING"],
      [{ FILE_STORAGE_ROOT: path.join(base, "a-file") }, "ROOT_NOT_DIRECTORY"],
    ];
    for (const [env, reason] of cases) {
      assert.deepEqual(await OR.openSharedFileStorage(env, app), { ok: false, reason }, reason);
    }
    assert.equal(fs.existsSync(path.join(base, "missing")), false, "the root is never created");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("opener: creates only Teachers/ (0750 on POSIX), caches one handle, never caches a failure, drops it only for root errors", async () => {
  const base = tempBase();
  try {
    const app = path.join(base, "app");
    const files = path.join(base, "files");
    fs.mkdirSync(app);
    fs.mkdirSync(files);
    const env = { FILE_STORAGE_ROOT: files };
    OR.resetSharedFileStorageCacheForTests();
    const first = await OR.getSharedFileStorage(env, app);
    assert.equal(first.ok, true);
    assert.deepEqual(fs.readdirSync(files), ["Teachers"]);
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(files, "Teachers")).mode & 0o777, 0o750);
    assert.equal((await OR.getSharedFileStorage(env, app)).storage, first.storage, "cached");

    assert.equal(OR.invalidateSharedFileStorageForRootError("NOT_FOUND"), false, "a per-file error keeps the cache");
    assert.equal((await OR.getSharedFileStorage(env, app)).storage, first.storage);
    assert.equal(OR.invalidateSharedFileStorageForRootError("ROOT_MISSING"), true);
    assert.notEqual((await OR.getSharedFileStorage(env, app)).storage, first.storage, "re-opened after a root error");

    const bad = { FILE_STORAGE_ROOT: path.join(base, "nope") };
    assert.equal((await OR.getSharedFileStorage(bad, app)).ok, false);
    fs.mkdirSync(path.join(base, "nope"));
    assert.equal((await OR.getSharedFileStorage(bad, app)).ok, true, "a failure is retried, not cached");
  } finally {
    OR.resetSharedFileStorageCacheForTests();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("opener: independent of Recorded Lectures (no RL settings needed; RL's opener untouched)", () => {
  const src = fs.readFileSync(path.join(root, "lib", "file-storage", "open-root.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(src, /recorded-lectures|RECORDED_LECTURE/, "code only (the module comment mentions the RL opener)");
  const rl = fs.readFileSync(path.join(root, "lib", "recorded-lectures", "storage.ts"), "utf8");
  assert.doesNotMatch(rl, /open-root/);
});

// ==== 2. Keys ============================================================================================

const migrationSql = fs.readFileSync(path.join(root, "prisma", "migrations", "20261115120000_add_unified_file_storage_keys", "migration.sql"), "utf8");
const sqlRegex = (constraint) => new RegExp(migrationSql.match(new RegExp(`"${constraint}"\\s+CHECK \\("storageKey" ~ '([^']+)'\\)`))[1]);

test("note keys: server-generated random name, extension from the validated MIME type, ids checked, matches the DB CHECK", () => {
  const ids = { teacherId: "11111111-1111-4111-8111-111111111111", lectureId: "lec-1", noteId: crypto.randomUUID() };
  const names = new Set();
  for (const [mime, ext] of Object.entries(NK.NOTE_FILE_EXTENSIONS)) {
    const storedName = NK.generateNoteStoredName(mime);
    assert.match(storedName, new RegExp(`^[0-9a-f]{32}\\${ext}$`));
    names.add(storedName);
    const key = NK.noteFileKey({ ...ids, storedName });
    assert.equal(key, `Teachers/${ids.teacherId}/Lectures/lec-1/Notes/${ids.noteId}/${storedName}`);
    assert.deepEqual(NK.parseNoteStorageKey(key), { ...ids, storedName });
    assert.match(key, sqlRegex("Note_storageKey_format"), "the database accepts it");
  }
  assert.equal(names.size, Object.keys(NK.NOTE_FILE_EXTENSIONS).length, "random names do not repeat");
  assert.equal(NK.NOTE_FILE_EXTENSIONS["image/jpeg"], ".jpg");
  assert.throws(() => NK.generateNoteStoredName("application/x-msdownload"));
  assert.throws(() => NK.generateNoteStoredName("__proto__"));
  for (const bad of ["..", "../x", "a/b", "a\\b", "", ".hidden", "a.b", "a b", "x".repeat(129)]) {
    assert.throws(() => NK.noteDirectoryKey({ ...ids, lectureId: bad }), undefined, JSON.stringify(bad));
  }
  assert.throws(() => NK.noteFileKey({ ...ids, storedName: "../../evil.pdf" }));
  assert.throws(() => NK.noteFileKey({ ...ids, storedName: "My Notes.pdf" }), "a browser file name is never a stored name");
});

test("submission keys: always <random>.pdf below the assignment's Submissions/{submissionId}, matches the DB CHECK", () => {
  const ids = { teacherId: "t-1", lectureId: "l-1", assignmentId: "a-1", submissionId: crypto.randomUUID() };
  const key = SK.submissionFileKey({ ...ids, storedName: SK.generateSubmissionStoredName() });
  assert.match(key, new RegExp(`^Teachers/t-1/Lectures/l-1/Assignments/a-1/Submissions/${UUID}/[0-9a-f]{32}\\.pdf$`));
  assert.match(key, sqlRegex("AssignmentSubmission_storageKey_format"));
  assert.notEqual(SK.generateSubmissionStoredName(), SK.generateSubmissionStoredName());
  assert.throws(() => SK.submissionFileKey({ ...ids, storedName: `${"a".repeat(32)}.png` }), "PDF only");
  assert.throws(() => SK.submissionDirectoryKey({ ...ids, assignmentId: "../a" }));
});

test("keys of one kind are never accepted as the other (nor Recorded Lectures keys, nor unsafe strings)", () => {
  const note = NK.noteFileKey({ teacherId: "t", lectureId: "l", noteId: "n", storedName: `${"a".repeat(32)}.pdf` });
  const sub = SK.submissionFileKey({ teacherId: "t", lectureId: "l", assignmentId: "a", submissionId: "s", storedName: `${"b".repeat(32)}.pdf` });
  assert.equal(NK.isNoteStorageKey(sub), false);
  assert.equal(SK.isSubmissionStorageKey(note), false);
  for (const bad of [
    `Teachers/t/Lectures/l/RecordedLectures/${crypto.randomUUID()}/${"c".repeat(32)}.mp4`,
    "../Teachers/t/Lectures/l/Notes/n/x.pdf",
    `/Teachers/t/Lectures/l/Notes/n/${"a".repeat(32)}.pdf`,
    `Teachers/t/Lectures/l/Notes/n/../${"a".repeat(32)}.pdf`,
    `Teachers\\t\\Lectures\\l\\Notes\\n\\${"a".repeat(32)}.pdf`,
    `lectures/l/${"a".repeat(32)}.pdf`,
    null,
  ]) {
    assert.equal(NK.isNoteStorageKey(bad), false, String(bad));
    assert.equal(SK.isSubmissionStorageKey(bad), false, String(bad));
    if (typeof bad === "string") assert.doesNotMatch(bad, sqlRegex("Note_storageKey_format"));
  }
});

// ==== 3. Writes ===========================================================================================

/** A Blob whose stream yields `actual` while declaring `declared` bytes (a body that does not match its size). */
function lyingBlob(actual, declared) {
  return {
    size: declared,
    stream: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(actual));
          controller.close();
        },
      }),
  };
}

const NOTE_KEY = (noteId = crypto.randomUUID(), ext = ".pdf") => NK.noteFileKey({ teacherId: "t-1", lectureId: "l-1", noteId, storedName: `${crypto.randomBytes(16).toString("hex")}${ext}` });

test("write: SHA-256 computed while writing, exact size, bytes intact, never overwrites an existing file", async () => {
  await withSandbox(async ({ files }) => {
    const bytes = crypto.randomBytes(3 * 1024 * 1024 + 17);
    const key = NOTE_KEY();
    const stored = await SF.writeUploadedFile(key, new Blob([bytes]), 10 * 1024 * 1024);
    assert.deepEqual(stored, { storageKey: key, sha256: sha(bytes), sizeBytes: bytes.length });
    assert.deepEqual(fs.readFileSync(path.join(files, ...key.split("/"))), bytes);

    await assert.rejects(SF.writeUploadedFile(key, new Blob([Buffer.from("other")]), 100), (e) => e.name === "StorageError" && e.code === "ALREADY_EXISTS");
    assert.deepEqual(fs.readFileSync(path.join(files, ...key.split("/"))), bytes, "the existing file is untouched");
  });
});

test("write: a body shorter / longer than declared fails with UPLOAD_INCOMPLETE; over the limit with FILE_TOO_LARGE; no file left", async () => {
  await withSandbox(async ({ files }) => {
    for (const [blob, max, code] of [
      [lyingBlob(Buffer.alloc(10), 20), 100, "UPLOAD_INCOMPLETE"],
      [lyingBlob(Buffer.alloc(30), 20), 100, "UPLOAD_INCOMPLETE"],
      [lyingBlob(Buffer.alloc(150), 20), 100, "UPLOAD_INCOMPLETE"],
      [new Blob([Buffer.alloc(200)]), 100, "FILE_TOO_LARGE"],
    ]) {
      await assert.rejects(SF.writeUploadedFile(NOTE_KEY(), blob, max), (e) => e instanceof AppError && e.code === code && e.statusCode === 400, code);
    }
    assert.deepEqual(filesBelow(files), [], "no partial file anywhere");
  });
});

test("write: storage root not configured or unusable -> 503 STORAGE_UNAVAILABLE, nothing written", async () => {
  await withSandbox(
    async ({ app }) => {
      await assert.rejects(SF.writeUploadedFile(NOTE_KEY(), new Blob(["x"]), 10), (e) => e.code === "STORAGE_UNAVAILABLE" && e.statusCode === 503);
      assert.deepEqual(filesBelow(app), []);
    },
    { configureRoot: false }
  );
});

test("removeStoredFileQuietly: never throws; a failure is logged (an unreferenced file, never a broken reference)", async () => {
  await withSandbox(async ({ files }) => {
    const key = NOTE_KEY();
    assert.equal(await SF.removeStoredFileQuietly(key, "x"), false, "missing: nothing to do");
    fs.mkdirSync(path.join(files, ...key.split("/")), { recursive: true }); // a directory where a file is expected
    assert.equal(await SF.removeStoredFileQuietly(key, "cleanup label"), false);
    assert.equal(state.logged.length, 1);
    assert.equal(state.logged[0].url, "http://internal/stored-files/cleanup");
    assert.equal(state.logged[0].error.code, "UNSAFE_PATH", "a directory is never removed as a file");
  });
});

// ==== 4. Reads (resolver) ===================================================================================

test("read: storageKey first (streamed), even when a legacy file with the same fileUrl exists", async () => {
  await withSandbox(async ({ app }) => {
    const key = NOTE_KEY(undefined, ".png");
    await SF.writeUploadedFile(key, new Blob(["NEW"]), 10);
    put(path.join(app, "storage"), "lectures/l-1/legacy.png", "LEGACY");
    const file = await SF.openStoredFileForRead("NOTE", { storageKey: key, fileUrl: "lectures/l-1/legacy.png" }, { allowLegacyUploads: true });
    assert.equal(file.source, "storage");
    assert.equal(file.extension, ".png");
    assert.equal(file.size, 3);
    assert.equal(Buffer.from(await new Response(file.stream).arrayBuffer()).toString(), "NEW");
  });
});

test("read: legacy fallback exactly as before - <cwd>/storage, Notes' /uploads/ branch, submissions without it", async () => {
  await withSandbox(async ({ app }) => {
    put(path.join(app, "storage"), "lectures/l-1/old.pdf", "OLD-NOTE");
    put(path.join(app, "public", "uploads"), "notes/older.pdf", "OLDER");
    put(path.join(app, "storage"), "assignments/a-1/sub.pdf", "OLD-SUB");
    const read = async (kind, fileUrl, allowLegacyUploads) => {
      const file = await SF.openStoredFileForRead(kind, { storageKey: null, fileUrl }, { allowLegacyUploads });
      assert.equal(file.source, "legacy");
      return Buffer.from(await new Response(file.stream).arrayBuffer()).toString();
    };
    assert.equal(await read("NOTE", "lectures/l-1/old.pdf", true), "OLD-NOTE");
    assert.equal(await read("NOTE", "/uploads/notes/older.pdf", true), "OLDER");
    assert.equal(await read("SUBMISSION", "assignments/a-1/sub.pdf", false), "OLD-SUB");
    // Submissions never had the /uploads/ branch: "/uploads/x" stays below <cwd>/storage (as path.join did).
    assert.deepEqual(SF.resolveLegacyFileLocation("/uploads/notes/older.pdf", { allowLegacyUploads: false, appDir: app }).root, path.join(app, "storage"));
    await assert.rejects(SF.openStoredFileForRead("SUBMISSION", { storageKey: null, fileUrl: "/uploads/notes/older.pdf" }, { allowLegacyUploads: false }), { code: "FILE_UNAVAILABLE" });
  });
});

test("read: traversal is refused (403 FILE_ACCESS_DENIED as before); missing / invalid / wrong-kind keys are a controlled 404", async () => {
  await withSandbox(async ({ base }) => {
    put(base, "secret.pdf", "SECRET");
    for (const fileUrl of ["../../secret.pdf", "lectures/../../../secret.pdf", "/uploads/../../../secret.pdf"]) {
      await assert.rejects(SF.openStoredFileForRead("NOTE", { storageKey: null, fileUrl }, { allowLegacyUploads: true }), { code: "FILE_ACCESS_DENIED" }, fileUrl);
    }
    for (const fileUrl of ["lectures/l-1/none.pdf", "", "a\0b"]) {
      await assert.rejects(SF.openStoredFileForRead("NOTE", { storageKey: null, fileUrl }, { allowLegacyUploads: true }), { code: "FILE_UNAVAILABLE" });
    }
    const subKey = SK.submissionFileKey({ teacherId: "t", lectureId: "l", assignmentId: "a", submissionId: "s", storedName: SK.generateSubmissionStoredName() });
    await SF.writeUploadedFile(subKey, new Blob(["S"]), 10);
    await assert.rejects(SF.openStoredFileForRead("NOTE", { storageKey: subKey, fileUrl: "x" }, { allowLegacyUploads: true }), { code: "FILE_UNAVAILABLE" }, "a submission key is not a note key");
    await assert.rejects(SF.openStoredFileForRead("NOTE", { storageKey: "../../secret.pdf", fileUrl: "x" }, { allowLegacyUploads: true }), { code: "FILE_UNAVAILABLE" });
    await assert.rejects(SF.openStoredFileForRead("NOTE", { storageKey: NOTE_KEY(), fileUrl: "x" }, { allowLegacyUploads: true }), { code: "FILE_UNAVAILABLE" }, "missing stored file");

    const notFound = SF.storedFileAppError(new SF.StoredFileError("FILE_UNAVAILABLE"), "Submitted file is no longer available.");
    assert.deepEqual([notFound.statusCode, notFound.code, notFound.message], [404, "FILE_NOT_FOUND", "Submitted file is no longer available."]);
    const denied = SF.storedFileAppError(new SF.StoredFileError("FILE_ACCESS_DENIED"), "x");
    assert.deepEqual([denied.statusCode, denied.code, denied.message], [403, "FILE_ACCESS_DENIED", "The requested file is not available."]);
  });
});

test("read: symbolic links below the legacy root and in the new storage are never followed; a linked legacy ROOT still works", async (t) => {
  await withSandbox(async ({ base, app, files }) => {
    put(base, "outside/secret.pdf", "SECRET");
    fs.mkdirSync(path.join(app, "storage", "lectures"), { recursive: true });
    try {
      fs.symlinkSync(path.join(base, "outside"), path.join(app, "storage", "lectures", "linked"), "junction");
    } catch (error) {
      t.skip(`links unavailable: ${error.code}`);
      return;
    }
    await assert.rejects(SF.openStoredFileForRead("NOTE", { storageKey: null, fileUrl: "lectures/linked/secret.pdf" }, { allowLegacyUploads: true }), { code: "FILE_UNAVAILABLE" });
    try {
      fs.symlinkSync(path.join(base, "outside", "secret.pdf"), path.join(app, "storage", "lectures", "file-link.pdf"), "file");
      await assert.rejects(SF.openStoredFileForRead("NOTE", { storageKey: null, fileUrl: "lectures/file-link.pdf" }, { allowLegacyUploads: true }), { code: "FILE_UNAVAILABLE" });
    } catch (error) {
      if (error.code !== "EPERM") throw error;
      t.diagnostic("file symlinks need extra privileges here: that case was skipped");
    }
    // New storage: a linked note folder is refused by LocalFileStorage.
    const noteId = crypto.randomUUID();
    const dir = path.join(files, "Teachers", "t-1", "Lectures", "l-1", "Notes");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(base, "outside", "n"));
    put(path.join(base, "outside", "n"), `${"d".repeat(32)}.pdf`, "SECRET");
    fs.symlinkSync(path.join(base, "outside", "n"), path.join(dir, noteId), "junction");
    const key = NK.noteFileKey({ teacherId: "t-1", lectureId: "l-1", noteId, storedName: `${"d".repeat(32)}.pdf` });
    await assert.rejects(SF.openStoredFileForRead("NOTE", { storageKey: key, fileUrl: "x" }, { allowLegacyUploads: true }), { code: "FILE_UNAVAILABLE" });

    // The legacy storage ROOT itself may be a link (e.g. to a data volume), as before.
    const realStorage = path.join(base, "real-storage");
    put(realStorage, "lectures/l-1/ok.pdf", "OK");
    fs.rmSync(path.join(app, "storage"), { recursive: true, force: true });
    fs.symlinkSync(realStorage, path.join(app, "storage"), "junction");
    const file = await SF.openStoredFileForRead("NOTE", { storageKey: null, fileUrl: "lectures/l-1/ok.pdf" }, { allowLegacyUploads: true });
    assert.equal(Buffer.from(await new Response(file.stream).arrayBuffer()).toString(), "OK");
  });
});

test("read: the storage root becoming unavailable -> STORAGE_UNAVAILABLE (503), not a 404", async () => {
  await withSandbox(
    async () => {
      await assert.rejects(SF.openStoredFileForRead("NOTE", { storageKey: NOTE_KEY(), fileUrl: "x" }, { allowLegacyUploads: true }), { code: "STORAGE_UNAVAILABLE" });
      const e = SF.storedFileAppError(new SF.StoredFileError("STORAGE_UNAVAILABLE"), "x");
      assert.deepEqual([e.statusCode, e.code], [503, "STORAGE_UNAVAILABLE"]);
    },
    { configureRoot: false }
  );
});

// ==== 5. Notes routes ======================================================================================

const T = "teacher-a";
const LECTURE = "lecture-1";

function seedNote(over = {}) {
  const note = { id: "note-1", lectureId: LECTURE, title: "Week 1", fileUrl: "lectures/lecture-1/legacy.pdf", storageKey: null, mimeType: "application/pdf", status: 0, lectureStatus: 0, teacherId: T, visibility: "PUBLIC", access: "FREE", enrolled: ["student-1"], sizeBytes: 1, downloadCount: 0, lastDownloadedAt: null, ...over };
  state.notes.push(note);
  return note;
}

async function uploadNote(form) {
  return notesUpload.POST(new Request(`http://localhost/api/lectures/${LECTURE}/notes`, { method: "POST", body: form }), { params: { id: LECTURE } });
}

function noteForm(bytes = Buffer.from("%PDF-1.4 note"), type = "application/pdf", name = "Week 1.pdf") {
  const form = new FormData();
  form.set("title", "Week 1");
  form.set("kind", "NOTE");
  form.set("file", new File([bytes], name, { type }));
  return form;
}

test("notes upload -> every read route serves the new file (teacher preview / download, student, public)", async () => {
  await withSandbox(async ({ files, app }) => {
    state.lectures.push({ id: LECTURE, status: 0, teacherId: T, classId: "class-1" });
    const bytes = Buffer.from("%PDF-1.4 brand new note");
    const res = await uploadNote(noteForm(bytes, "image/jpeg", "photo.jpeg"));
    assert.equal(res.status, 201);
    const data = state.notesCreated[0];
    assert.match(data.storageKey, new RegExp(`^Teachers/${T}/Lectures/${LECTURE}/Notes/${UUID}/[0-9a-f]{32}\\.jpg$`));
    assert.equal(data.fileUrl, data.storageKey);
    assert.equal(data.sha256, sha(bytes));
    assert.equal(data.sizeBytes, bytes.length);
    assert.deepEqual(filesBelow(files), [data.storageKey]);
    assert.deepEqual(filesBelow(path.join(app, "storage")), [], "nothing written to the legacy storage");

    seedNote({ id: data.id, fileUrl: data.fileUrl, storageKey: data.storageKey, mimeType: "image/jpeg", title: "Week 1" });
    const ctx = { params: { id: data.id } };
    for (const [handler, disposition] of [[teacherDownload, "attachment"], [teacherPreview, "inline"]]) {
      const r = await handler.GET(new Request("http://localhost/x"), ctx);
      assert.equal(r.status, 200);
      assert.deepEqual(await bodyOf(r), bytes);
      assert.equal(r.headers.get("content-length"), String(bytes.length));
      assert.equal(r.headers.get("content-disposition"), `${disposition}; filename="week-1.jpg"; filename*=UTF-8''week-1.jpg`);
      assert.equal(r.headers.get("cache-control"), "private, no-store");
    }
    const s = await studentNoteFile.GET(new Request("http://localhost/x"), { params: { lectureId: LECTURE, noteId: data.id } });
    assert.equal(s.status, 200);
    assert.deepEqual(await bodyOf(s), bytes);
    const p = await publicPreview.GET(new Request("http://localhost/x?download=1"), { params: { id: data.id } });
    assert.equal(p.status, 200);
    assert.deepEqual(await bodyOf(p), bytes);
    assert.match(p.headers.get("content-disposition"), /^attachment; filename="week-1\.jpg"/);
  });
});

test("notes reads keep working for legacy files (storage/ and /uploads/), with the same names and headers", async () => {
  await withSandbox(async ({ app }) => {
    put(path.join(app, "storage"), "lectures/lecture-1/1700000000000-abc123-week-1.pdf", "LEGACY");
    put(path.join(app, "public", "uploads"), "old/sheet.pdf", "VERY-OLD");
    seedNote({ id: "n-legacy", fileUrl: "lectures/lecture-1/1700000000000-abc123-week-1.pdf" });
    seedNote({ id: "n-uploads", fileUrl: "/uploads/old/sheet.pdf", title: "Sheet" });

    const d = await teacherDownload.GET(new Request("http://localhost/x"), { params: { id: "n-legacy" } });
    assert.equal(d.status, 200);
    assert.equal((await bodyOf(d)).toString(), "LEGACY");
    assert.equal(d.headers.get("content-disposition"), `attachment; filename="week-1.pdf"; filename*=UTF-8''week-1.pdf`);
    const u = await studentNoteFile.GET(new Request("http://localhost/x"), { params: { lectureId: LECTURE, noteId: "n-uploads" } });
    assert.equal((await bodyOf(u)).toString(), "VERY-OLD");
    assert.match(u.headers.get("content-disposition"), /^inline; filename="sheet\.pdf"/);
  });
});

test("notes reads: missing file -> the existing 404 FILE_NOT_FOUND; storage down -> 503; traversal -> the existing 403", async () => {
  await withSandbox(async () => {
    seedNote({ id: "n-missing", fileUrl: "lectures/lecture-1/gone.pdf" });
    seedNote({ id: "n-traversal", fileUrl: "../../etc/passwd" });
    seedNote({ id: "n-new-missing", storageKey: NOTE_KEY(), fileUrl: "x" });
    const get = async (id) => {
      const r = await teacherDownload.GET(new Request("http://localhost/x"), { params: { id } });
      return [r.status, (await r.json()).error];
    };
    assert.deepEqual(await get("n-missing"), [404, { message: "The file is no longer available.", code: "FILE_NOT_FOUND" }]);
    assert.deepEqual(await get("n-new-missing"), [404, { message: "The file is no longer available.", code: "FILE_NOT_FOUND" }]);
    assert.deepEqual(await get("n-traversal"), [403, { message: "The requested file is not available.", code: "FILE_ACCESS_DENIED" }]);
  });
  await withSandbox(
    async () => {
      seedNote({ id: "n-stored", storageKey: NOTE_KEY(), fileUrl: "x" });
      const r = await teacherPreview.GET(new Request("http://localhost/x"), { params: { id: "n-stored" } });
      assert.equal(r.status, 503);
      assert.equal((await r.json()).error.code, "STORAGE_UNAVAILABLE");
    },
    { configureRoot: false }
  );
});

test("notes reads: the existing access queries are unchanged (teacher ownership, student enrollment, public PUBLIC+FREE)", async () => {
  await withSandbox(async ({ app }) => {
    put(path.join(app, "storage"), "lectures/lecture-1/legacy.pdf", "L");
    seedNote({ visibility: "PRIVATE", access: "LOCKED" });
    await teacherDownload.GET(new Request("http://localhost/x"), { params: { id: "note-1" } });
    await studentNoteFile.GET(new Request("http://localhost/x"), { params: { lectureId: LECTURE, noteId: "note-1" } });
    const pub = await publicPreview.GET(new Request("http://localhost/x"), { params: { id: "note-1" } });
    assert.equal(pub.status, 404, "a private note is not public");
    assert.deepEqual(state.queries, [
      ["note.findFirst", { id: "note-1", status: 0, lecture: { status: 0, class: { teacherId: T } } }],
      ["note.findFirst", { id: "note-1", lectureId: LECTURE, status: 0, lecture: { status: 0, class: { students: { some: { studentId: "student-1", isActive: true } } } } }],
      ["note.findFirst", { id: "note-1", visibility: "PUBLIC", access: "FREE", status: 0, lecture: { status: 0 } }],
    ]);
    state.teacherId = "teacher-b";
    const other = await teacherDownload.GET(new Request("http://localhost/x"), { params: { id: "note-1" } });
    assert.equal(other.status, 404, "another teacher: the existing NOTE_NOT_FOUND");
    state.studentId = "student-2";
    const notEnrolled = await studentNoteFile.GET(new Request("http://localhost/x"), { params: { lectureId: LECTURE, noteId: "note-1" } });
    assert.equal(notEnrolled.status, 404);
  });
});

test("notes upload: the Note row fails after the file was written -> the file is removed; no row references it", async () => {
  await withSandbox(async ({ files }) => {
    state.lectures.push({ id: LECTURE, status: 0, teacherId: T, classId: "class-1" });
    state.hooks.noteCreate = async () => {
      throw new Error("database unavailable");
    };
    const res = await uploadNote(noteForm());
    assert.equal(res.status, 500);
    assert.equal(state.notesCreated.length, 0);
    assert.deepEqual(filesBelow(files), [], "the stored file was discarded");
    assert.equal(state.logged.filter((l) => /discard/.test(l.label ?? "")).length, 0, "the discard itself succeeded");
  });
});

test("notes upload: lecture removed between the two ownership checks -> 404 and the file is removed", async () => {
  await withSandbox(async ({ files }) => {
    state.lectures.push({ id: LECTURE, status: 0, teacherId: T, classId: "class-1" });
    let calls = 0;
    const original = prisma.lecture.findFirst;
    prisma.lecture.findFirst = async (args) => (++calls === 2 ? null : original(args));
    try {
      const res = await uploadNote(noteForm());
      assert.equal(res.status, 404);
      assert.deepEqual(filesBelow(files), []);
    } finally {
      prisma.lecture.findFirst = original;
    }
  });
});

// ==== 6. Submission routes =================================================================================

const A = "assignment-1";
function seedAssignment(over = {}) {
  const a = { id: A, status: 0, lectureId: LECTURE, lectureStatus: 0, classId: "class-1", teacherId: T, enrolled: ["student-1"], ...over };
  state.assignments.push(a);
  return a;
}
const SUB_PREFIX = `Teachers/${T}/Lectures/${LECTURE}/Assignments/${A}/Submissions/`;
const post = (form) => submit.POST(new Request(`http://localhost/api/assignments/${A}/submit`, { method: "POST", body: form }), { params: { assignmentId: A } });

test("submission: first upload -> new nested key, SHA-256, exact size, no file reference in the response", async () => {
  await withSandbox(async ({ files, app }) => {
    seedAssignment();
    const bytes = Buffer.from("%PDF-1.7 answer");
    const res = await post(pdfForm(bytes, { notes: "done" }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.message, "Assignment submitted successfully.");
    const row = state.submissions[0];
    assert.match(row.storageKey, new RegExp(`^${SUB_PREFIX}${UUID}/[0-9a-f]{32}\\.pdf$`));
    assert.equal(row.storageKey.split("/")[7], row.id, "the key carries the submission id");
    assert.equal(row.fileUrl, row.storageKey);
    assert.equal(row.sha256, sha(bytes));
    assert.equal(row.sizeBytes, bytes.length);
    assert.equal(row.fileName, "My Answer.pdf");
    assert.equal(row.notes, "done");
    assert.deepEqual(Object.keys(body.data.submission).sort(), ["fileName", "id", "mimeType", "notes", "sizeBytes", "submittedAt"]);
    assert.equal(body.data.submission.id, row.id);
    assert.deepEqual(filesBelow(files), [row.storageKey]);
    assert.deepEqual(filesBelow(path.join(app, "storage")), []);
    assert.deepEqual(state.events, [{ studentId: "student-1", classId: "class-1" }]);
    assert.deepEqual(state.queries[0], ["assignment.findFirst", { id: A, status: 0, lecture: { status: 0, class: { students: { some: { studentId: "student-1", isActive: true } } } } }], "the enrollment check is unchanged");
  });
});

test("submission: resubmission keeps the submission id, writes a NEW file, removes the previous new-storage file only after the commit", async () => {
  await withSandbox(async ({ files }) => {
    seedAssignment();
    await post(pdfForm(Buffer.from("%PDF v1")));
    const first = { ...state.submissions[0] };
    let fileAtCommit;
    state.hooks.beforeUpdateMany = async () => {
      fileAtCommit = filesBelow(files);
    };
    const res = await post(pdfForm(Buffer.from("%PDF v2 longer")));
    assert.equal(res.status, 201);
    const row = state.submissions[0];
    assert.equal(state.submissions.length, 1);
    assert.equal(row.id, first.id, "same submission id");
    assert.notEqual(row.storageKey, first.storageKey, "a new physical file name");
    assert.ok(fileAtCommit.includes(first.storageKey) && fileAtCommit.includes(row.storageKey), "both files exist while the reference is switched");
    assert.deepEqual(filesBelow(files), [row.storageKey], "the replaced file was removed after the commit");
    assert.equal(row.sha256, sha(Buffer.from("%PDF v2 longer")));
  });
});

test("submission: a resubmission over a LEGACY file never deletes the legacy file", async () => {
  await withSandbox(async ({ files, app }) => {
    seedAssignment();
    put(path.join(app, "storage"), `assignments/${A}/1700000000000-abc123-old.pdf`, "OLD");
    state.submissions.push({ id: "sub-legacy", assignmentId: A, studentId: "student-1", fileUrl: `assignments/${A}/1700000000000-abc123-old.pdf`, storageKey: null, fileName: "old.pdf", mimeType: "application/pdf", sizeBytes: 3 });
    const res = await post(pdfForm(Buffer.from("%PDF new")));
    assert.equal(res.status, 201);
    assert.equal(state.submissions[0].id, "sub-legacy");
    assert.ok(state.submissions[0].storageKey.startsWith(`${SUB_PREFIX}sub-legacy/`));
    assert.deepEqual(filesBelow(path.join(app, "storage")), [`assignments/${A}/1700000000000-abc123-old.pdf`], "legacy file retained");
    assert.equal(filesBelow(files).length, 1);
  });
});

test("submission: compare-and-set - a concurrent replacement makes this attempt retry; its first file is discarded", async () => {
  await withSandbox(async ({ files }) => {
    seedAssignment();
    await post(pdfForm(Buffer.from("%PDF original")));
    let raced = false;
    state.hooks.beforeUpdateMany = async () => {
      if (raced) return;
      raced = true;
      // Another request replaces the file between our read and our commit (and, as the route
      // does after its own commit, removes the file it replaced).
      const replaced = state.submissions[0].storageKey;
      const other = SK.submissionFileKey({ teacherId: T, lectureId: LECTURE, assignmentId: A, submissionId: state.submissions[0].id, storedName: SK.generateSubmissionStoredName() });
      await SF.writeUploadedFile(other, new Blob(["%PDF other"]), 100);
      Object.assign(state.submissions[0], { fileUrl: other, storageKey: other, sha256: sha("%PDF other") });
      await SF.removeStoredFileQuietly(replaced, "test: the other request's cleanup");
    };
    const res = await post(pdfForm(Buffer.from("%PDF mine")));
    assert.equal(res.status, 201);
    const row = state.submissions[0];
    assert.equal(row.sha256, sha("%PDF mine"), "the retried write won, last-writer order");
    assert.deepEqual(filesBelow(files), [row.storageKey], "the lost attempt's file and the superseded file are both gone");
  });
});

test("submission: real concurrent resubmissions end with one referenced, complete file and no strays", async () => {
  await withSandbox(async ({ files }) => {
    seedAssignment();
    await post(pdfForm(Buffer.from("%PDF base")));
    const bodies = ["%PDF one", "%PDF two", "%PDF three"].map((s) => Buffer.from(s));
    const responses = await Promise.all(bodies.map((b) => post(pdfForm(b))));
    for (const r of responses) assert.ok([201, 409].includes(r.status), String(r.status));
    assert.ok(responses.some((r) => r.status === 201));
    const row = state.submissions[0];
    assert.deepEqual(filesBelow(files), [row.storageKey], "exactly the referenced file remains");
    assert.equal(sha(fs.readFileSync(path.join(files, ...row.storageKey.split("/")))), row.sha256, "complete and matching its digest");
  });
});

test("submission: a persistent conflict gives up after 3 attempts with 409 SUBMISSION_CONFLICT and leaves no new files", async () => {
  await withSandbox(async ({ files }) => {
    seedAssignment();
    await post(pdfForm(Buffer.from("%PDF original")));
    const before = filesBelow(files);
    let attempts = 0;
    state.hooks.beforeUpdateMany = async () => {
      attempts++;
      state.submissions[0].fileUrl = `changed-${attempts}`; // somebody always wins
    };
    const res = await post(pdfForm(Buffer.from("%PDF mine")));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "SUBMISSION_CONFLICT");
    assert.equal(attempts, 3);
    assert.deepEqual(filesBelow(files), before, "every attempt's file was discarded");
  });
});

test("submission: two FIRST submissions race -> the unique index decides, the loser retries as a resubmission", async () => {
  await withSandbox(async ({ files }) => {
    seedAssignment();
    let injected = false;
    state.hooks.beforeCreate = async () => {
      if (injected) return;
      injected = true;
      state.submissions.push({ id: "winner-sub", assignmentId: A, studentId: "student-1", fileUrl: "assignments/x/legacy.pdf", storageKey: null, fileName: "w.pdf", mimeType: "application/pdf", sizeBytes: 1 });
    };
    const res = await post(pdfForm(Buffer.from("%PDF late")));
    assert.equal(res.status, 201);
    assert.equal(state.submissions.length, 1);
    assert.equal(state.submissions[0].id, "winner-sub", "the existing submission id is kept");
    assert.deepEqual(filesBelow(files), [state.submissions[0].storageKey], "the first attempt's file (other id) was discarded");
  });
});

test("submission: database failure after the write -> 500, the new file is removed, the old reference and file stay", async () => {
  await withSandbox(async ({ files }) => {
    seedAssignment();
    await post(pdfForm(Buffer.from("%PDF v1")));
    const before = { ...state.submissions[0] };
    state.hooks.beforeUpdateMany = async () => {
      throw new Error("connection lost");
    };
    const res = await post(pdfForm(Buffer.from("%PDF v2")));
    assert.equal(res.status, 500);
    assert.deepEqual(state.submissions[0], before, "the active reference is unchanged");
    assert.deepEqual(filesBelow(files), [before.storageKey], "only the still-referenced file");
  });
});

test("submission: removing the replaced file fails -> still 201, the failure is logged, the new reference is intact", async () => {
  await withSandbox(async ({ files }) => {
    seedAssignment();
    await post(pdfForm(Buffer.from("%PDF v1")));
    const oldKey = state.submissions[0].storageKey;
    // Make the old file impossible to remove safely: replace it by a directory.
    fs.rmSync(path.join(files, ...oldKey.split("/")));
    fs.mkdirSync(path.join(files, ...oldKey.split("/")));
    const res = await post(pdfForm(Buffer.from("%PDF v2")));
    assert.equal(res.status, 201);
    assert.notEqual(state.submissions[0].storageKey, oldKey);
    assert.ok(fs.existsSync(path.join(files, ...state.submissions[0].storageKey.split("/"))));
    assert.equal(state.logged.length, 1, "the failed removal is logged");
    assert.equal(state.logged[0].url, "http://internal/stored-files/cleanup");
  });
});

test("submission: validation, enrollment and storage problems are unchanged / controlled and write nothing", async () => {
  await withSandbox(async ({ files }) => {
    seedAssignment({ enrolled: ["someone-else"] });
    const cases = [
      [pdfForm(Buffer.from("x"), { type: "image/png", name: "a.png" }), 400, "UNSUPPORTED_FILE_TYPE"],
      [pdfForm(Buffer.alloc(25 * 1024 * 1024 + 1)), 400, "FILE_TOO_LARGE"],
      [pdfForm(Buffer.from("%PDF")), 404, "ASSIGNMENT_NOT_FOUND"],
    ];
    for (const [form, status, code] of cases) {
      const res = await post(form);
      assert.equal(res.status, status, code);
      assert.equal((await res.json()).error.code, code);
    }
    assert.deepEqual(filesBelow(files), []);
  });
  await withSandbox(
    async ({ base }) => {
      seedAssignment();
      const res = await post(pdfForm(Buffer.from("%PDF")));
      assert.equal(res.status, 503);
      assert.equal(state.submissions.length, 0);
      assert.deepEqual(filesBelow(base), []);
    },
    { configureRoot: false }
  );
});

test("submission downloads: new and legacy files for the student and the teacher; access queries unchanged; GET has no file reference", async () => {
  await withSandbox(async ({ app }) => {
    seedAssignment();
    await post(pdfForm(Buffer.from("%PDF stored")));
    const sub = state.submissions[0];

    const mine = await submitFile.GET(new Request("http://localhost/x"), { params: { assignmentId: A } });
    assert.equal(mine.status, 200);
    assert.equal((await bodyOf(mine)).toString(), "%PDF stored");
    assert.equal(mine.headers.get("content-disposition"), `attachment; filename="my-answer.pdf"; filename*=UTF-8''my-answer.pdf`);

    state.queries = [];
    const teacher = await teacherSubmissionFile.GET(new Request("http://localhost/x"), { params: { id: LECTURE, assignmentId: A, submissionId: sub.id } });
    assert.equal(teacher.status, 200);
    assert.equal((await bodyOf(teacher)).toString(), "%PDF stored");
    assert.equal(teacher.headers.get("content-disposition"), `attachment; filename="student-one-my-answer.pdf"; filename*=UTF-8''student-one-my-answer.pdf`);
    assert.deepEqual(state.queries, [
      ["assignmentSubmission.findFirst", { id: sub.id, assignmentId: A, assignment: { lectureId: LECTURE, status: 0, lecture: { status: 0, class: { teacherId: T } } } }],
    ]);
    state.teacherId = "teacher-b";
    const other = await teacherSubmissionFile.GET(new Request("http://localhost/x"), { params: { id: LECTURE, assignmentId: A, submissionId: sub.id } });
    assert.equal(other.status, 404);
    state.teacherId = T;

    // Legacy submission file.
    put(path.join(app, "storage"), `assignments/${A}/170-abc-old.pdf`, "%PDF legacy");
    Object.assign(sub, { fileUrl: `assignments/${A}/170-abc-old.pdf`, storageKey: null });
    const legacy = await submitFile.GET(new Request("http://localhost/x"), { params: { assignmentId: A } });
    assert.equal((await bodyOf(legacy)).toString(), "%PDF legacy");

    // Missing file: the existing message.
    Object.assign(sub, { fileUrl: `assignments/${A}/gone.pdf` });
    const gone = await submitFile.GET(new Request("http://localhost/x"), { params: { assignmentId: A } });
    assert.equal(gone.status, 404);
    assert.deepEqual((await gone.json()).error, { message: "Submitted file is no longer available.", code: "FILE_NOT_FOUND" });

    const status = await submit.GET(new Request("http://localhost/x"), { params: { assignmentId: A } });
    const body = await status.json();
    assert.equal(body.data.submission.fileUrl, undefined);
    assert.equal(body.data.submission.storageKey, undefined);
  });
});

// ==== 6b. Rollback window: legacy dual-write (Stage 2.1) ========================================================

const DUAL = { dualWrite: "unset" }; // the variable unset = the production default (ON)
const legacyRead = (app, fileUrl) => fs.readFileSync(path.join(app, "storage", ...fileUrl.split("/"))); // the previous version's read

test("dual-write switch: ON unless explicitly off / false / 0 (fail-safe for unset or mistyped values)", () => {
  for (const value of [undefined, "", "on", "ON", "true", "1", "yes", "of", "disabled"]) {
    assert.equal(SF.isLegacyDualWriteEnabled(value === undefined ? {} : { UNIFIED_STORAGE_LEGACY_DUAL_WRITE: value }), true, String(value));
  }
  for (const value of ["off", " OFF ", "false", "0"]) assert.equal(SF.isLegacyDualWriteEnabled({ UNIFIED_STORAGE_LEGACY_DUAL_WRITE: value }), false, value);
});

test("dual-write notes: both copies complete and identical; fileUrl = the legacy copy (previous version reads it); this version reads the new storage", async () => {
  await withSandbox(async ({ app, files }) => {
    state.lectures.push({ id: LECTURE, status: 0, teacherId: T, classId: "class-1" });
    const bytes = Buffer.from("%PDF-1.4 rollback-safe note");
    assert.equal((await uploadNote(noteForm(bytes))).status, 201);
    const data = state.notesCreated[0];
    const name = data.storageKey.split("/").pop();
    assert.equal(data.fileUrl, `lectures/${LECTURE}/${name}`, "the legacy copy, same random name");
    assert.deepEqual(filesBelow(files), [data.storageKey]);
    assert.deepEqual(filesBelow(path.join(app, "storage")), [data.fileUrl]);
    assert.deepEqual(legacyRead(app, data.fileUrl), bytes, "the previous version can serve it");
    assert.equal(sha(legacyRead(app, data.fileUrl)), data.sha256);

    // This version reads storageKey (prove it: change only the legacy copy).
    seedNote({ id: data.id, fileUrl: data.fileUrl, storageKey: data.storageKey });
    fs.writeFileSync(path.join(app, "storage", ...data.fileUrl.split("/")), "CHANGED");
    const r = await teacherDownload.GET(new Request("http://localhost/x"), { params: { id: data.id } });
    assert.deepEqual(await bodyOf(r), bytes);
  }, DUAL);
});

test("dual-write: the legacy copy fails (a file / link in its folder chain) -> 503, the stored file is removed, no row", async (t) => {
  await withSandbox(async ({ app, files }) => {
    state.lectures.push({ id: LECTURE, status: 0, teacherId: T, classId: "class-1" });
    fs.writeFileSync(path.join(app, "storage", "lectures"), "not a folder");
    const res = await uploadNote(noteForm());
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "STORAGE_UNAVAILABLE");
    assert.equal(state.notesCreated.length, 0);
    assert.deepEqual(filesBelow(files), [], "the new-storage file was discarded");
    assert.deepEqual(filesBelow(path.join(app, "storage")), ["lectures"], "nothing else written");
    assert.ok(state.logged.some((l) => l.url === "http://internal/stored-files/legacy-copy"), "logged for operators");
  }, DUAL);
  await withSandbox(async ({ base, app, files }) => {
    state.lectures.push({ id: LECTURE, status: 0, teacherId: T, classId: "class-1" });
    fs.mkdirSync(path.join(base, "elsewhere"));
    fs.mkdirSync(path.join(app, "storage", "lectures"));
    try {
      fs.symlinkSync(path.join(base, "elsewhere"), path.join(app, "storage", "lectures", LECTURE), "junction");
    } catch (error) {
      t.diagnostic(`links unavailable (${error.code}): the linked-folder case was skipped`);
      return;
    }
    assert.equal((await uploadNote(noteForm())).status, 503);
    assert.deepEqual(fs.readdirSync(path.join(base, "elsewhere")), [], "nothing written through the link");
    assert.deepEqual(filesBelow(files), []);
  }, DUAL);
});

test("dual-write: the new-storage write fails first -> 503 and no legacy copy is written", async () => {
  await withSandbox(
    async ({ app }) => {
      state.lectures.push({ id: LECTURE, status: 0, teacherId: T, classId: "class-1" });
      assert.equal((await uploadNote(noteForm())).status, 503);
      assert.deepEqual(filesBelow(path.join(app, "storage")), []);
    },
    { configureRoot: false, dualWrite: "unset" }
  );
});

test("dual-write: the Note row fails -> BOTH copies are removed", async () => {
  await withSandbox(async ({ app, files }) => {
    state.lectures.push({ id: LECTURE, status: 0, teacherId: T, classId: "class-1" });
    state.hooks.noteCreate = async () => {
      throw new Error("database unavailable");
    };
    assert.equal((await uploadNote(noteForm())).status, 500);
    assert.deepEqual(filesBelow(files), []);
    assert.deepEqual(filesBelow(path.join(app, "storage")), []);
  }, DUAL);
});

test("dual-write submissions: first + resubmission; the replaced pair is removed only after the commit; both copies match", async () => {
  await withSandbox(async ({ app, files }) => {
    seedAssignment();
    await post(pdfForm(Buffer.from("%PDF v1")));
    const v1 = { ...state.submissions[0] };
    assert.equal(v1.fileUrl, `assignments/${A}/${v1.storageKey.split("/").pop()}`);
    assert.equal(legacyRead(app, v1.fileUrl).toString(), "%PDF v1");
    let atCommit;
    state.hooks.beforeUpdateMany = async () => {
      atCommit = [filesBelow(files), filesBelow(path.join(app, "storage"))];
    };
    assert.equal((await post(pdfForm(Buffer.from("%PDF v2")))).status, 201);
    const v2 = state.submissions[0];
    assert.equal(v2.id, v1.id);
    assert.ok(atCommit[0].includes(v1.storageKey) && atCommit[1].includes(v1.fileUrl), "the previous pair still exists while the reference switches");
    assert.deepEqual(filesBelow(files), [v2.storageKey]);
    assert.deepEqual(filesBelow(path.join(app, "storage")), [v2.fileUrl]);
    assert.equal(legacyRead(app, v2.fileUrl).toString(), "%PDF v2");
  }, DUAL);
});

test("dual-write: concurrent resubmissions leave exactly one complete, matching pair and no strays", async () => {
  await withSandbox(async ({ app, files }) => {
    seedAssignment();
    await post(pdfForm(Buffer.from("%PDF base")));
    const responses = await Promise.all(["%PDF one", "%PDF two", "%PDF three", "%PDF four"].map((s) => post(pdfForm(Buffer.from(s)))));
    assert.ok(responses.every((r) => [201, 409].includes(r.status)));
    const row = state.submissions[0];
    assert.deepEqual(filesBelow(files), [row.storageKey]);
    assert.deepEqual(filesBelow(path.join(app, "storage")), [row.fileUrl]);
    assert.equal(sha(fs.readFileSync(path.join(files, ...row.storageKey.split("/")))), row.sha256);
    assert.equal(sha(legacyRead(app, row.fileUrl)), row.sha256);
  }, DUAL);
});

test("dual-write: a lost compare-and-set discards BOTH of its copies", async () => {
  await withSandbox(async ({ app, files }) => {
    seedAssignment();
    await post(pdfForm(Buffer.from("%PDF base")));
    let attempts = 0;
    state.hooks.beforeUpdateMany = async () => {
      attempts++;
      state.submissions[0].fileUrl = `someone-else-${attempts}`;
    };
    assert.equal((await post(pdfForm(Buffer.from("%PDF mine")))).status, 409);
    assert.equal(filesBelow(files).length, 1, "only the original stored file");
    assert.equal(filesBelow(path.join(app, "storage")).length, 1, "only the original legacy copy");
  }, DUAL);
});

test("dual-write: a body that differs between the two writes -> 400 UPLOAD_INCOMPLETE, both copies removed", async () => {
  await withSandbox(async ({ app, files }) => {
    let reads = 0;
    const changing = {
      size: 4,
      stream: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(Buffer.from(reads++ === 0 ? "AAAA" : "BBBB")));
            controller.close();
          },
        }),
    };
    const key = NK.noteFileKey({ teacherId: T, lectureId: LECTURE, noteId: crypto.randomUUID(), storedName: NK.generateNoteStoredName("application/pdf") });
    await assert.rejects(SF.storeUpload("NOTE", key, changing, 100), (e) => e instanceof AppError && e.code === "UPLOAD_INCOMPLETE");
    assert.equal(reads, 2, "the legacy copy was streamed separately and compared with the stored file's hash");
    assert.deepEqual(filesBelow(files), []);
    assert.deepEqual(filesBelow(path.join(app, "storage")), []);
  }, DUAL);
});

test("replacing a submission whose fileUrl is a RETAINED ORIGINAL (key set by a later copy) never deletes that original", async () => {
  await withSandbox(async ({ app, files }) => {
    seedAssignment();
    const original = `assignments/${A}/1700000000000-abc123-original.pdf`;
    put(path.join(app, "storage"), original, "%PDF original");
    const key = SK.submissionFileKey({ teacherId: T, lectureId: LECTURE, assignmentId: A, submissionId: "sub-copied", storedName: SK.generateSubmissionStoredName() });
    put(files, key, "%PDF original");
    state.submissions.push({ id: "sub-copied", assignmentId: A, studentId: "student-1", fileUrl: original, storageKey: key, sha256: sha("%PDF original"), fileName: "o.pdf", mimeType: "application/pdf", sizeBytes: 13 });
    assert.equal((await post(pdfForm(Buffer.from("%PDF replacement")))).status, 201);
    assert.ok(filesBelow(path.join(app, "storage")).includes(original), "the retained original stays (90-day retention)");
    assert.ok(!filesBelow(files).includes(key), "its new-storage copy, written by this feature, is removed");
  }, DUAL);
});

/** Exactly what the PREVIOUS application version's resubmission does (with the migration's trigger in place). */
function previousVersionResubmit(app, row, bytes) {
  const name = `${Date.now()}-abc123-answer.pdf`;
  put(path.join(app, "storage"), `assignments/${A}/${name}`, bytes);
  const old = row.fileUrl;
  applyUpdateWithTrigger(row, { fileName: "answer.pdf", fileUrl: `assignments/${A}/${name}`, mimeType: "application/pdf", sizeBytes: bytes.length, notes: null, submittedAt: new Date() });
  fs.rmSync(path.join(app, "storage", ...old.split("/")), { force: true });
}

test("rollback round trip: previous version reads and resubmits; this version then serves the previous version's file, never the replaced one", async () => {
  await withSandbox(async ({ app, files }) => {
    seedAssignment();
    await post(pdfForm(Buffer.from("%PDF stage-2 upload")));
    const row = state.submissions[0];
    const staleKey = row.storageKey;

    // Rolled back: the previous version serves the Stage 2 upload, then the student resubmits there.
    assert.equal(legacyRead(app, row.fileUrl).toString(), "%PDF stage-2 upload");
    previousVersionResubmit(app, row, Buffer.from("%PDF resubmitted on the previous version"));
    assert.equal(row.storageKey, null, "the trigger cleared the stale key");
    assert.equal(row.sha256, null);

    // Rolled forward again: this version reads the previous version's file.
    const r = await submitFile.GET(new Request("http://localhost/x"), { params: { assignmentId: A } });
    assert.equal(r.status, 200);
    assert.equal((await bodyOf(r)).toString(), "%PDF resubmitted on the previous version");

    // A new resubmission here: the previous version's (legacy) file is retained, never deleted.
    const previousFile = row.fileUrl;
    assert.equal((await post(pdfForm(Buffer.from("%PDF back on stage 2")))).status, 201);
    assert.ok(filesBelow(path.join(app, "storage")).includes(previousFile), "legacy file retained");
    // The pre-rollback stored file is no longer referenced by any row: the inventory reports it.
    assert.ok(filesBelow(files).includes(staleKey));
    assert.notEqual(row.storageKey, staleKey);
  }, DUAL);
});

test("turning dual-write OFF later: new uploads are new-storage only; earlier pairs keep working and are cleaned up on replacement", async () => {
  await withSandbox(async ({ app, files }) => {
    seedAssignment();
    process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE = "on";
    await post(pdfForm(Buffer.from("%PDF during the window")));
    const paired = { ...state.submissions[0] };
    process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE = "off";
    assert.equal((await post(pdfForm(Buffer.from("%PDF after the window")))).status, 201);
    const row = state.submissions[0];
    assert.equal(row.fileUrl, row.storageKey, "no legacy copy after the window");
    assert.deepEqual(filesBelow(files), [row.storageKey]);
    assert.ok(!filesBelow(path.join(app, "storage")).includes(paired.fileUrl), "the replaced pair's legacy copy was removed too");
  });
});

// ==== 7. Source guards ======================================================================================

test("source: the Notes / submission routes read and write only through lib/stored-files (no readFile / writeFile / mkdir / unlink)", () => {
  const routes = [
    ["lectures", "[id]", "notes"],
    ["lectures", "notes", "[id]", "download"],
    ["lectures", "notes", "[id]", "preview"],
    ["student", "lectures", "[lectureId]", "notes", "[noteId]", "file"],
    ["public", "class-notes", "[id]", "preview"],
    ["assignments", "[assignmentId]", "submit"],
    ["assignments", "[assignmentId]", "submit", "file"],
    ["lectures", "[id]", "assignments", "[assignmentId]", "submissions", "[submissionId]", "file"],
  ];
  for (const p of routes) {
    const src = fs.readFileSync(path.join(root, "app", "api", ...p, "route.ts"), "utf8");
    assert.doesNotMatch(src, /node:fs|\b(readFile|writeFile|mkdir|unlink)\(|process\.cwd\(\)/, p.join("/"));
    assert.match(src, /@\/lib\/stored-files\/stored-file/, p.join("/"));
  }
});

test("source: API responses no longer carry fileUrl / storageKey for notes and submissions", () => {
  const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
  const service = read("services", "lecture-service.ts");
  const noteSelect = service.slice(service.indexOf("const noteSelect = {"), service.indexOf("} as const;", service.indexOf("const noteSelect = {")));
  assert.doesNotMatch(noteSelect, /fileUrl|storageKey/);
  for (const p of [["app", "api", "students", "me", "assignments", "route.ts"], ["app", "api", "student", "lectures", "[lectureId]", "route.ts"]]) {
    assert.doesNotMatch(read(...p), /fileUrl|storageKey/, p.join("/"));
  }
});
