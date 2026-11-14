/*
 * Recorded Lectures RL-3.3: PUT /api/recorded-lectures/uploads/[uploadId]/chunks
 * through the REAL route, chunk service, session check and LocalFileStorage
 * (a temporary FILE_STORAGE_ROOT), with the in-memory database fake
 * (helpers/fake-upload-db.cjs) and a controllable server clock.
 *
 * Option B: every chunk is its own token file; covered here: the full
 * sequence, headers, authorization (grant and commit), short / long / aborted
 * / stalled bodies, disk full, capacity, concurrency, lease expiry, takeover
 * and stale writers (a second process is simulated with a second upload
 * mutex), definite and ambiguous commit failures, a crash between the file
 * and the commit, SHA-256 consistency and bounded-memory streaming.
 *
 *   npm run test:recorded-lectures
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const v8 = require("node:v8");
const vm = require("node:vm");
const Module = require("node:module");

process.env.JWT_SECRET = "rl-3-3-test-secret-not-a-real-one-0123456789";

const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const { createFakeUploadDb, UUID } = require("./helpers/fake-upload-db.cjs");

function fakeAt(filename, exports) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const fake = (relativePath, exports) => fakeAt(path.join(root, relativePath), exports);

// ---- Fixtures ----------------------------------------------------------------------------------------------

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
const LEASE_MS = 300_000;

const state = { cookie: null, clock: T0, freeBytes: 500 * GIB, writeFault: null, writeOptions: [] };
let fakeDb;

function resetDb() {
  fakeDb = createFakeUploadDb();
  const { db } = fakeDb;
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
    return fakeDb.prisma;
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
const { StorageError } = require(path.join(root, "lib", "file-storage", "types.ts"));
const { UploadMutex } = require(path.join(root, "lib", "recorded-lectures", "upload-locks.ts"));
const startRoute = require(path.join(root, "app", "api", "lectures", "[id]", "recorded-lectures", "uploads", "route.ts"));
const chunkRoute = require(path.join(root, "app", "api", "recorded-lectures", "uploads", "[uploadId]", "chunks", "route.ts"));
const statusRoute = require(path.join(root, "app", "api", "recorded-lectures", "uploads", "[uploadId]", "route.ts"));

const proto = LocalFileStorage.prototype;
const real = { freeBytes: proto.freeBytes, writeNewFile: proto.writeNewFile };
proto.freeBytes = async () => state.freeBytes;
proto.writeNewFile = async function writeNewFile(key, source, options) {
  state.writeOptions.push({ key, options });
  if (state.writeFault) {
    const code = state.writeFault;
    state.writeFault = null;
    throw new StorageError(code);
  }
  return real.writeNewFile.call(this, key, source, options);
};

// ---- Per-test environment ----------------------------------------------------------------------------------

let storageRoot;
const ENV = {
  FILE_STORAGE_ROOT: undefined,
  RECORDED_LECTURE_CHUNK_BYTES: String(MIB),
  RECORDED_LECTURE_MAX_INFLIGHT_CHUNK_BYTES: undefined,
};
const savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));

test.beforeEach(() => {
  resetDb();
  Object.assign(state, { cookie: null, clock: T0, freeBytes: 500 * GIB, writeFault: null, writeOptions: [] });
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rl33-storage-"));
  process.env.FILE_STORAGE_ROOT = storageRoot;
  process.env.RECORDED_LECTURE_CHUNK_BYTES = String(MIB);
  delete process.env.RECORDED_LECTURE_MAX_INFLIGHT_CHUNK_BYTES;
  globalThis.slRecordedLectureUploadMutex = new UploadMutex();
});
test.afterEach(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
test.after(() => {
  Object.assign(proto, real);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---- Helpers --------------------------------------------------------------------------------------------------

async function signInAs(teacherId) {
  state.cookie = await signAuthToken({ sub: teacherId, email: `${teacherId}@example.com`, role: "TEACHER", name: "Teacher" });
}

/** Deterministic bytes: byte i of the file is (i * 7 + seed) % 251. */
function bytesAt(offset, length, seed = 3) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = ((offset + i) * 7 + seed) % 251;
  return out;
}
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

