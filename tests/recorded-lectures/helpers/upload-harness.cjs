/*
 * Shared harness for the recorded-lecture completion / cancellation tests
 * (RL-3.4): the REAL routes, services, session check and LocalFileStorage (a
 * temporary FILE_STORAGE_ROOT), with the in-memory database fake
 * (fake-upload-db.cjs), a controllable server clock and a teacher cookie.
 *
 * Storage methods can be intercepted per test (state.storagePatches[name] =
 * async (original, ...args) => ...) to pause a job at a precise step or to
 * inject faults; every call is logged in state.storageCalls.
 *
 * Require it ONCE, first, from a test file (it registers module fakes before
 * the code under test loads), then call harness.install(test).
 */

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const Module = require("node:module");

process.env.JWT_SECRET = "rl-3-4-test-secret-not-a-real-one-0123456789";

const root = path.resolve(__dirname, "..", "..", "..");
require("../../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const { createFakeUploadDb } = require("./fake-upload-db.cjs");
const F = require("./mp4-fixtures.cjs");

function fakeAt(filename, exports) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const fake = (relativePath, exports) => fakeAt(path.join(root, relativePath), exports);

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = id(1);
const OTHER = id(2);
const CLASS = id(101);
const CLASS_OTHER = id(102);
const LECTURE = id(201);
const LECTURE_2 = id(202);
const LECTURE_OTHER = id(203);
const T0 = Date.parse("2026-11-14T10:00:00.000Z");
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const STALE_MS = 10 * 60_000;

const state = {
  cookie: null,
  clock: T0,
  freeBytes: 500 * GIB,
  storagePatches: {},
  storageCalls: [],
  unhandled: [],
  fakeDb: null,
  /** Every gate created by a test: opened after each test, so a failing test never leaves a job paused. */
  gates: [],
};

function resetDb() {
  state.fakeDb = createFakeUploadDb();
  const { db } = state.fakeDb;
  for (const t of [OWNER, OTHER]) db.teachers.push({ id: t, isBlocked: false, isConfirmed: true, isRejected: false, emailConfirmed: true });
  db.classes.push({ id: CLASS, teacherId: OWNER, status: 0, name: "Grade 10" }, { id: CLASS_OTHER, teacherId: OTHER, status: 0, name: "Other" });
  db.lectures.push(
    { id: LECTURE, classId: CLASS, status: 0, title: "Algebra", date: new Date(T0), endDate: null },
    { id: LECTURE_2, classId: CLASS, status: 0, title: "Geometry", date: new Date(T0), endDate: null },
    { id: LECTURE_OTHER, classId: CLASS_OTHER, status: 0, title: "Theirs", date: new Date(T0), endDate: null }
  );
}
resetDb();

fakeAt(require.resolve("next/headers", { paths: [root] }), {
  cookies: () => ({ get: (name) => (name === "teacher_session" && state.cookie ? { name, value: state.cookie } : undefined) }),
  headers: () => new Headers(),
});
fake("lib/prisma.ts", {
  get prisma() {
    return state.fakeDb.prisma;
  },
});
fake("lib/server-clock.ts", {
  serverNow: async () => new Date(state.clock),
  serverNowSync: () => new Date(state.clock),
  resetServerClock() {},
});
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });
fake("lib/session-events.ts", { emitStudentDataChange: () => {} });

const { signAuthToken } = require(path.join(root, "lib", "auth.ts"));
const { LocalFileStorage, DIRECTORY_SYNC_SUPPORTED } = require(path.join(root, "lib", "file-storage", "local-file-storage.ts"));
const { UploadMutex } = require(path.join(root, "lib", "recorded-lectures", "upload-locks.ts"));
const keys = require(path.join(root, "lib", "recorded-lectures", "keys.ts"));
const completion = require(path.join(root, "services", "recorded-lecture-completion-service.ts"));
const maintenance = require(path.join(root, "services", "recorded-lecture-maintenance-service.ts"));
const scheduler = require(path.join(root, "services", "recorded-lecture-maintenance-scheduler.ts"));
const routes = {
  start: require(path.join(root, "app", "api", "lectures", "[id]", "recorded-lectures", "uploads", "route.ts")),
  chunk: require(path.join(root, "app", "api", "recorded-lectures", "uploads", "[uploadId]", "chunks", "route.ts")),
  upload: require(path.join(root, "app", "api", "recorded-lectures", "uploads", "[uploadId]", "route.ts")),
  complete: require(path.join(root, "app", "api", "recorded-lectures", "uploads", "[uploadId]", "complete", "route.ts")),
};

