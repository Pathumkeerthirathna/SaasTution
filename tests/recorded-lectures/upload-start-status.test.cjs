/*
 * Recorded Lectures RL-3.2: start an upload and read its status, through the
 * REAL routes, service, session check and LocalFileStorage:
 *
 *   POST /api/lectures/[id]/recorded-lectures/uploads
 *   GET  /api/recorded-lectures/uploads/[uploadId]
 *
 * No database: lib/prisma.ts is the in-memory fake of
 * helpers/fake-upload-db.cjs (transactions with rollback, FIFO advisory locks,
 * foreign keys, the partial part-number index and the key CHECKs).
 * lib/server-clock.ts is a controllable clock, next/headers the teacher
 * cookie (signed with a throwaway JWT_SECRET). FILE_STORAGE_ROOT is a fresh
 * temporary folder; free space is controlled by replacing
 * LocalFileStorage.prototype.freeBytes.
 *
 *   npm run test:recorded-lectures
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Module = require("node:module");

process.env.JWT_SECRET = "rl-3-2-test-secret-not-a-real-one-0123456789";

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

// ---- Ids and fixtures ------------------------------------------------------------------------------------

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = id(1);
const OTHER = id(2);
const BLOCKED = id(3);
const UNCONFIRMED = id(4);
const EMAIL_UNCONFIRMED = id(5);
const REJECTED = id(6);
const CLASS = id(101);
const CLASS_OTHER = id(102);
const CLASS_INACTIVE = id(103);
const CLASS_BLOCKED = id(104);
const LECTURE = id(201);
const LECTURE_REMOVED = id(202);
const LECTURE_OTHER = id(203);
const LECTURE_INACTIVE_CLASS = id(204);
const LECTURE_BLOCKED = id(205);
const LECTURE_2 = id(206);

const T0 = Date.parse("2026-11-14T10:00:00.000Z");
const GIB = 1024 ** 3;

const state = { cookie: null, clock: T0, freeBytes: 500 * GIB };
let fakeDb;

function teacher(idValue, overrides = {}) {
  return { id: idValue, isBlocked: false, isConfirmed: true, isRejected: false, emailConfirmed: true, ...overrides };
}

function resetDb() {
  fakeDb = createFakeUploadDb();
  const { db } = fakeDb;
  db.teachers.push(
    teacher(OWNER),
    teacher(OTHER),
    teacher(BLOCKED, { isBlocked: true }),
    teacher(UNCONFIRMED, { isConfirmed: false }),
    teacher(EMAIL_UNCONFIRMED, { emailConfirmed: false }),
    teacher(REJECTED, { isRejected: true, isConfirmed: false })
  );
  db.classes.push(
    { id: CLASS, teacherId: OWNER, status: 0, name: "Grade 10" },
    { id: CLASS_OTHER, teacherId: OTHER, status: 0, name: "Other" },
    { id: CLASS_INACTIVE, teacherId: OWNER, status: 1, name: "Deactivated" },
    { id: CLASS_BLOCKED, teacherId: BLOCKED, status: 0, name: "Blocked" }
  );
  for (const t of [UNCONFIRMED, EMAIL_UNCONFIRMED, REJECTED]) db.classes.push({ id: `${t.slice(0, -3)}9${t.slice(-2)}`, teacherId: t, status: 0, name: "x" });
  db.lectures.push(
    { id: LECTURE, classId: CLASS, status: 0, title: "Algebra", date: new Date(T0), endDate: null },
    { id: LECTURE_2, classId: CLASS, status: 0, title: "Geometry", date: new Date(T0), endDate: null },
    { id: LECTURE_REMOVED, classId: CLASS, status: 1, title: "Removed", date: new Date(T0), endDate: null },
    { id: LECTURE_OTHER, classId: CLASS_OTHER, status: 0, title: "Theirs", date: new Date(T0), endDate: null },
    { id: LECTURE_INACTIVE_CLASS, classId: CLASS_INACTIVE, status: 0, title: "Inactive class", date: new Date(T0), endDate: null },
    { id: LECTURE_BLOCKED, classId: CLASS_BLOCKED, status: 0, title: "Blocked", date: new Date(T0), endDate: null }
  );
  for (const t of [UNCONFIRMED, EMAIL_UNCONFIRMED, REJECTED]) {
    db.lectures.push({ id: `${t.slice(0, -3)}8${t.slice(-2)}`, classId: `${t.slice(0, -3)}9${t.slice(-2)}`, status: 0, title: "x", date: new Date(T0), endDate: null });
  }
}
const lectureOf = (t) => `${t.slice(0, -3)}8${t.slice(-2)}`;
resetDb();

// ---- Fakes (before the code under test loads) -------------------------------------------------------

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
const { LocalFileStorage } = require(path.join(root, "lib", "file-storage", "local-file-storage.ts"));
const startRoute = require(path.join(root, "app", "api", "lectures", "[id]", "recorded-lectures", "uploads", "route.ts"));
const statusRoute = require(path.join(root, "app", "api", "recorded-lectures", "uploads", "[uploadId]", "route.ts"));
const { FORBIDDEN_DTO_KEYS } = require(path.join(root, "lib", "recorded-lectures", "upload-dto.ts"));

const realFreeBytes = LocalFileStorage.prototype.freeBytes;
LocalFileStorage.prototype.freeBytes = async function freeBytes() {
  state.freeBytesCalls = (state.freeBytesCalls ?? 0) + 1;
  return state.freeBytes;
};

// ---- Per-test environment ---------------------------------------------------------------------------------

let storageRoot;
const ENV_KEYS = ["FILE_STORAGE_ROOT", "RECORDED_LECTURE_MIN_FREE_BYTES", "RECORDED_LECTURE_MAX_ACTIVE_UPLOADS_PER_TEACHER"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

test.beforeEach(() => {
  resetDb();
  state.cookie = null;
  state.clock = T0;
  state.freeBytes = 500 * GIB;
  state.freeBytesCalls = 0;
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rl32-storage-"));
  process.env.FILE_STORAGE_ROOT = storageRoot;
  delete process.env.RECORDED_LECTURE_MIN_FREE_BYTES;
  delete process.env.RECORDED_LECTURE_MAX_ACTIVE_UPLOADS_PER_TEACHER;
});
test.afterEach(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
test.after(() => {
  LocalFileStorage.prototype.freeBytes = realFreeBytes;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---- Helpers ------------------------------------------------------------------------------------------------

async function signInAs(teacherId) {
  state.cookie = await signAuthToken({ sub: teacherId, email: `${teacherId}@example.com`, role: "TEACHER", name: "Teacher" });
}

const declaration = (overrides = {}) => ({
  title: "Algebra part 1",
  partNumber: 1,
  fileName: "Algebra 1.mp4",
  mimeType: "video/mp4",
  sizeBytes: 4_000_000_000,
  ...overrides,
});

async function start(lectureId, body = declaration(), { headers = {}, rawBody } = {}) {
  const request = new Request(`http://localhost:3000/api/lectures/${encodeURIComponent(lectureId)}/recorded-lectures/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody !== undefined ? rawBody : JSON.stringify(body),
    ...(rawBody instanceof ReadableStream ? { duplex: "half" } : {}),
  });
  const response = await startRoute.POST(request, { params: { id: lectureId } });
  return { response, status: response.status, body: await response.json() };
}

async function status(uploadId) {
  const request = new Request(`http://localhost:3000/api/recorded-lectures/uploads/${encodeURIComponent(uploadId)}`);
  const response = await statusRoute.GET(request, { params: { uploadId } });
  return { response, status: response.status, body: await response.json() };
}

/** Every file below the storage root (directories excluded). */
function storedFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(storageRoot, full));
    }
  };
  walk(storageRoot);
  return out;
}