async function createUpload(sizeBytes, { lecture = LECTURE, part = 1 } = {}) {
  const request = new Request(`http://localhost/api/lectures/${lecture}/recorded-lectures/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: `Part ${part}`, partNumber: part, fileName: "lecture.mp4", mimeType: "video/mp4", sizeBytes }),
  });
  const response = await startRoute.POST(request, { params: { id: lecture } });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data.uploadId;
}

/**
 * A body that streams `total` bytes in pieces of `piece`, made on demand (one
 * piece per pull). With `pauseAt`, it stops after that many bytes until
 * resume() is called. abort()/error() make it fail.
 */
function streamingBody(offset, total, { piece = 64 * 1024, pauseAt = null, seed } = {}) {
  let sent = 0;
  let gate = null;
  let release = null;
  const control = {
    pulls: 0,
    get sent() {
      return sent;
    },
    paused: null,
    resume() {
      if (release) release();
    },
  };
  let markPaused;
  control.paused = new Promise((resolve) => (markPaused = resolve));
  control.stream = new ReadableStream({
    async pull(controller) {
      if (pauseAt !== null && sent >= pauseAt && !gate) {
        gate = new Promise((resolve) => (release = resolve));
        markPaused();
        await gate;
      }
      if (sent >= total) return controller.close();
      const length = Math.min(piece, total - sent);
      controller.enqueue(bytesAt(offset + sent, length, seed));
      sent += length;
      control.pulls++;
      if (control.onPull) control.onPull(sent);
    },
  }, { highWaterMark: 0 });
  return control;
}

async function put(uploadId, { offset, length, body, contentType = "application/octet-stream", headers = {}, signal } = {}) {
  const h = {};
  if (contentType !== null) h["content-type"] = contentType;
  if (offset !== undefined) h["upload-offset"] = String(offset);
  if (length !== undefined) h["content-length"] = String(length);
  Object.assign(h, headers);
  const init = { method: "PUT", headers: h, signal };
  if (body !== undefined) init.body = body;
  if (body instanceof ReadableStream) init.duplex = "half";
  const request = new Request(`http://localhost/api/recorded-lectures/uploads/${uploadId}/chunks`, init);
  const response = await chunkRoute.PUT(request, { params: { uploadId } });
  return { response, status: response.status, body: await response.json() };
}

/** PUTs bytes [offset, offset + length) of the deterministic file. */
const putRange = (uploadId, offset, length, extra = {}) => put(uploadId, { offset, length, body: bytesAt(offset, length, extra.seed), ...extra });

async function status(uploadId) {
  const response = await statusRoute.GET(new Request(`http://localhost/api/recorded-lectures/uploads/${uploadId}`), { params: { uploadId } });
  return (await response.json()).data;
}

const tempDir = () => path.join(storageRoot, "System", "TemporaryUploads");
const tempFiles = () => (fs.existsSync(tempDir()) ? fs.readdirSync(tempDir()).sort() : []);
const chunkFile = (uploadId, token) => path.join(tempDir(), `${uploadId}.${token}.chunk`);
const session = () => fakeDb.db.sessions.at(-1);
const sessionOf = (uploadId) => fakeDb.db.sessions.find((s) => s.id === uploadId);
const chunksOf = (uploadId) => fakeDb.db.chunks.filter((c) => c.uploadSessionId === uploadId);

/** Simulates a second process: a fresh upload mutex (the in-process one is not shared across processes). */
function asOtherProcess() {
  globalThis.slRecordedLectureUploadMutex = new UploadMutex();
}

function assertNoLease(s) {
  assert.equal(s.leaseToken, null);
  assert.equal(s.leaseOffset, null);
  assert.equal(s.leaseBytes, null);
  assert.equal(s.leaseExpiresAt, null);
}

// ---- The full sequence ----------------------------------------------------------------------------------------

test("sequence: three chunks -> three immutable token files, rows, byte counts, SHA-256, no .part", async () => {
  await signInAs(OWNER);
  const size = 2 * MIB + 512 * 1024;
  const uploadId = await createUpload(size);
  const plan = [[0, MIB], [MIB, MIB], [2 * MIB, 512 * 1024]];

  for (const [index, [offset, length]] of plan.entries()) {
    state.clock += 1000;
    const { response, status: code, body } = await putRange(uploadId, offset, length);
    assert.equal(code, 200, JSON.stringify(body));
    assert.deepEqual(body.data, { uploadId, receivedBytes: offset + length, expectedBytes: size, chunkCount: index + 1, complete: index === 2 });
    assert.equal(response.headers.get("Upload-Offset"), String(offset + length));
    const json = JSON.stringify(body) + JSON.stringify([...response.headers]);
    for (const c of chunksOf(uploadId)) assert.ok(!json.includes(c.leaseToken), "the lease token never leaves the server");
    assertNoLease(sessionOf(uploadId));
  }

  const rows = chunksOf(uploadId);
  assert.deepEqual(rows.map((c) => [c.chunkIndex, Number(c.startOffset), c.byteLength]), plan.map(([o, l], i) => [i, o, l]));
  assert.equal(new Set(rows.map((c) => c.leaseToken)).size, 3);
  for (const c of rows) {
    const onDisk = fs.readFileSync(chunkFile(uploadId, c.leaseToken));
    const expected = bytesAt(Number(c.startOffset), c.byteLength);
    assert.equal(onDisk.length, c.byteLength);
    assert.ok(Buffer.from(expected).equals(onDisk), "file content = the bytes sent");
    assert.equal(c.sha256, sha256(expected), "stored hash = hash of the bytes sent");
    assert.equal(c.sha256, sha256(onDisk), "stored hash = hash of the file read back");
  }
  assert.deepEqual(tempFiles(), rows.map((c) => `${uploadId}.${c.leaseToken}.chunk`).sort(), "only the committed chunk files; no .part");
  const s = sessionOf(uploadId);
  assert.equal(s.receivedBytes, BigInt(size));
  assert.equal(s.chunkCount, 3);
  assert.equal(s.version, 6, "grant + commit per chunk");
  for (const w of state.writeOptions) {
    assert.equal(w.options.sync, true);
    assert.equal(w.options.syncDirectory, true);
    assert.equal(w.options.exactBytes, w.options.maxBytes);
  }
});

test("sequence: the lease is granted under the capacity lock in transaction A, never held while streaming", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  fakeDb.db.log.length = 0;
  fakeDb.db.transactions.length = 0;
  assert.equal((await putRange(uploadId, 0, MIB)).status, 200);
  const [a, b] = fakeDb.db.transactions;
  assert.equal(fakeDb.db.transactions.length, 2);
  const stepsOf = (tx) => fakeDb.db.log.filter((e) => e.tx === tx.id).map((e) => (e.kind === "locked" ? `lock ${e.key}` : e.kind));
  const stepsA = stepsOf(a);
  assert.equal(stepsA[0], "rawUnsafe");
  assert.ok(stepsA.indexOf("lock recorded-lectures:capacity") < stepsA.indexOf("recordingUploadSession.updateMany"));
  assert.ok(stepsA.lastIndexOf("recordingUploadSession.findMany") > stepsA.indexOf("recordingUploadSession.updateMany"), "aggregate after the candidate lease");
  const stepsB = stepsOf(b);
  assert.ok(!stepsB.some((s) => s.startsWith("lock ")), "the commit takes no advisory lock");
  assert.ok(stepsB.indexOf("recordingUploadChunk.create") < stepsB.lastIndexOf("recordingUploadSession.updateMany"));
  const commit = fakeDb.db.log.filter((e) => e.tx === b.id && e.kind === "recordingUploadSession.updateMany").at(-1);
  assert.deepEqual(Object.keys(commit.where).sort(), ["chunkCount", "expiresAt", "id", "leaseExpiresAt", "leaseToken", "receivedBytes", "state", "teacherId", "version"]);
  assert.ok(commit.where.leaseExpiresAt.gt instanceof Date, "the lease must not have expired");
});