const proto = LocalFileStorage.prototype;
const originals = {};
for (const name of ["writeNewFile", "promote", "openRead", "openByteSource", "stat", "remove", "syncDirectory", "freeBytes"]) {
  originals[name] = proto[name];
  proto[name] = function intercepted(...args) {
    state.storageCalls.push({ name, key: args[0], to: name === "promote" ? args[1] : undefined });
    if (name === "freeBytes" && !state.storagePatches.freeBytes) return Promise.resolve(state.freeBytes);
    const patch = state.storagePatches[name];
    return patch ? patch.call(this, originals[name].bind(this), ...args) : originals[name].apply(this, args);
  };
}

process.on("unhandledRejection", (reason) => state.unhandled.push(reason));

let storageRoot = null;
const savedEnv = { FILE_STORAGE_ROOT: process.env.FILE_STORAGE_ROOT, RECORDED_LECTURE_CHUNK_BYTES: process.env.RECORDED_LECTURE_CHUNK_BYTES };

function install(test) {
  test.beforeEach(() => {
    resetDb();
    Object.assign(state, { cookie: null, clock: T0, freeBytes: 500 * GIB, storagePatches: {}, storageCalls: [], gates: [] });
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rl34-storage-"));
    process.env.FILE_STORAGE_ROOT = storageRoot;
    process.env.RECORDED_LECTURE_CHUNK_BYTES = String(MIB);
    globalThis.slRecordedLectureUploadMutex = new UploadMutex();
    delete globalThis.slRecordedLectureChunkWriters;
    completion.resetCompletionShutdownForTests();
    maintenance.resetMaintenanceStateForTests();
    scheduler.stopRecordedLectureMaintenance();
    scheduler.resetMaintenanceTicksForTests();
  });
  test.afterEach(async () => {
    // Never hang: release anything a (possibly failed) test left paused, then wait (bounded).
    for (const g of state.gates) g.open();
    state.storagePatches = {};
    state.fakeDb.db.hooks = {};
    state.fakeDb.db.faults.down = false;
    let timer;
    await Promise.race([
      completion.waitForCompletionJobs(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("completion jobs did not finish within 60 s")), 60_000);
      }),
    ]).finally(() => clearTimeout(timer));
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  test.after(() => {
    Object.assign(proto, originals);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// ---- Helpers -------------------------------------------------------------------------------------------------

async function signInAs(teacherId) {
  state.cookie = await signAuthToken({ sub: teacherId, email: `${teacherId}@example.com`, role: "TEACHER", name: "Teacher" });
}

/** A valid MP4 (H.264 + AAC, 3600 s) of about `mediaBytes` + a few KiB. */
function validMp4(mediaBytes = 2 * MIB + 300 * 1024, options = {}) {
  return Buffer.from(F.mp4({ media: F.mdat(mediaBytes), ...options }));
}
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

async function json(response) {
  return { response, status: response.status, body: await response.json() };
}

async function createUpload(sizeBytes, { lecture = LECTURE, part = 1 } = {}) {
  const request = new Request(`http://localhost/api/lectures/${lecture}/recorded-lectures/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: `Part ${part}`, partNumber: part, fileName: "lecture.mp4", mimeType: "video/mp4", sizeBytes }),
  });
  const result = await json(await routes.start.POST(request, { params: { id: lecture } }));
  return result;
}

async function putChunk(uploadId, offset, bytes) {
  const request = new Request(`http://localhost/api/recorded-lectures/uploads/${uploadId}/chunks`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "upload-offset": String(offset), "content-length": String(bytes.length) },
    body: bytes,
  });
  return json(await routes.chunk.PUT(request, { params: { uploadId } }));
}

/** Starts an upload of `file` and sends all of it in `chunkSize` pieces; returns the upload id. */
async function uploadFile(file, { chunkSize = MIB, lecture = LECTURE, part = 1 } = {}) {
  const started = await createUpload(file.length, { lecture, part });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const uploadId = started.body.data.uploadId;
  for (let offset = 0; offset < file.length; offset += chunkSize) {
    const piece = file.subarray(offset, Math.min(file.length, offset + chunkSize));
    const result = await putChunk(uploadId, offset, piece);
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  return uploadId;
}

async function complete(uploadId) {
  const request = new Request(`http://localhost/api/recorded-lectures/uploads/${uploadId}/complete`, { method: "POST" });
  return json(await routes.complete.POST(request, { params: { uploadId } }));
}

async function cancel(uploadId) {
  const request = new Request(`http://localhost/api/recorded-lectures/uploads/${uploadId}`, { method: "DELETE" });
  return json(await routes.upload.DELETE(request, { params: { uploadId } }));
}

async function status(uploadId) {
  const request = new Request(`http://localhost/api/recorded-lectures/uploads/${uploadId}`);
  return json(await routes.upload.GET(request, { params: { uploadId } }));
}

/** Simulates another process: a fresh upload mutex. */
function asOtherProcess() {
  globalThis.slRecordedLectureUploadMutex = new UploadMutex();
}

/** Waits until `condition()` holds (checked every event-loop turn; at most 30 s of real time). */
async function until(condition, label = "condition", maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A promise with its resolve function: a gate a patched step waits on. */
function gate() {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  const g = { promise, open };
  state.gates.push(g);
  return g;
}

const db = () => state.fakeDb.db;
const sessionOf = (uploadId) => db().sessions.find((s) => s.id === uploadId);
const recordingOf = (uploadId) => db().recordings.find((r) => r.id === sessionOf(uploadId).recordedLectureId);
const chunksOf = (uploadId) => db().chunks.filter((c) => c.uploadSessionId === uploadId).sort((a, b) => a.chunkIndex - b.chunkIndex);
const abs = (key) => path.join(storageRoot, ...key.split("/"));
const chunkPath = (uploadId, token) => abs(keys.chunkScratchKey(uploadId, token));
const finalPath = (uploadId, storedName) => {
  const r = recordingOf(uploadId);
  return abs(keys.recordingFileKey({ teacherId: r.teacherId, lectureId: r.lectureId, recordingId: r.id, storedName }));
};
const assemblyPath = (uploadId, claimName) => abs(keys.assemblyKey(uploadId, claimName));

/** Every file below the storage root, relative, "/"-separated. */
function allFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(storageRoot, full).split(path.sep).join("/"));
    }
  };
  if (storageRoot && fs.existsSync(storageRoot)) walk(storageRoot);
  return out.sort();
}

module.exports = {
  state,
  install,
  ids: { OWNER, OTHER, CLASS, CLASS_OTHER, LECTURE, LECTURE_2, LECTURE_OTHER, id },
  constants: { T0, MIB, GIB, STALE_MS },
  F,
  keys,
  completion,
  maintenance,
  scheduler,
  DIRECTORY_SYNC_SUPPORTED,
  UploadMutex,
  signInAs,
  validMp4,
  sha256,
  createUpload,
  putChunk,
  uploadFile,
  complete,
  cancel,
  status,
  asOtherProcess,
  until,
  gate,
  db,
  sessionOf,
  recordingOf,
  chunksOf,
  chunkPath,
  finalPath,
  assemblyPath,
  allFiles,
  storageRoot: () => storageRoot,
};