function assertNoInternals(body) {
  const json = JSON.stringify(body);
  for (const key of FORBIDDEN_DTO_KEYS) assert.ok(!json.includes(`"${key}"`), `key ${key}`);
  for (const value of [OWNER, CLASS, storageRoot, "System/", "Teachers/", ".part"]) assert.ok(!json.includes(value), `value ${value}`);
}

const rows = () => ({ recordings: fakeDb.db.recordings.length, sessions: fakeDb.db.sessions.length });

// ---- Start: success ---------------------------------------------------------------------------------------

test("start: 201, the approved status DTO, both rows written, no file created", async () => {
  await signInAs(OWNER);
  const { status: code, body } = await start(LECTURE);
  assert.equal(code, 201);
  assert.equal(body.success, true);
  const dto = body.data;
  assert.ok(UUID.test(dto.uploadId) && UUID.test(dto.recordingId));
  assert.deepEqual(
    { ...dto, uploadId: "U", recordingId: "R" },
    {
      uploadId: "U",
      recordingId: "R",
      lectureId: LECTURE,
      title: "Algebra part 1",
      partNumber: 1,
      uploadState: "ACTIVE",
      recordingState: "UPLOADING",
      expectedBytes: 4_000_000_000,
      receivedBytes: 0,
      chunkCount: 0,
      chunkBytes: 8_388_608,
      expiresAt: new Date(T0 + 24 * 3600_000).toISOString(),
      chunkInProgress: false,
      retryAfterSeconds: null,
      failureCode: null,
      completionStalled: false,
    }
  );
  assertNoInternals(body);

  const [recording] = fakeDb.db.recordings;
  const [session] = fakeDb.db.sessions;
  assert.equal(recording.id, dto.recordingId);
  assert.equal(recording.teacherId, OWNER);
  assert.equal(recording.classId, CLASS);
  assert.equal(recording.state, "UPLOADING");
  assert.equal(recording.displayFileName, "Algebra 1.mp4");
  assert.equal(recording.sizeBytes, BigInt(4_000_000_000));
  assert.equal(session.id, dto.uploadId);
  assert.equal(session.teacherId, OWNER);
  assert.equal(session.state, "ACTIVE");
  assert.equal(session.expectedBytes, BigInt(4_000_000_000));
  assert.equal(session.receivedBytes, BigInt(0));
  assert.equal(session.createdAt.getTime(), T0, "serverNow, not the client");
  assert.equal(session.expiresAt.getTime(), T0 + 24 * 3600_000);
  assert.equal(fakeDb.db.transactions.at(-1).outcome, "commit");

  assert.deepEqual(storedFiles(), [], "no .part or any other file is created by start");
  assert.ok(fs.statSync(path.join(storageRoot, "System", "TemporaryUploads")).isDirectory(), "only the feature folders exist");
});