// ---- Headers ---------------------------------------------------------------------------------------------------

test("headers: offset, length and content type are validated before anything is written", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(2 * MIB);
  const cases = [
    [{ offset: undefined, length: 10 }, 400, "OFFSET_REQUIRED"],
    [{ offset: "x", length: 10 }, 400, "OFFSET_INVALID"],
    [{ offset: 5, length: 10 }, 409, "OFFSET_MISMATCH"],
    [{ offset: 0, length: undefined }, 411, "LENGTH_REQUIRED"],
    [{ offset: 0, headers: { "content-length": "abc" } }, 400, "LENGTH_INVALID"],
    [{ offset: 0, length: 0 }, 400, "LENGTH_INVALID"],
    [{ offset: 0, length: MIB + 1 }, 413, "CHUNK_TOO_LARGE"],
    [{ offset: 0, length: 10, contentType: "application/json" }, 415, "CONTENT_TYPE_INVALID"],
    [{ offset: 0, length: 10, contentType: null }, 415, "CONTENT_TYPE_INVALID"],
  ];
  for (const [options, code, errorCode] of cases) {
    const { status: actual, body, response } = await put(uploadId, { body: new Uint8Array(10), ...options });
    assert.equal(actual, code, errorCode);
    assert.equal(body.error.code, errorCode);
    if (errorCode === "OFFSET_MISMATCH") {
      assert.equal(body.error.details.receivedBytes, 0);
      assert.equal(response.headers.get("Upload-Offset"), "0");
    }
  }
  // More than remains: after 1.5 MiB of 2 MiB, a 1 MiB chunk does not fit.
  assert.equal((await putRange(uploadId, 0, MIB)).status, 200);
  assert.equal((await putRange(uploadId, MIB, MIB / 2)).status, 200);
  const tooMuch = await put(uploadId, { offset: MIB + MIB / 2, length: MIB, body: new Uint8Array(MIB) });
  assert.equal(tooMuch.status, 413);
  assert.equal(tooMuch.body.error.code, "CHUNK_EXCEEDS_REMAINING");
  assert.equal(chunksOf(uploadId).length, 2);
  assert.equal(tempFiles().length, 2);
  assertNoLease(sessionOf(uploadId));
});

