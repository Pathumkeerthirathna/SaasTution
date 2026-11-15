/*
 * Recorded Lectures RL-0: lecture notes upload authorization ordering
 * (POST /api/lectures/[id]/notes, app/api/lectures/[id]/notes/route.ts).
 *
 * The teacher must own the (active) lecture BEFORE any folder is created or
 * any file is written. Before RL-0 the file was written to
 * storage/lectures/{lectureId}/ first and ownership was only checked when
 * the Note row was created, so any teacher could create folders and files
 * for lectures they do not own (and the lecture id from the URL reached the
 * filesystem path unchecked).
 *
 *   npm run test:security
 *
 * No database: lib/prisma.ts is a small fake (lecture.findFirst honours the
 * ownership filter of assertTeacherOwnsLecture). The real route, the real
 * lecture-service and the real session check run; next/headers (the teacher
 * cookie) is a fake and the token is signed with a throwaway JWT_SECRET.
 * Every request runs with process.cwd() set to a fresh temporary folder
 * ("<sandbox>/app") and FILE_STORAGE_ROOT set to "<sandbox>/files" (outside
 * the app folder), so every write is observable and nothing touches the
 * repository's own storage.
 *
 * Unified storage Stage 2: an authorised upload is now written below
 * FILE_STORAGE_ROOT (Teachers/{teacher}/Lectures/{lecture}/Notes/{noteId}/
 * {random}.{ext}), never to <cwd>/storage; the ownership-before-any-write
 * guarantee is unchanged.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Module = require("node:module");

process.env.JWT_SECRET = "rl-0-test-secret-not-a-real-one-0123456789";

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

// ---- State and fakes ----------------------------------------------------------------------------

const OWNER = "teacher-owner";
const OTHER = "teacher-other";
const LECTURE = "lecture-1";

const state = {};
function resetState() {
  Object.assign(state, {
    cookie: null,
    lectures: [
      { id: LECTURE, title: "Algebra", classId: "class-1", status: 0, teacherId: OWNER },
      { id: "lecture-removed", title: "Old", classId: "class-1", status: 1, teacherId: OWNER },
      { id: "lecture-other", title: "Theirs", classId: "class-2", status: 0, teacherId: OTHER },
    ],
    ownershipQueries: [],
    notesCreated: [],
    events: [],
  });
}
resetState();

fakeAt(require.resolve("next/headers", { paths: [root] }), {
  cookies: () => ({ get: (name) => (name === "teacher_session" && state.cookie ? { name, value: state.cookie } : undefined) }),
  headers: () => new Headers(),
});

const prisma = {
  lecture: {
    async findFirst({ where }) {
      state.ownershipQueries.push(where);
      const lecture = state.lectures.find(
        (l) => l.id === where.id && l.status === where.status && l.teacherId === where.class?.teacherId
      );
      if (!lecture) return null;
      return {
        id: lecture.id,
        title: lecture.title,
        classId: lecture.classId,
        date: new Date("2026-11-20T04:30:00.000Z"),
        endDate: null,
        class: { id: lecture.classId, name: "Grade 10", schedule: "Fri" },
      };
    },
  },
  note: {
    async create({ data }) {
      // The service's noteSelect: no fileUrl / storageKey in the returned note.
      const note = {
        id: data.id ?? `note-${state.notesCreated.length + 1}`,
        lectureId: data.lectureId,
        title: data.title,
        kind: data.kind,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        downloadCount: 0,
        lastDownloadedAt: null,
        visibility: "PRIVATE",
        access: "LOCKED",
      };
      state.notesCreated.push({ data, note });
      return note;
    },
  },
  classStudent: { findMany: async () => [] },
  noteStudent: { createMany: async () => ({ count: 0 }) },
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
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });
fake("lib/session-events.ts", {
  emitStudentDataChange: (payload) => state.events.push(payload),
});

const { signAuthToken } = require(path.join(root, "lib", "auth.ts"));
const route = require(path.join(root, "app", "api", "lectures", "[id]", "notes", "route.ts"));
const { resetSharedFileStorageCacheForTests } = require(path.join(root, "lib", "file-storage", "open-root.ts"));
const crypto = require("node:crypto");

// ---- Helpers ------------------------------------------------------------------------------------

async function signInAs(teacherId) {
  state.cookie = await signAuthToken({ sub: teacherId, email: `${teacherId}@example.com`, role: "TEACHER", name: "Teacher" });
}

const PDF_BYTES = Buffer.from("%PDF-1.4\n% RL-0 test note\n%%EOF\n");

function noteForm({ title = "Week 1 notes", kind = "NOTE", file = { bytes: PDF_BYTES, name: "Week 1 Notes.pdf", type: "application/pdf" } } = {}) {
  const form = new FormData();
  if (title !== null) form.set("title", title);
  if (kind !== null) form.set("kind", kind);
  if (file !== null) form.set("file", new File([file.bytes], file.name, { type: file.type }));
  return form;
}

/**
 * Runs POST with process.cwd() = a fresh "<tmp>/app" folder and
 * FILE_STORAGE_ROOT = "<tmp>/files"; returns the response and the folders.
 */