test("start: transaction options, lock timeout first, then teacher lock, then capacity lock, then the candidate rows", async () => {
  await signInAs(OWNER);
  await start(LECTURE);
  const tx = fakeDb.db.transactions.at(-1);
  assert.deepEqual(tx.options, { maxWait: 5000, timeout: 15000 });
  const steps = fakeDb.db.log.filter((e) => e.tx === tx.id).map((e) => (e.kind === "locked" ? `lock ${e.key}` : e.kind)).filter((k) => k !== "raw");
  const at = (step) => steps.indexOf(step);
  assert.equal(steps[0], "rawUnsafe", "SET LOCAL lock_timeout first");
  assert.match(fakeDb.db.log.find((e) => e.tx === tx.id).sql, /^SET LOCAL lock_timeout = '3000ms'$/);
  assert.ok(at(`lock recorded-lectures:teacher:${OWNER}`) > 0);
  assert.ok(at(`lock recorded-lectures:teacher:${OWNER}`) < at("recordingUploadSession.count"));
  assert.ok(at("recordingUploadSession.count") < at("lock recorded-lectures:capacity"));
  assert.ok(at("lock recorded-lectures:capacity") < at("recordedLecture.create"));
  assert.ok(at("recordedLecture.create") < at("recordingUploadSession.create"));
  assert.ok(steps.lastIndexOf("recordingUploadSession.findMany") > at("recordingUploadSession.create"), "the reservation aggregate runs after the candidate is written");
  assert.equal(state.freeBytesCalls, 1);
});

test("start: client-supplied teacherId / classId are ignored", async () => {
  await signInAs(OWNER);
  const { status: code } = await start(LECTURE, declaration({ teacherId: OTHER, classId: CLASS_OTHER, lectureId: LECTURE_OTHER }));
  assert.equal(code, 201);
  assert.equal(fakeDb.db.recordings[0].teacherId, OWNER);
  assert.equal(fakeDb.db.recordings[0].classId, CLASS);
  assert.equal(fakeDb.db.recordings[0].lectureId, LECTURE);
});