// ---- Authorization ---------------------------------------------------------------------------------------------

test("authorization: unauthenticated 401; another teacher's upload / invalid id 404; nothing written", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  state.cookie = null;
  assert.equal((await putRange(uploadId, 0, 1024)).status, 401);
  await signInAs(OTHER);
  const other = await putRange(uploadId, 0, 1024);
  assert.equal(other.status, 404);
  assert.equal(other.body.error.code, "UPLOAD_NOT_FOUND");
  for (const bad of ["ABCDEF00-0000-4000-8000-000000000001", "x"]) assert.equal((await putRange(bad, 0, 1024)).status, 404);
  assert.deepEqual(tempFiles(), []);
  assertNoLease(sessionOf(uploadId));
});

test("authorization: a blocked teacher cannot upload chunks (403 at the grant)", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  fakeDb.db.teachers[0].isBlocked = true;
  const { status: code, body } = await putRange(uploadId, 0, 1024);
  assert.equal(code, 403);
  assert.equal(body.error.code, "TEACHER_ACCOUNT_INACTIVE");
  assert.deepEqual(tempFiles(), []);
  assert.equal(state.writeOptions.length, 0, "refused before any lease or file write");
  assertNoLease(sessionOf(uploadId));
});

test("authorization: a teacher blocked while the chunk streams is refused at the commit; the file is removed", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  const body = streamingBody(0, MIB, { pauseAt: 256 * 1024 });
  const pending = put(uploadId, { offset: 0, length: MIB, body: body.stream });
  await body.paused;
  fakeDb.db.teachers[0].isBlocked = true;
  body.resume();
  const { status: code, body: json } = await pending;
  assert.equal(code, 403);
  assert.equal(json.error.code, "TEACHER_ACCOUNT_INACTIVE");
  assert.deepEqual(tempFiles(), [], "the request's own file is removed");
  assert.equal(chunksOf(uploadId).length, 0);
  assertNoLease(sessionOf(uploadId));
  assert.equal(sessionOf(uploadId).receivedBytes, BigInt(0));
});

test("authorization: a removed lecture or deactivated class stops chunks (409 at the grant and at the commit)", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(2 * MIB);
  fakeDb.db.classes[0].status = 1;
  const atGrant = await putRange(uploadId, 0, 1024);
  assert.equal(atGrant.status, 409);
  assert.equal(atGrant.body.error.code, "LECTURE_NOT_ACTIVE");
  assert.equal(state.writeOptions.length, 0, "refused before any lease or file write");
  assertNoLease(sessionOf(uploadId));
  fakeDb.db.classes[0].status = 0;

  const body = streamingBody(0, MIB, { pauseAt: 128 * 1024 });
  const pending = put(uploadId, { offset: 0, length: MIB, body: body.stream });
  await body.paused;
  fakeDb.db.lectures[0].status = 1;
  body.resume();
  const atCommit = await pending;
  assert.equal(atCommit.status, 409);
  assert.equal(atCommit.body.error.code, "LECTURE_NOT_ACTIVE");
  assert.deepEqual(tempFiles(), []);
  assert.equal(chunksOf(uploadId).length, 0);
});

test("expiry: an expired upload is expired (once) and refuses chunks with 410", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  state.clock = T0 + 24 * 3600_000;
  const { status: code, body } = await putRange(uploadId, 0, 1024);
  assert.equal(code, 410);
  assert.equal(body.error.code, "UPLOAD_EXPIRED");
  assert.equal(sessionOf(uploadId).state, "EXPIRED");
  assert.equal((await putRange(uploadId, 0, 1024)).status, 410);
  assert.deepEqual(tempFiles(), []);
});

// ---- Bodies ---------------------------------------------------------------------------------------------------

test("bodies: short and long bodies are refused (exact byte count); no file, lease released; a retry succeeds", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  const short = await put(uploadId, { offset: 0, length: MIB, body: streamingBody(0, MIB - 1).stream });
  assert.equal(short.status, 400);
  assert.equal(short.body.error.code, "CHUNK_INCOMPLETE");
  const long = await put(uploadId, { offset: 0, length: 1000, body: streamingBody(0, 1001).stream });
  assert.equal(long.status, 400);
  assert.equal(long.body.error.code, "CHUNK_INCOMPLETE");
  assert.deepEqual(tempFiles(), []);
  assertNoLease(sessionOf(uploadId));
  assert.equal(sessionOf(uploadId).receivedBytes, BigInt(0));
  assert.equal((await putRange(uploadId, 0, MIB)).status, 200);
});