async function post(lectureId, form) {
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rl0-notes-"));
  const appDir = path.join(sandbox, "app");
  const filesRoot = path.join(sandbox, "files");
  fs.mkdirSync(appDir);
  fs.mkdirSync(filesRoot);
  const previous = process.cwd();
  const previousRoot = process.env.FILE_STORAGE_ROOT;
  const previousDual = process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE;
  process.env.FILE_STORAGE_ROOT = filesRoot;
  delete process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE; // the production default (dual-write ON)
  resetSharedFileStorageCacheForTests();
  process.chdir(appDir);
  try {
    const request = new Request(`http://localhost:3000/api/lectures/${encodeURIComponent(lectureId)}/notes`, {
      method: "POST",
      body: form,
    });
    const response = await route.POST(request, { params: { id: lectureId } });
    const body = await response.json();
    return { response, body, sandbox, appDir, filesRoot };
  } finally {
    process.chdir(previous);
    if (previousRoot === undefined) delete process.env.FILE_STORAGE_ROOT;
    else process.env.FILE_STORAGE_ROOT = previousRoot;
    if (previousDual !== undefined) process.env.UNIFIED_STORAGE_LEGACY_DUAL_WRITE = previousDual;
    resetSharedFileStorageCacheForTests();
  }
}

/** The sandbox after a refused request: the two empty folders it started with, nothing else. */
const UNTOUCHED = ["app/", "files/"];