// ---- Start: authentication, ids, ownership, account, lecture state ---------------------------------------------

test("start: unauthenticated -> 401, nothing written", async () => {
  const { status: code, body } = await start(LECTURE);
  assert.equal(code, 401);
  assert.equal(body.error.code, "UNAUTHORIZED");
  assert.deepEqual(rows(), { recordings: 0, sessions: 0 });
  assert.equal(fakeDb.db.log.length, 0);
});

test("start: invalid lecture ids -> 404 LECTURE_NOT_FOUND before any database access", async () => {
  await signInAs(OWNER);
  for (const bad of ["ABCDEF00-0000-4000-8000-000000000201", "lecture-1", "../../etc", `${LECTURE}x`, " "]) {
    const { status: code, body } = await start(bad);
    assert.equal(code, 404, bad);
    assert.equal(body.error.code, "LECTURE_NOT_FOUND");
  }
  assert.equal(fakeDb.db.log.length, 0);
});

test("start: another teacher's lecture -> 404, no transaction, nothing written", async () => {
  await signInAs(OWNER);
  const { status: code, body } = await start(LECTURE_OTHER);
  assert.equal(code, 404);
  assert.equal(body.error.code, "LECTURE_NOT_FOUND");
  assert.equal(fakeDb.db.transactions.length, 0);
  assert.deepEqual(rows(), { recordings: 0, sessions: 0 });
});

test("start: blocked, unconfirmed, email-unconfirmed or rejected teachers -> 403 TEACHER_ACCOUNT_INACTIVE", async () => {
  for (const t of [BLOCKED, UNCONFIRMED, EMAIL_UNCONFIRMED, REJECTED]) {
    await signInAs(t);
    const lecture = t === BLOCKED ? LECTURE_BLOCKED : lectureOf(t);
    const { status: code, body } = await start(lecture);
    assert.equal(code, 403, t);
    assert.equal(body.error.code, "TEACHER_ACCOUNT_INACTIVE");
  }
  // Unknown teacher (valid token, no row) and a non-UUID teacher id.
  await signInAs(id(999));
  assert.equal((await start(LECTURE)).status, 403);
  await signInAs("legacy-teacher");
  assert.equal((await start(LECTURE)).status, 403);
  assert.deepEqual(rows(), { recordings: 0, sessions: 0 });
});

test("start: a teacher blocked between the pre-check and the transaction is refused inside it (rollback)", async () => {
  await signInAs(OWNER);
  fakeDb.db.hooks.beforeLectureFind = (_where, txId) => {
    if (txId === null) fakeDb.db.teachers.find((t) => t.id === OWNER).isBlocked = true;
  };
  const { status: code, body } = await start(LECTURE);
  assert.equal(code, 403);
  assert.equal(body.error.code, "TEACHER_ACCOUNT_INACTIVE");
  assert.equal(fakeDb.db.transactions.at(-1).outcome, "rollback");
  assert.deepEqual(rows(), { recordings: 0, sessions: 0 });
});

test("start: removed lecture -> 404; lecture of a deactivated class -> 409 LECTURE_NOT_ACTIVE", async () => {
  await signInAs(OWNER);
  const removed = await start(LECTURE_REMOVED);
  assert.equal(removed.status, 404);
  assert.equal(removed.body.error.code, "LECTURE_NOT_FOUND");

  const inactive = await start(LECTURE_INACTIVE_CLASS);
  assert.equal(inactive.status, 409);
  assert.equal(inactive.body.error.code, "LECTURE_NOT_ACTIVE");
  assert.deepEqual(rows(), { recordings: 0, sessions: 0 });
});

test("start: a lecture removed between the pre-check and the transaction -> 409 LECTURE_NOT_ACTIVE", async () => {
  await signInAs(OWNER);
  fakeDb.db.hooks.beforeLectureFind = (_where, txId) => {
    if (txId !== null) fakeDb.db.lectures.find((l) => l.id === LECTURE).status = 1;
  };
  const { status: code, body } = await start(LECTURE);
  assert.equal(code, 409);
  assert.equal(body.error.code, "LECTURE_NOT_ACTIVE");
  assert.deepEqual(rows(), { recordings: 0, sessions: 0 });
});