test("bodies: a client disconnect (abort) -> 400 CHUNK_ABORTED; no file; lease released", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  const controller = new AbortController();
  const body = streamingBody(0, MIB, { pauseAt: 64 * 1024 });
  const pending = put(uploadId, { offset: 0, length: MIB, body: body.stream, signal: controller.signal });
  await body.paused;
  controller.abort();
  const { status: code, body: json } = await pending;
  assert.equal(code, 400);
  assert.equal(json.error.code, "CHUNK_ABORTED");
  assert.deepEqual(tempFiles(), []);
  assertNoLease(sessionOf(uploadId));
});

test("bodies: a body still arriving at the write deadline (lease - 60 s) -> 408; no file; lease released", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  const body = streamingBody(0, MIB, { pauseAt: 64 * 1024 });
  const pending = put(uploadId, { offset: 0, length: MIB, body: body.stream });
  await body.paused;
  state.clock = T0 + LEASE_MS - 60_000; // exactly the deadline
  body.resume();
  const { status: code, body: json } = await pending;
  assert.equal(code, 408);
  assert.equal(json.error.code, "CHUNK_TIMEOUT");
  assert.deepEqual(tempFiles(), []);
  assertNoLease(sessionOf(uploadId));
});

test("bodies: disk full while writing -> 507; no row; lease released", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  state.writeFault = "NO_SPACE";
  const { status: code, body } = await putRange(uploadId, 0, 1024);
  assert.equal(code, 507);
  assert.equal(body.error.code, "INSUFFICIENT_STORAGE");
  assert.equal(chunksOf(uploadId).length, 0);
  assertNoLease(sessionOf(uploadId));
});

// ---- Capacity ---------------------------------------------------------------------------------------------------

test("capacity: the in-flight cap and free space are enforced at the grant; the lease is rolled back", async () => {
  await signInAs(OWNER);
  process.env.RECORDED_LECTURE_MAX_INFLIGHT_CHUNK_BYTES = String(MIB); // room for one 1 MiB chunk in flight
  const first = await createUpload(MIB, { part: 1 });
  const second = await createUpload(MIB, { part: 2 });
  const body = streamingBody(0, MIB, { pauseAt: 64 * 1024 });
  const pending = put(first, { offset: 0, length: MIB, body: body.stream });
  await body.paused;

  const capped = await putRange(second, 0, MIB);
  assert.equal(capped.status, 503);
  assert.equal(capped.body.error.code, "INFLIGHT_CHUNK_CAP");
  assert.ok(Number(capped.response.headers.get("Retry-After")) >= 1);
  assertNoLease(sessionOf(second));
  body.resume();
  assert.equal((await pending).status, 200);

  delete process.env.RECORDED_LECTURE_MAX_INFLIGHT_CHUNK_BYTES;
  state.freeBytes = 5 * GIB; // exactly minFreeBytes: no room for the second upload's remaining reservation
  const full = await putRange(second, 0, MIB);
  assert.equal(full.status, 507);
  assertNoLease(sessionOf(second));
  assert.equal(tempFiles().length, 1);
});

// ---- Concurrency, duplicates, takeover, stale writers ------------------------------------------------------------

test("concurrency: two PUTs for the same upload in one process -> the second waits, then 409 CHUNK_IN_PROGRESS", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  const body = streamingBody(0, MIB, { pauseAt: 64 * 1024 });
  const first = put(uploadId, { offset: 0, length: MIB, body: body.stream });
  await body.paused;
  const second = await putRange(uploadId, 0, MIB);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "CHUNK_IN_PROGRESS");
  assert.equal(second.response.headers.get("Retry-After"), "1");
  body.resume();
  assert.equal((await first).status, 200);
  assert.equal(chunksOf(uploadId).length, 1);
});

test("concurrency: a PUT from another process during a current lease -> 409 with Retry-After until the lease expires", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  const body = streamingBody(0, MIB, { pauseAt: 64 * 1024 });
  const first = put(uploadId, { offset: 0, length: MIB, body: body.stream });
  await body.paused;
  asOtherProcess();
  state.clock = T0 + 100_000;
  const second = await putRange(uploadId, 0, MIB);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "CHUNK_IN_PROGRESS");
  assert.equal(second.response.headers.get("Retry-After"), "200");
  body.resume();
  assert.equal((await first).status, 200);
});