/** Every file and folder below `dir` (relative, "/"-separated), excluding `dir` itself. */
function tree(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      out.push(path.relative(dir, full).split(path.sep).join("/") + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

function cleanup(sandbox) {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

test.beforeEach(() => resetState());

// ---- Unauthorized uploads -----------------------------------------------------------------------

test("another teacher's lecture: the existing 404 LECTURE_NOT_FOUND, and no folder or file is created", async () => {
  await signInAs(OTHER);
  const { response, body, sandbox } = await post(LECTURE, noteForm());
  try {
    assert.equal(response.status, 404);
    assert.deepEqual(body, { success: false, error: { message: "Lecture not found.", code: "LECTURE_NOT_FOUND" } });
    assert.deepEqual(tree(sandbox), UNTOUCHED, "nothing written anywhere in the sandbox");
    assert.equal(state.notesCreated.length, 0);
    assert.equal(state.events.length, 0);
    assert.deepEqual(state.ownershipQueries, [{ id: LECTURE, status: 0, class: { teacherId: OTHER } }], "checked for the session's teacher");
  } finally {
    cleanup(sandbox);
  }
});

test("a removed (status 1) lecture or an unknown lecture: 404 and nothing written", async () => {
  await signInAs(OWNER);
  for (const lectureId of ["lecture-removed", "no-such-lecture"]) {
    const { response, body, sandbox } = await post(lectureId, noteForm());
    try {
      assert.equal(response.status, 404, lectureId);
      assert.equal(body.error.code, "LECTURE_NOT_FOUND");
      assert.deepEqual(tree(sandbox), UNTOUCHED, lectureId);
    } finally {
      cleanup(sandbox);
    }
  }
  assert.equal(state.notesCreated.length, 0);
});

test("traversal-like lecture ids never reach the filesystem: 404 and no folder or file anywhere", async () => {
  await signInAs(OWNER);
  const ids = ["../x", "../../x", "..\\x", "../storage/x", "lecture-1/../../x", "/tmp/x", "x/../../../y"];
  for (const lectureId of ids) {
    const { response, body, sandbox } = await post(lectureId, noteForm());
    try {
      assert.equal(response.status, 404, lectureId);
      assert.equal(body.error.code, "LECTURE_NOT_FOUND", lectureId);
      assert.deepEqual(tree(sandbox), UNTOUCHED, `${lectureId}: nothing inside or outside the app folder`);
    } finally {
      cleanup(sandbox);
    }
  }
  assert.equal(state.notesCreated.length, 0);
});

test("no session: the existing 401 before the body, the ownership query or any write", async () => {
  state.cookie = null;
  const { response, body, sandbox } = await post(LECTURE, noteForm());
  try {
    assert.equal(response.status, 401);
    assert.equal(body.error.code, "UNAUTHORIZED");
    assert.equal(state.ownershipQueries.length, 0);
    assert.deepEqual(tree(sandbox), UNTOUCHED);
  } finally {
    cleanup(sandbox);
  }
});

// ---- Validation order is unchanged --------------------------------------------------------------

test("existing validation errors still come first (even for a lecture the teacher does not own), unchanged", async () => {
  await signInAs(OTHER);
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x20);
  const cases = [
    { form: noteForm({ title: "   " }), status: 400, error: { message: "Title is required.", code: "VALIDATION_ERROR" } },
    { form: noteForm({ title: null }), status: 400, error: { message: "Title is required.", code: "VALIDATION_ERROR" } },
    { form: noteForm({ file: null }), status: 400, error: { message: "File is required.", code: "VALIDATION_ERROR" } },
    { form: noteForm({ kind: "VIDEO" }), status: 400, code: "VALIDATION_ERROR", message: "Invalid note kind." },
    {
      form: noteForm({ file: { bytes: Buffer.from("x"), name: "a.exe", type: "application/x-msdownload" } }),
      status: 400,
      error: { message: "Notes only support PDF or image files.", code: "UNSUPPORTED_FILE_TYPE" },
    },
    {
      form: noteForm({ kind: "SUPPORTING_MATERIAL", file: { bytes: Buffer.from("x"), name: "a.exe", type: "application/x-msdownload" } }),
      status: 400,
      error: { message: "Unsupported supporting material file type.", code: "UNSUPPORTED_FILE_TYPE" },
    },
    {
      form: noteForm({ file: { bytes: big, name: "big.pdf", type: "application/pdf" } }),
      status: 400,
      error: { message: "File exceeds size limit. Notes allow up to 10.00 MB, received 10.00 MB.", code: "FILE_TOO_LARGE" },
    },
  ];

  for (const c of cases) {
    const { response, body, sandbox } = await post(LECTURE, c.form);
    try {
      assert.equal(response.status, c.status);
      if (c.error) {
        assert.deepEqual(body, { success: false, error: c.error });
      } else {
        assert.equal(body.error.code, c.code);
        assert.equal(body.error.message, c.message);
      }
      assert.deepEqual(tree(sandbox), UNTOUCHED);
    } finally {
      cleanup(sandbox);
    }
  }
  assert.equal(state.ownershipQueries.length, 0, "no ownership query before the input is valid (same order as before)");
  assert.equal(state.notesCreated.length, 0);
});

// ---- Authorized uploads keep their behaviour ----------------------------------------------------

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

test("owner, NOTE: 201 with the same message; the file goes to FILE_STORAGE_ROOT under a server-generated key (Stage 2)", async () => {
  await signInAs(OWNER);
  const { response, body, sandbox, appDir, filesRoot } = await post(LECTURE, noteForm());
  try {
    assert.equal(response.status, 201);
    assert.equal(body.success, true);
    assert.equal(body.message, "Lecture note uploaded successfully.");

    const files = tree(filesRoot).filter((f) => !f.endsWith("/"));
    assert.equal(files.length, 1, files.join(", "));
    const key = files[0];
    assert.match(key, new RegExp(`^Teachers/${OWNER}/Lectures/${LECTURE}/Notes/${UUID}/[0-9a-f]{32}\\.pdf$`), "server-generated key, extension from the MIME type");
    assert.doesNotMatch(key, /week|notes\.pdf/i, "nothing from the browser's file name");
    assert.deepEqual(fs.readFileSync(path.join(filesRoot, ...key.split("/"))), PDF_BYTES, "the uploaded bytes");

    // Stage 2.1 rollback window (dual-write is ON by default): a verified legacy copy where the
    // previous application version reads it, with the same server-generated name.
    const legacyCopy = `lectures/${LECTURE}/${key.split("/").pop()}`;
    assert.deepEqual(tree(appDir), ["storage/", "storage/lectures/", `storage/lectures/${LECTURE}/`, `storage/${legacyCopy}`]);
    assert.deepEqual(fs.readFileSync(path.join(appDir, "storage", ...legacyCopy.split("/"))), PDF_BYTES);

    assert.equal(body.data.note.fileUrl, undefined, "no file reference in the response");
    assert.equal(body.data.note.storageKey, undefined);
    assert.equal(state.notesCreated.length, 1);
    const noteId = key.split("/")[5];
    assert.deepEqual(state.notesCreated[0].data, {
      id: noteId,
      lectureId: LECTURE,
      title: "Week 1 notes",
      fileUrl: legacyCopy,
      storageKey: key,
      sha256: crypto.createHash("sha256").update(PDF_BYTES).digest("hex"),
      kind: "NOTE",
      mimeType: "application/pdf",
      sizeBytes: PDF_BYTES.length,
    });
    assert.equal(body.data.note.id, noteId);
    assert.deepEqual(state.events, [{ classId: "class-1" }]);
    // The early check plus the existing one inside addNoteToLectureForTeacher.
    assert.equal(state.ownershipQueries.length, 2);
  } finally {
    cleanup(sandbox);
  }
});

test("owner, SUPPORTING_MATERIAL: 201 with its existing message; .txt kept from the MIME type", async () => {
  await signInAs(OWNER);
  const { response, body, sandbox, filesRoot } = await post(
    LECTURE,
    noteForm({ kind: "SUPPORTING_MATERIAL", title: "Slides", file: { bytes: Buffer.from("text"), name: "Read Me.txt", type: "text/plain" } })
  );
  try {
    assert.equal(response.status, 201);
    assert.equal(body.message, "Supporting material uploaded successfully.");
    assert.match(state.notesCreated[0].data.storageKey, new RegExp(`/Notes/${UUID}/[0-9a-f]{32}\\.txt$`));
    assert.equal(tree(filesRoot).filter((f) => !f.endsWith("/")).length, 1);
    assert.equal(body.data.note.kind, "SUPPORTING_MATERIAL");
  } finally {
    cleanup(sandbox);
  }
});

test("owner, but the storage root is not configured: 503 STORAGE_UNAVAILABLE, no Note row, nothing written", async () => {
  await signInAs(OWNER);
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rl0-notes-"));
  const appDir = path.join(sandbox, "app");
  fs.mkdirSync(appDir);
  const previous = process.cwd();
  const previousRoot = process.env.FILE_STORAGE_ROOT;
  delete process.env.FILE_STORAGE_ROOT;
  resetSharedFileStorageCacheForTests();
  process.chdir(appDir);
  try {
    const response = await route.POST(new Request(`http://localhost:3000/api/lectures/${LECTURE}/notes`, { method: "POST", body: noteForm() }), { params: { id: LECTURE } });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error.code, "STORAGE_UNAVAILABLE");
    assert.deepEqual(tree(sandbox), ["app/"]);
    assert.equal(state.notesCreated.length, 0);
  } finally {
    process.chdir(previous);
    if (previousRoot !== undefined) process.env.FILE_STORAGE_ROOT = previousRoot;
    resetSharedFileStorageCacheForTests();
    cleanup(sandbox);
  }
});

// ---- Source-order guard -------------------------------------------------------------------------

const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("source order: in POST, validation, then assertTeacherOwnsLecture, then the key and the stored write, then the Note row", () => {
  const src = stripComments(read("app", "api", "lectures", "[id]", "notes", "route.ts"));
  const post = src.slice(src.indexOf("export async function POST"));
  const at = (needle) => {
    const index = post.indexOf(needle);
    assert.ok(index >= 0, `missing: ${needle}`);
    return index;
  };

  const lastValidation = at('"FILE_TOO_LARGE"');
  const ownership = at("await assertTeacherOwnsLecture(session.teacherId, lectureId);");
  const key = at("noteFileKey(");
  const writeCall = at("await storeUpload(");
  const addNote = at("await addNoteToLectureForTeacher(");

  assert.ok(lastValidation < ownership, "ownership after the existing validations");
  assert.ok(ownership < key && ownership < writeCall, "ownership before any filesystem work");
  assert.ok(writeCall < addNote, "the file is complete before the Note row is created");
  assert.doesNotMatch(post, /\b(mkdir|writeFile|arrayBuffer)\(/, "no direct filesystem writes in the route");
  assert.equal((post.match(/assertTeacherOwnsLecture\(/g) ?? []).length, 1);
  assert.match(src, /import \{ addNoteToLectureForTeacher, assertTeacherOwnsLecture, listNotesForLectureForTeacher \} from "@\/services\/lecture-service";/);

  // GET is unchanged: no extra ownership call there (listNotesForLectureForTeacher already checks).
  const get = src.slice(src.indexOf("export async function GET"), src.indexOf("export async function POST"));
  assert.doesNotMatch(get, /assertTeacherOwnsLecture/);
});

test("lecture-service: assertTeacherOwnsLecture is exported with its original query and error", () => {
  const src = read("services", "lecture-service.ts");
  const start = src.indexOf("export async function assertTeacherOwnsLecture(teacherId: string, lectureId: string) {");
  assert.ok(start >= 0, "exported");
  const body = src.slice(start, src.indexOf("\n}\n", start) + 3);
  assert.match(body, /where: \{\s*id: lectureId,\s*status: 0,\s*class: \{\s*teacherId,\s*\},\s*\}/);
  assert.match(body, /throw new AppError\("Lecture not found\.", 404, "LECTURE_NOT_FOUND"\);/);
  assert.equal((src.match(/function assertTeacherOwnsLecture\(/g) ?? []).length, 1, "one definition, not a copy");
});