// ---- Start: request body ---------------------------------------------------------------------------------------

test("start: invalid declarations -> 400 UPLOAD_DECLARATION_INVALID with the RL-1 reason; nothing written", async () => {
  await signInAs(OWNER);
  const cases = [
    [{ title: "" }, "TITLE_REQUIRED"],
    [{ title: "x".repeat(201) }, "TITLE_TOO_LONG"],
    [{ partNumber: 0 }, "PART_NUMBER_INVALID"],
    [{ partNumber: "1" }, "PART_NUMBER_INVALID"],
    [{ fileName: "lecture.mov" }, "FILE_NAME_INVALID"],
    [{ fileName: undefined }, "FILE_NAME_INVALID"],
    [{ mimeType: "video/quicktime" }, "MIME_TYPE_NOT_SUPPORTED"],
    [{ sizeBytes: 0 }, "FILE_EMPTY"],
    [{ sizeBytes: 4_000_000_001 }, "FILE_TOO_LARGE"],
    [{ sizeBytes: -1 }, "FILE_SIZE_INVALID"],
    [{ sizeBytes: 1.5 }, "FILE_SIZE_INVALID"],
    [{ sizeBytes: "100" }, "FILE_SIZE_INVALID"],
    [{ sizeBytes: 2 ** 53 }, "FILE_SIZE_INVALID"],
  ];
  for (const [overrides, reason] of cases) {
    const { status: code, body } = await start(LECTURE, declaration(overrides));
    assert.equal(code, 400, reason);
    assert.equal(body.error.code, "UPLOAD_DECLARATION_INVALID");
    assert.equal(body.error.details.reason, reason);
  }
  const array = await start(LECTURE, [declaration()]);
  assert.equal(array.status, 400);
  assert.equal(array.body.error.details.reason, "TITLE_REQUIRED");
  assert.deepEqual(rows(), { recordings: 0, sessions: 0 });
});

test("start: body limits: JSON content type, 16 KiB declared or streamed, valid JSON", async () => {
  await signInAs(OWNER);
  const wrongType = await start(LECTURE, declaration(), { headers: { "content-type": "text/plain" } });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.body.error.code, "JSON_CONTENT_TYPE_REQUIRED");

  const big = JSON.stringify({ ...declaration(), pad: "x".repeat(17 * 1024) });
  const declaredTooLarge = await start(LECTURE, null, { rawBody: big });
  assert.equal(declaredTooLarge.status, 413);
  assert.equal(declaredTooLarge.body.error.code, "REQUEST_TOO_LARGE");

  // No Content-Length (a stream): refused once it passes 16 KiB, without reading the rest.
  let pulled = 0;
  const endless = new ReadableStream({
    pull(controller) {
      pulled++;
      if (pulled > 1000) return controller.close();
      controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
    },
  });
  const streamed = await start(LECTURE, null, { rawBody: endless });
  assert.equal(streamed.status, 413);
  assert.ok(pulled < 10, `stopped reading early (${pulled} pulls)`);

  const invalid = await start(LECTURE, null, { rawBody: "{not json" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "INVALID_JSON");

  // A declared length above the limit is refused before reading, even if the actual body is small.
  const declaredOnly = await start(LECTURE, declaration(), { headers: { "content-length": String(16 * 1024 + 1) } });
  assert.equal(declaredOnly.status, 413);
  assert.equal(declaredOnly.body.error.code, "REQUEST_TOO_LARGE");

  const badLength = await start(LECTURE, declaration(), { headers: { "content-length": "abc" } });
  assert.equal(badLength.status, 400);
  assert.deepEqual(rows(), { recordings: 0, sessions: 0 });
});

// ---- Start: part numbers, cap, capacity, locks -----------------------------------------------------------------

test("start: active part-number conflict -> 409 PART_NUMBER_IN_USE (both Prisma target shapes); rolled back", async () => {
  await signInAs(OWNER);
  assert.equal((await start(LECTURE)).status, 201);
  for (const target of [["lectureId", "partNumber"], "RecordedLecture_active_part_number_key"]) {
    fakeDb.db.partNumberConflictTarget = target;
    const { status: code, body } = await start(LECTURE);
    assert.equal(code, 409);
    assert.equal(body.error.code, "PART_NUMBER_IN_USE");
  }
  assert.deepEqual(rows(), { recordings: 1, sessions: 1 });
  // Another lecture may use the same part number.
  assert.equal((await start(LECTURE_2)).status, 201);
});