test("concurrency: two processes granting at the same moment (both read before either updates) -> exactly one lease", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  // A runs with its own upload mutex ("process A"). Once A has read the session and reached the
  // capacity lock, it is held there; B then starts with a different mutex ("process B"), reads
  // the same session (no lease yet) and reaches the lock too. Both are released together, so
  // only the grant's conditional update (version) can separate them.
  const arrivals = [];
  let releaseBoth;
  const gate = new Promise((resolve) => (releaseBoth = resolve));
  let firstArrived;
  const firstArrival = new Promise((resolve) => (firstArrived = resolve));
  fakeDb.db.hooks.beforeAdvisoryLock = async (key, txId) => {
    if (key !== "recorded-lectures:capacity" || arrivals.length >= 2) return;
    arrivals.push(txId);
    if (arrivals.length === 1) firstArrived();
    if (arrivals.length === 2) releaseBoth();
    await gate;
  };
  globalThis.slRecordedLectureUploadMutex = new UploadMutex();
  const a = put(uploadId, { offset: 0, length: MIB, body: bytesAt(0, MIB, 11) });
  await firstArrival;
  globalThis.slRecordedLectureUploadMutex = new UploadMutex();
  const b = put(uploadId, { offset: 0, length: MIB, body: bytesAt(0, MIB, 22) });
  const results = await Promise.all([a, b]);
  fakeDb.db.hooks.beforeAdvisoryLock = null;

  assert.equal(arrivals.length, 2, "both requests read the session before either was granted");
  const codes = results.map((r) => `${r.status}${r.body.error ? ` ${r.body.error.code}` : ""}`).sort();
  assert.deepEqual(codes, ["200", "409 CHUNK_IN_PROGRESS"], "the loser is refused at the grant, never after streaming");
  assert.equal(chunksOf(uploadId).length, 1);
  assert.equal(state.writeOptions.length, 1, "only the winner wrote a file");
  assert.equal(tempFiles().length, 1);
});

test("duplicates: re-sending a committed chunk -> 409 OFFSET_MISMATCH with the server offset; nothing changes", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(2 * MIB);
  assert.equal((await putRange(uploadId, 0, MIB)).status, 200);
  const before = tempFiles();
  const again = await putRange(uploadId, 0, MIB);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "OFFSET_MISMATCH");
  assert.equal(again.body.error.details.receivedBytes, MIB);
  assert.equal(again.response.headers.get("Upload-Offset"), String(MIB));
  assert.deepEqual(tempFiles(), before);
  assert.equal(chunksOf(uploadId).length, 1);
});

test("stale writer (other process): A stalls past its lease, B takes over and commits; A resumes and cannot touch B's data", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  const a = streamingBody(0, MIB, { pauseAt: 512 * 1024, seed: 99 }); // A's bytes differ from B's
  const pendingA = put(uploadId, { offset: 0, length: MIB, body: a.stream });
  await a.paused;
  const tokenA = sessionOf(uploadId).leaseToken;
  assert.ok(fs.existsSync(chunkFile(uploadId, tokenA)), "A is writing its own token file");

  asOtherProcess();
  state.clock = T0 + LEASE_MS + 1; // A's lease has expired
  const b = await putRange(uploadId, 0, MIB);
  assert.equal(b.status, 200);
  const [rowB] = chunksOf(uploadId);
  assert.notEqual(rowB.leaseToken, tokenA);
  const fileB = fs.readFileSync(chunkFile(uploadId, rowB.leaseToken));

  a.resume();
  const resultA = await pendingA;
  assert.equal(resultA.status, 408, "A is past its write deadline");
  assert.ok(!fs.existsSync(chunkFile(uploadId, tokenA)), "A's own file is gone");
  assert.ok(fs.readFileSync(chunkFile(uploadId, rowB.leaseToken)).equals(fileB), "B's committed file is unchanged");
  assert.equal(rowB.sha256, sha256(fileB));
  assert.equal(chunksOf(uploadId).length, 1);
  assert.equal(sessionOf(uploadId).receivedBytes, BigInt(MIB));
  assertNoLease(sessionOf(uploadId));
});

test("stale writer at commit: A wrote its file, B took over meanwhile -> A's commit is LEASE_LOST, only A's file removed", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  let tokenA = null;
  let takeoverDone = false;
  fakeDb.db.hooks.beforeTransaction = async () => {
    // A's commit transaction (A's lease exists and A's file is complete): B takes over first.
    if (takeoverDone || !sessionOf(uploadId).leaseToken) return;
    tokenA = sessionOf(uploadId).leaseToken;
    if (!fs.existsSync(chunkFile(uploadId, tokenA)) || fs.statSync(chunkFile(uploadId, tokenA)).size !== MIB) return;
    takeoverDone = true;
    asOtherProcess();
    state.clock = T0 + LEASE_MS + 1;
    const b = await putRange(uploadId, 0, MIB);
    assert.equal(b.status, 200);
  };
  const a = await put(uploadId, { offset: 0, length: MIB, body: bytesAt(0, MIB, 99) });
  assert.ok(takeoverDone);
  assert.equal(a.status, 409);
  assert.equal(a.body.error.code, "LEASE_LOST");
  assert.ok(!fs.existsSync(chunkFile(uploadId, tokenA)));
  const [rowB] = chunksOf(uploadId);
  assert.notEqual(rowB.leaseToken, tokenA);
  assert.equal(rowB.sha256, sha256(fs.readFileSync(chunkFile(uploadId, rowB.leaseToken))));
  assert.equal(rowB.sha256, sha256(bytesAt(0, MIB)), "B's bytes, not A's");
  assert.deepEqual(tempFiles(), [`${uploadId}.${rowB.leaseToken}.chunk`]);
});