test("start: a FAILED part frees its number", async () => {
  await signInAs(OWNER);
  await start(LECTURE);
  Object.assign(fakeDb.db.recordings[0], { state: "FAILED", failureCode: "UPLOAD_CANCELLED", failedAt: new Date(T0) });
  Object.assign(fakeDb.db.sessions[0], { state: "CANCELLED", endedAt: new Date(T0) });
  assert.equal((await start(LECTURE)).status, 201);
});

test("start: at most three active uploads per teacher (ACTIVE and COMPLETING count)", async () => {
  await signInAs(OWNER);
  for (const part of [1, 2, 3]) assert.equal((await start(LECTURE, declaration({ partNumber: part }))).status, 201);
  const fourth = await start(LECTURE, declaration({ partNumber: 4 }));
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error.code, "TOO_MANY_ACTIVE_UPLOADS");
  assert.deepEqual(rows(), { recordings: 3, sessions: 3 });

  // A COMPLETING upload still counts; a cancelled one does not.
  Object.assign(fakeDb.db.sessions[0], { state: "COMPLETING", receivedBytes: BigInt(4_000_000_000), chunkCount: 477 });
  assert.equal((await start(LECTURE, declaration({ partNumber: 4 }))).status, 409);
  Object.assign(fakeDb.db.sessions[1], { state: "CANCELLED", endedAt: new Date(T0) });
  Object.assign(fakeDb.db.recordings[1], { state: "FAILED", failureCode: "UPLOAD_CANCELLED", failedAt: new Date(T0) });
  assert.equal((await start(LECTURE, declaration({ partNumber: 4 }))).status, 201);

  // Other teachers are unaffected.
  await signInAs(OTHER);
  assert.equal((await start(LECTURE_OTHER)).status, 201);
});

test("start: expired uploads are expired first and no longer count (their part numbers are freed)", async () => {
  await signInAs(OWNER);
  for (const part of [1, 2, 3]) await start(LECTURE, declaration({ partNumber: part }));
  state.clock = T0 + 24 * 3600_000; // exactly at expiry
  const again = await start(LECTURE, declaration({ partNumber: 1 }));
  assert.equal(again.status, 201);
  const expired = fakeDb.db.sessions.filter((s) => s.state === "EXPIRED");
  assert.equal(expired.length, 3);
  for (const s of expired) assert.equal(s.endedAt.getTime(), state.clock);
  const failed = fakeDb.db.recordings.filter((r) => r.state === "FAILED");
  assert.equal(failed.length, 3);
  for (const r of failed) assert.equal(r.failureCode, "UPLOAD_EXPIRED");
});

test("start: insufficient storage -> 507 INSUFFICIENT_STORAGE; both rows rolled back; no file", async () => {
  await signInAs(OWNER);
  state.freeBytes = 5 * GIB + 3_999_999_999; // minFreeBytes (5 GiB) + 1 byte short of the reservation
  const { status: code, body } = await start(LECTURE);
  assert.equal(code, 507);
  assert.equal(body.error.code, "INSUFFICIENT_STORAGE");
  assert.equal(fakeDb.db.transactions.at(-1).outcome, "rollback");
  assert.deepEqual(rows(), { recordings: 0, sessions: 0 });
  assert.deepEqual(storedFiles(), []);

  // Exactly enough is allowed; existing reservations then count against the next upload.
  state.freeBytes = 5 * GIB + 4_000_000_000;
  assert.equal((await start(LECTURE)).status, 201);
  const second = await start(LECTURE, declaration({ partNumber: 2, sizeBytes: 1 }));
  assert.equal(second.status, 507);
  assert.deepEqual(rows(), { recordings: 1, sessions: 1 });
});

test("start: a lock timeout (teacher or capacity lock) -> 503 UPLOAD_BUSY with Retry-After; rolled back", async () => {
  await signInAs(OWNER);
  for (const lockKey of [`recorded-lectures:teacher:${OWNER}`, "recorded-lectures:capacity"]) {
    fakeDb.db.faults.lockTimeout = (key) => key === lockKey;
    const { response, status: code, body } = await start(LECTURE);
    assert.equal(code, 503, lockKey);
    assert.equal(body.error.code, "UPLOAD_BUSY");
    assert.equal(response.headers.get("Retry-After"), "1");
    assert.deepEqual(rows(), { recordings: 0, sessions: 0 });
  }
});

test("start: storage not configured -> 503, nothing written", async () => {
  await signInAs(OWNER);
  delete process.env.FILE_STORAGE_ROOT;
  const { status: code, body } = await start(LECTURE);
  assert.equal(code, 503);
  assert.equal(body.error.code, "RECORDED_LECTURES_NOT_CONFIGURED");
  assert.ok(!JSON.stringify(body).includes("FILE_STORAGE_ROOT"));
  assert.equal(fakeDb.db.transactions.length, 0);
});

// ---- Start: concurrency -------------------------------------------------------------------------------------

test("concurrency: six simultaneous starts with a cap of three -> exactly three succeed", async () => {
  await signInAs(OWNER);
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map((part) => start(LECTURE, declaration({ partNumber: part }))));
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, 201, 201, 409, 409, 409]);
  assert.deepEqual(rows(), { recordings: 3, sessions: 3 });
});

test("concurrency: the teacher lock is what enforces the cap (without it the fake lets a fourth through)", async () => {
  await signInAs(OWNER);
  fakeDb.db.disableAdvisoryLocks = true;
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map((part) => start(LECTURE, declaration({ partNumber: part }))));
  assert.ok(results.filter((r) => r.status === 201).length > 3, "the test can detect a broken lock");
});