test("lease expiry without takeover: a commit after the lease expired is refused (LEASE_LOST); file removed; retry works", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  let expired = false;
  fakeDb.db.hooks.beforeTransaction = async () => {
    const s = sessionOf(uploadId);
    if (!expired && s.leaseToken && fs.existsSync(chunkFile(uploadId, s.leaseToken)) && fs.statSync(chunkFile(uploadId, s.leaseToken)).size === MIB) {
      expired = true;
      state.clock = s.leaseExpiresAt.getTime(); // the lease ends exactly now
    }
  };
  const late = await putRange(uploadId, 0, MIB);
  assert.ok(expired);
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, "LEASE_LOST");
  assert.deepEqual(tempFiles(), []);
  assert.equal(chunksOf(uploadId).length, 0);
  assert.equal(sessionOf(uploadId).receivedBytes, BigInt(0));
  fakeDb.db.hooks.beforeTransaction = null;
  assert.equal((await putRange(uploadId, 0, MIB)).status, 200);
});

// ---- Database failures --------------------------------------------------------------------------------------------

test("database: a failure before the file (lock timeout at the grant) -> 503; no file, no lease", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  fakeDb.db.faults.lockTimeout = (key) => key === "recorded-lectures:capacity";
  const { status: code, body, response } = await putRange(uploadId, 0, 1024);
  assert.equal(code, 503);
  assert.equal(body.error.code, "UPLOAD_BUSY");
  assert.equal(response.headers.get("Retry-After"), "1");
  assert.deepEqual(tempFiles(), []);
  assertNoLease(sessionOf(uploadId));
});

test("database: a definite failure at the commit (constraint) -> the request's own file is removed, lease released", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(2 * MIB);
  // A conflicting chunk row (chunk index 0) makes the insert fail with P2002: a certain rollback.
  fakeDb.db.chunks.push({ uploadSessionId: uploadId, chunkIndex: 0, startOffset: BigInt(4096), byteLength: 1, leaseToken: "f".repeat(64), sha256: null, receivedAt: new Date(T0) });
  const { status: code } = await putRange(uploadId, 0, MIB);
  assert.equal(code, 500);
  assert.deepEqual(tempFiles(), []);
  assertNoLease(sessionOf(uploadId));
  assert.equal(sessionOf(uploadId).receivedBytes, BigInt(0));
});

test("database: an ambiguous commit that DID commit -> 200 (established by re-reading); the file is kept", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  let faulted = false;
  fakeDb.db.faults.commit = () => {
    // Transaction B's callback has inserted the chunk row: commit it, then report a broken connection.
    if (!faulted && chunksOf(uploadId).length === 1) {
      faulted = true;
      return "commit-then-throw";
    }
    return null;
  };
  const { status: code, body } = await putRange(uploadId, 0, MIB);
  assert.ok(faulted, "the ambiguous fault really happened");
  assert.ok(fakeDb.db.log.some((e) => e.kind === "recordingUploadChunk.findFirst" && e.tx === null), "the outcome was established by re-reading");
  assert.equal(code, 200);
  assert.equal(body.data.receivedBytes, MIB);
  const [row] = chunksOf(uploadId);
  assert.ok(fs.existsSync(chunkFile(uploadId, row.leaseToken)), "the committed file is kept");
});

test("database: an ambiguous commit that did NOT commit -> 503; the file is KEPT for DB-aware cleanup; retry works", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  let faulted = false;
  fakeDb.db.faults.commit = () => {
    if (!faulted && chunksOf(uploadId).length === 1) {
      faulted = true;
      return "rollback-then-throw";
    }
    return null;
  };
  const { status: code, body } = await putRange(uploadId, 0, MIB);
  assert.ok(faulted);
  assert.equal(code, 503);
  assert.equal(body.error.code, "UPLOAD_BUSY");
  assert.equal(chunksOf(uploadId).length, 0);
  const kept = tempFiles();
  assert.equal(kept.length, 1, "the uncommitted file is preserved (outcome was unknown)");
  assertNoLease(sessionOf(uploadId));

  assert.equal((await putRange(uploadId, 0, MIB)).status, 200);
  const [row] = chunksOf(uploadId);
  assert.ok(!kept.includes(`${uploadId}.${row.leaseToken}.chunk`), "a new token file, not the orphan");
  assert.equal(tempFiles().length, 2, "the orphan stays until cleanup (RL-3.5) confirms it is unreferenced");
});