test("concurrency: two simultaneous starts of the same part -> one 201, one 409 PART_NUMBER_IN_USE", async () => {
  await signInAs(OWNER);
  const results = await Promise.all([start(LECTURE), start(LECTURE)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(results.find((r) => r.status === 409).body.error.code, "PART_NUMBER_IN_USE");
  assert.deepEqual(rows(), { recordings: 1, sessions: 1 });
});

test("concurrency: simultaneous starts by different teachers both reserve capacity (no over-commit)", async () => {
  state.freeBytes = 5 * GIB + 4_000_000_000; // room for exactly one 4 GB upload
  await signInAs(OWNER);
  const ownerCookie = state.cookie;
  await signInAs(OTHER);
  const otherCookie = state.cookie;
  const run = async (cookie, lecture) => {
    state.cookie = cookie;
    return start(lecture);
  };
  const results = await Promise.all([run(ownerCookie, LECTURE), run(otherCookie, LECTURE_OTHER)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 507]);
  assert.deepEqual(rows(), { recordings: 1, sessions: 1 });
});

// ---- Status --------------------------------------------------------------------------------------------------

test("status: the owner gets the status DTO; numbers, no internals", async () => {
  await signInAs(OWNER);
  const started = (await start(LECTURE)).body.data;
  state.clock = T0 + 60_000;
  const { status: code, body } = await status(started.uploadId);
  assert.equal(code, 200);
  assert.deepEqual(body.data, started);
  assertNoInternals(body);
});

test("status: another teacher's upload -> 404 (indistinguishable from a missing one)", async () => {
  await signInAs(OWNER);
  const { uploadId } = (await start(LECTURE)).body.data;
  await signInAs(OTHER);
  const other = await status(uploadId);
  const missing = await status(id(777));
  assert.equal(other.status, 404);
  assert.deepEqual(other.body, missing.body);
  assert.equal(other.body.error.code, "UPLOAD_NOT_FOUND");
  // The lookup filtered by both id and the session's teacher.
  const lookup = fakeDb.db.log.find((e) => e.kind === "recordingUploadSession.findFirst" && e.where.id === uploadId && e.where.teacherId === OTHER);
  assert.ok(lookup);
});

test("status: unauthenticated -> 401; invalid ids -> 404 without a database query", async () => {
  const anonymous = await status(id(1));
  assert.equal(anonymous.status, 401);
  await signInAs(OWNER);
  const before = fakeDb.db.log.length;
  for (const bad of ["ABCDEF00-0000-4000-8000-000000000001", "x", "../.."]) assert.equal((await status(bad)).status, 404);
  assert.equal(fakeDb.db.log.length, before);
});

test("status: a blocked owner may still inspect the upload", async () => {
  await signInAs(OWNER);
  const { uploadId } = (await start(LECTURE)).body.data;
  fakeDb.db.teachers.find((t) => t.id === OWNER).isBlocked = true;
  const { status: code, body } = await status(uploadId);
  assert.equal(code, 200);
  assert.equal(body.data.uploadState, "ACTIVE");
});

test("status: an expired upload is expired lazily (conditional update), once", async () => {
  await signInAs(OWNER);
  const { uploadId } = (await start(LECTURE)).body.data;
  state.clock = T0 + 24 * 3600_000 - 1;
  assert.equal((await status(uploadId)).body.data.uploadState, "ACTIVE", "one millisecond before expiry");

  state.clock = T0 + 24 * 3600_000;
  const { status: code, body } = await status(uploadId);
  assert.equal(code, 200);
  assert.equal(body.data.uploadState, "EXPIRED");
  assert.equal(body.data.recordingState, "FAILED");
  assert.equal(body.data.failureCode, "UPLOAD_EXPIRED");
  const session = fakeDb.db.sessions[0];
  assert.equal(session.endedAt.getTime(), state.clock);
  assert.equal(session.version, 1);
  const update = fakeDb.db.log.find((e) => e.kind === "recordingUploadSession.updateMany");
  assert.deepEqual(Object.keys(update.where).sort(), ["OR", "expiresAt", "id", "state", "teacherId"], "conditional, also on no current lease (RL-3.5)");
  assert.equal(update.where.state, "ACTIVE");

  const updatesBefore = fakeDb.db.log.filter((e) => e.kind.endsWith("updateMany")).length;
  state.clock += 60_000;
  assert.equal((await status(uploadId)).body.data.uploadState, "EXPIRED");
  assert.equal(fakeDb.db.log.filter((e) => e.kind.endsWith("updateMany")).length, updatesBefore, "no second update");
});

test("status: a concurrent expiry is applied only once (conditional update)", async () => {
  await signInAs(OWNER);
  const { uploadId } = (await start(LECTURE)).body.data;
  state.clock = T0 + 25 * 3600_000;
  const results = await Promise.all([status(uploadId), status(uploadId), status(uploadId)]);
  for (const r of results) assert.equal(r.body.data.uploadState, "EXPIRED");
  assert.equal(fakeDb.db.sessions[0].version, 1);
  const recordingUpdates = fakeDb.db.log.filter((e) => e.kind === "recordedLecture.updateMany");
  assert.equal(recordingUpdates.length, 1);
});

test("status: an unsafe stored byte count fails closed (500, generic message, no value leaked)", async () => {
  await signInAs(OWNER);
  const { uploadId } = (await start(LECTURE)).body.data;
  fakeDb.db.sessions[0].receivedBytes = BigInt(2) ** BigInt(53); // impossible under the CHECKs; defence in depth
  fakeDb.db.sessions[0].expectedBytes = BigInt(2) ** BigInt(53) + BigInt(1);
  const { status: code, body } = await status(uploadId);
  assert.equal(code, 500);
  assert.equal(body.error.code, "INTERNAL_SERVER_ERROR");
  assert.ok(!JSON.stringify(body).includes("9007199254740992"));
});

// ---- Route placement ---------------------------------------------------------------------------------------------

test("route placement: /api/recorded-lectures is outside the middleware matcher (bodies stream, RL-3.3)", () => {
  const source = fs.readFileSync(path.join(root, "middleware.ts"), "utf8");
  const matcher = source.slice(source.indexOf("matcher:"), source.indexOf("]", source.indexOf("matcher:")));
  const entries = [...matcher.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    const prefix = entry.replace(/\/:path\*$/, "");
    assert.ok(!"/api/recorded-lectures/uploads/x/chunks".startsWith(prefix), entry);
  }
  assert.ok(entries.includes("/api/lectures/:path*"), "the start route (small JSON) stays behind the middleware");
});