test("crash between the file and the commit: lease stays until it expires; then the chunk is sent again under a new token", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  fakeDb.db.hooks.beforeTransaction = async () => {
    const s = sessionOf(uploadId);
    if (s.leaseToken && fs.existsSync(chunkFile(uploadId, s.leaseToken)) && fs.statSync(chunkFile(uploadId, s.leaseToken)).size === MIB) {
      fakeDb.db.faults.down = true; // the process "dies": nothing reaches the database any more
    }
  };
  const crashed = await putRange(uploadId, 0, MIB);
  assert.equal(crashed.status, 503);
  fakeDb.db.hooks.beforeTransaction = null;
  fakeDb.db.faults.down = false;
  const orphanToken = sessionOf(uploadId).leaseToken;
  assert.ok(orphanToken, "the lease survived the crash");
  assert.ok(fs.existsSync(chunkFile(uploadId, orphanToken)), "the written file survived, uncommitted");

  state.clock = T0 + 10_000;
  const blocked = await putRange(uploadId, 0, MIB);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "CHUNK_IN_PROGRESS");

  state.clock = T0 + LEASE_MS + 1;
  assert.equal((await putRange(uploadId, 0, MIB)).status, 200);
  const [row] = chunksOf(uploadId);
  assert.notEqual(row.leaseToken, orphanToken);
  assert.ok(fs.existsSync(chunkFile(uploadId, orphanToken)), "the orphan is left for DB-aware cleanup");
  assert.equal((await status(uploadId)).receivedBytes, MIB);
});

// ---- Durability and memory -------------------------------------------------------------------------------------------

test("durability: the chunk file is flushed, closed and its directory flushed before the commit (platform aware)", async () => {
  await signInAs(OWNER);
  const uploadId = await createUpload(MIB);
  const results = [];
  const original = proto.writeNewFile;
  proto.writeNewFile = async function (key, source, options) {
    const result = await original.call(this, key, source, options);
    results.push({ result, transactionsBefore: fakeDb.db.transactions.length });
    return result;
  };
  try {
    assert.equal((await putRange(uploadId, 0, MIB)).status, 200);
  } finally {
    proto.writeNewFile = original;
  }
  assert.equal(results.length, 1);
  assert.equal(results[0].result.bytesWritten, MIB);
  assert.equal(results[0].result.directorySynced, DIRECTORY_SYNC_SUPPORTED, `directory fsync on ${process.platform}`);
  // Written while only transaction A had run; the commit (transaction B) came after.
  const commitTx = fakeDb.db.transactions.at(-1);
  assert.ok(commitTx.id > results[0].transactionsBefore);
});

test("memory: a 64 MiB chunk streams to disk with bounded read-ahead and bounded memory", async () => {
  await signInAs(OWNER);
  process.env.RECORDED_LECTURE_CHUNK_BYTES = String(64 * MIB);
  process.env.RECORDED_LECTURE_MAX_INFLIGHT_CHUNK_BYTES = String(128 * MIB);
  const size = 64 * MIB;
  const uploadId = await createUpload(size);

  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc");
  gc();
  const baseline = process.memoryUsage().arrayBuffers;

  const body = streamingBody(0, size, { piece: 64 * 1024 });
  let maxLead = 0;
  let peak = 0;
  body.onPull = (sent) => {
    const files = tempFiles().filter((f) => f.endsWith(".chunk"));
    const written = files.length === 1 ? fs.statSync(path.join(tempDir(), files[0])).size : 0;
    maxLead = Math.max(maxLead, sent - written);
    if (body.pulls % 64 === 0) {
      gc();
      peak = Math.max(peak, process.memoryUsage().arrayBuffers - baseline);
    }
  };
  const { status: code } = await put(uploadId, { offset: 0, length: size, body: body.stream });
  assert.equal(code, 200);
  const [row] = chunksOf(uploadId);
  assert.equal(fs.statSync(chunkFile(uploadId, row.leaseToken)).size, size);
  assert.equal(row.sha256, sha256(bytesAt(0, size)));
  console.log(`# memory: 64 MiB chunk, max read-ahead ${(maxLead / 1024).toFixed(0)} KiB, peak arrayBuffers growth ${(peak / MIB).toFixed(2)} MiB`);
  assert.ok(maxLead <= 4 * 64 * 1024, `read-ahead ${maxLead} bytes: the body is pulled only as fast as it is written`);
  assert.ok(peak < 16 * MIB, `peak arrayBuffers growth ${peak} bytes: the chunk is never held in memory`);
});
