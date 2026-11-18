/*
 * Recorded Lectures RL-4.3: student playback through the REAL stream route,
 * stream service, session check, RL-4.2 access filter, cached storage,
 * stream slots and LocalFileStorage (a temporary FILE_STORAGE_ROOT holding
 * real recording files), with the evaluating Prisma double.
 *
 *   GET / HEAD /api/student/recorded-lectures/[recordingId]/stream
 *
 * After every test all response bodies are consumed or cancelled and the
 * slot counts must be back to zero.
 */

"use strict";

require("../helpers/no-class-access-restrictions.cjs"); // this suite does not model class fees (tests/class-access covers access control)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const F = require("./helpers/student-fixture.cjs");

const { root, state, NOW, id, TEACHER_A, TEACHER_B, STUDENT, CLASSMATE, STORED, ORIGINAL_NAME, R, seed, signIn, signInTeacher } = F;

const { LocalFileStorage } = require(path.join(root, "lib", "file-storage", "local-file-storage.ts"));
const keys = require(path.join(root, "lib", "recorded-lectures", "keys.ts"));
const slotsModule = require(path.join(root, "lib", "recorded-lectures", "stream-slots.ts"));
const storageModule = require(path.join(root, "lib", "recorded-lectures", "storage.ts"));
const streamRoute = require(path.join(root, "app", "api", "student", "recorded-lectures", "[recordingId]", "stream", "route.ts"));

const SIZE = 300_000;
const DATA = Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 31) % 253));

// ---- Storage and accounting ----------------------------------------------------------------------

let storageRoot = null;
const savedRoot = process.env.FILE_STORAGE_ROOT;
const counters = { opens: 0, storageOpens: 0 };
const openBodies = [];

const proto = LocalFileStorage.prototype;
const originalOpenRead = proto.openRead;
proto.openRead = function countedOpenRead(...args) {
  counters.opens += 1;
  return originalOpenRead.apply(this, args);
};
const originalStorageOpen = LocalFileStorage.open;
LocalFileStorage.open = function countedOpen(...args) {
  counters.storageOpens += 1;
  return originalStorageOpen.apply(this, args);
};

function rowOf(recId) {
  return state.fake.db.recordings.find((r) => r.id === recId);
}

async function writeRecordingFile(recId, bytes = DATA) {
  const row = rowOf(recId);
  const storage = await LocalFileStorage.open({ root: storageRoot });
  const key = keys.recordingFileKey({ teacherId: row.teacherId, lectureId: row.lectureId, recordingId: row.id, storedName: STORED });
  await storage.writeNewFile(key, (async function* () { yield new Uint8Array(bytes); })(), { maxBytes: Math.max(bytes.length, 1) });
  row.sizeBytes = BigInt(bytes.length);
  return key;
}

test.beforeEach(async () => {
  seed();
  state.cookie = null;
  state.clock = NOW;
  state.logs.length = 0;
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rl43-route-"));
  process.env.FILE_STORAGE_ROOT = storageRoot;
  storageModule.resetRecordedLectureStorageCacheForTests();
  slotsModule.resetStreamSlotsForTests();
  // Every recording that has a stored name gets a real file, so a 404 is never "no file".
  for (const row of state.fake.db.recordings) if (row.storedFileName) await writeRecordingFile(row.id);
  counters.opens = 0;
  counters.storageOpens = 0;
});

test.afterEach(async () => {
  for (const body of openBodies.splice(0)) await body.cancel().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const slots = slotsModule.getStreamSlots();
  assert.equal(slots.inUse, 0, "every slot released after the test");
  assert.equal(slots.studentsStreaming, 0);
  storageModule.resetRecordedLectureStorageCacheForTests();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

test.after(() => {
  proto.openRead = originalOpenRead;
  LocalFileStorage.open = originalStorageOpen;
  if (savedRoot === undefined) delete process.env.FILE_STORAGE_ROOT;
  else process.env.FILE_STORAGE_ROOT = savedRoot;
});

// ---- Calling the route ---------------------------------------------------------------------------

async function call(method, recordingId, headers = {}, init = {}) {
  const request = new Request(`http://localhost/api/student/recorded-lectures/${recordingId}/stream`, { method, headers, ...init });
  const response = await streamRoute[method](request, { params: { recordingId } });
  if (response.body) openBodies.push(response.body);
  return response;
}
const get = (recordingId, headers, init) => call("GET", recordingId, headers, init);
const head = (recordingId, headers) => call("HEAD", recordingId, headers);

async function bytes(response) {
  return Buffer.from(await response.arrayBuffer());
}
async function json(response) {
  return JSON.parse(Buffer.from(await response.arrayBuffer()).toString("utf8"));
}
function headerText(response) {
  return JSON.stringify([...response.headers.entries()]);
}

const SECRETS = () => [STORED, "0123456789abcdef", ORIGINAL_NAME, TEACHER_A, TEACHER_B, storageRoot, path.basename(storageRoot), "Teachers/", "RecordedLectures/", "TemporaryUploads"];

function assertNoLeak(text, where) {
  for (const secret of SECRETS()) assert.ok(!text.includes(secret), `${where}: ${secret}`);
}

function assertPlaybackHeaders(res) {
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(res.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-disposition"), 'inline; filename="recording.mp4"');
  assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  for (const absent of ["etag", "last-modified", "content-encoding", "set-cookie"]) assert.equal(res.headers.get(absent), null, absent);
  assertNoLeak(headerText(res), "headers");
}

// ---- Playback ------------------------------------------------------------------------------------

test("GET without Range: 200, the whole file, every security header", async () => {
  await signIn();
  const res = await get(R.ok);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), String(SIZE));
  assertPlaybackHeaders(res);
  assert.ok((await bytes(res)).equals(DATA));
  assert.equal(slotsModule.getStreamSlots().inUse, 0);
});

test("GET with Range: 206 with Content-Range; suffix and open-ended ranges", async () => {
  await signIn();
  for (const [range, start, end] of [["bytes=0-1", 0, 1], ["bytes=1000-", 1000, SIZE - 1], ["bytes=-500", SIZE - 500, SIZE - 1], ["bytes=5-9999999", 5, SIZE - 1]]) {
    const res = await get(R.ok, { Range: range });
    assert.equal(res.status, 206, range);
    assert.equal(res.headers.get("content-range"), `bytes ${start}-${end}/${SIZE}`);
    assert.equal(res.headers.get("content-length"), String(end - start + 1));
    assertPlaybackHeaders(res);
    assert.ok((await bytes(res)).equals(DATA.subarray(start, end + 1)), range);
  }
});

test("GET with Range and If-Range: the Range is ignored (200, whole file)", async () => {
  await signIn();
  const res = await get(R.ok, { Range: "bytes=0-99", "If-Range": '"anything"' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-range"), null);
  assert.ok((await bytes(res)).equals(DATA));
});

test("416 for an unsatisfiable range: Content-Range bytes */size, no body, no slot, file never opened", async () => {
  await signIn();
  const res = await get(R.ok, { Range: `bytes=${SIZE}-` });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get("content-range"), `bytes */${SIZE}`);
  assert.equal(res.body, null);
  assertPlaybackHeaders(res);
  assert.equal(counters.opens, 0);
});

test("HEAD: same status and headers as GET, no body, file never opened, no slot (even at the limit)", async () => {
  await signIn();
  slotsModule.resetStreamSlotsForTests(1, 1);
  const holding = await get(R.ok); // takes the only slot
  assert.equal(holding.status, 200);
  const opensBefore = counters.opens;
  const full = await head(R.ok);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-length"), String(SIZE));
  assert.equal(full.body, null);
  assertPlaybackHeaders(full);
  const partial = await head(R.ok, { Range: "bytes=10-19" });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 10-19/${SIZE}`);
  const unsatisfiable = await head(R.ok, { Range: `bytes=${SIZE}-` });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(counters.opens, opensBefore, "HEAD never opens the file");
  assert.equal(slotsModule.getStreamSlots().inUse, 1, "only the GET holds a slot");
  await bytes(holding);
});

test("routes: GET and HEAD exported explicitly; Node.js runtime; always dynamic", () => {
  assert.equal(streamRoute.runtime, "nodejs");
  assert.equal(streamRoute.dynamic, "force-dynamic");
  assert.deepEqual(Object.keys(streamRoute).filter((k) => /^[A-Z]+$/.test(k)).sort(), ["GET", "HEAD"]);
});

// ---- Authentication and authorisation ------------------------------------------------------------

async function expectError(res, status, code) {
  assert.equal(res.status, status);
  assert.equal(res.headers.get("cache-control"), "private, no-store, max-age=0");
  assertNoLeak(headerText(res), `${code} headers`);
  if (res.body === null) return null; // HEAD
  const body = await json(res);
  assert.equal(body.error.code, code);
  assertNoLeak(JSON.stringify(body), `${code} body`);
  return body;
}

test("auth: no session, a teacher session, a stale session are 401; an inactive student 403 (GET and HEAD)", async () => {
  for (const method of ["GET", "HEAD"]) {
    seed();
    state.cookie = null;
    await expectError(await call(method, R.ok), 401, "UNAUTHORIZED");
    await signInTeacher();
    await expectError(await call(method, R.ok), 401, "UNAUTHORIZED");
    await signIn(STUDENT, 0);
    state.fake.db.students[0].sessionVersion = 1;
    await expectError(await call(method, R.ok), 401, "UNAUTHORIZED");
    state.fake.db.students[0].sessionVersion = 0;
    state.fake.db.students[0].status = 1;
    await expectError(await call(method, R.ok), 403, "STUDENT_ACCOUNT_INACTIVE");
  }
  assert.equal(counters.opens, 0);
});

test("auth: HEAD error responses have no body", async () => {
  const res = await head(R.ok);
  assert.equal(res.status, 401);
  assert.equal(res.body, null);
  assert.equal(res.headers.get("content-length"), null);
});

const EXCLUDED = [
  "removedEnrollment", "inactiveClass", "deletedLecture", "uploading", "verifying", "failed", "removed", "purgePending", "noStoredName", "otherClass", "otherTeacher",
];

test("authorisation: every ineligible recording is a 404 identical to a missing or malformed id; nothing opened, no slot", async () => {
  await signIn();
  const missing = await json(await get(id(999)));
  assert.equal(missing.error.code, "RECORDED_LECTURE_NOT_FOUND");
  assert.deepEqual(await json(await get("not-a-uuid")), missing);
  assert.deepEqual(await json(await get("../../etc/passwd")), missing);
  for (const key of EXCLUDED) {
    const res = await get(R[key]);
    assert.equal(res.status, 404, key);
    assert.deepEqual(await json(res), missing, key);
    assert.equal((await head(R[key])).status, 404, `HEAD ${key}`);
  }
  assert.equal(counters.opens, 0);
  assert.equal(counters.storageOpens, 0, "storage is not even opened for a refused request");
});

test("authorisation: pending and rejected students get the same 404", async () => {
  for (const confirmation of ["PENDING", "REJECTED"]) {
    seed();
    await signIn();
    state.fake.db.students[0].confirmationStatus = confirmation;
    const res = await get(R.ok);
    assert.equal(res.status, 404, confirmation);
    assert.equal((await json(res)).error.code, "RECORDED_LECTURE_NOT_FOUND");
  }
});

test("authorisation: the other students' recordings play for the classmate enrolled there (fixture is sound)", async () => {
  await signIn(CLASSMATE);
  assert.equal((await get(R.otherClass)).status, 200);
  assert.equal((await get(R.otherTeacher)).status, 200);
  assert.equal((await get(R.ok)).status, 404);
});

test("authorisation: the exact RL-4.2 access filter is used for playback", async () => {
  await signIn();
  const service = require(path.join(root, "services", "recorded-lecture-student-service.ts"));
  await bytes(await get(R.ok, { Range: "bytes=0-9" }));
  const query = state.fake.queries.find((q) => q.model === "recordedLecture");
  assert.deepEqual(query.args.where, { AND: [{ id: R.ok }, service.studentRecordedLectureAccessWhere(STUDENT)] });
  for (const field of ["displayFileName", "title", "failureCode"]) assert.ok(!(field in query.args.select), field);
});

test("re-authorisation on every request: a removed or rejected student's next Range request is 404", async () => {
  await signIn();
  assert.equal((await get(R.ok, { Range: "bytes=0-99" })).status, 206);
  state.fake.db.classStudents[0].isActive = false;
  assert.equal((await get(R.ok, { Range: "bytes=100-199" })).status, 404);
  state.fake.db.classStudents[0].isActive = true;
  assert.equal((await get(R.ok, { Range: "bytes=100-199" })).status, 206);
  state.fake.db.students[0].confirmationStatus = "REJECTED";
  assert.equal((await head(R.ok)).status, 404);
  state.fake.db.students[0].confirmationStatus = "APPROVED";
  rowOf(R.ok).status = 2; // teacher removed it
  assert.equal((await get(R.ok)).status, 404);
});

// ---- Limits --------------------------------------------------------------------------------------

test("limits: a student can hold 4 streams; the 5th is 429 STREAM_LIMIT_REACHED with Retry-After 5", async () => {
  await signIn();
  const held = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await get(R.ok);
    assert.equal(res.status, 200);
    held.push(res);
  }
  assert.equal(slotsModule.getStreamSlots().studentInUse(STUDENT), 4);
  const refused = await get(R.okPart2);
  await expectError(refused, 429, "STREAM_LIMIT_REACHED");
  assert.equal(refused.headers.get("retry-after"), "5");
  assert.equal(counters.opens, 4, "the refused request opened no file");
  // HEAD and a 416 still work at the limit.
  assert.equal((await head(R.ok)).status, 200);
  assert.equal((await get(R.ok, { Range: `bytes=${SIZE}-` })).status, 416);
  // Another student is not affected.
  await signIn(CLASSMATE);
  const other = await get(R.otherClass);
  assert.equal(other.status, 200);
  await bytes(other);
  // Finishing one stream frees a slot.
  await signIn();
  assert.ok((await bytes(held[0])).equals(DATA));
  const next = await get(R.okPart2);
  assert.equal(next.status, 200);
  await held[1].body.cancel();
  await bytes(next);
});

test("limits: the process limit is 503 STREAMING_BUSY with Retry-After 5", async () => {
  slotsModule.resetStreamSlotsForTests(4, 2);
  await signIn();
  const a = await get(R.ok);
  const b = await get(R.okPart2);
  await signIn(CLASSMATE);
  const busy = await get(R.otherClass);
  await expectError(busy, 503, "STREAMING_BUSY");
  assert.equal(busy.headers.get("retry-after"), "5");
  // Refusals happen only after authorisation: an unauthorised request is still 404, not 503.
  assert.equal((await get(R.ok)).status, 404);
  await a.body.cancel();
  const after = await get(R.otherClass);
  assert.equal(after.status, 200);
  await bytes(after);
  await bytes(b);
});

test("limits: a client disconnect frees the slot", async () => {
  slotsModule.resetStreamSlotsForTests(1, 64);
  await signIn();
  const controller = new AbortController();
  const res = await get(R.ok, {}, { signal: controller.signal });
  const reader = res.body.getReader();
  await reader.read();
  assert.equal((await get(R.okPart2)).status, 429);
  controller.abort();
  assert.equal(slotsModule.getStreamSlots().inUse, 0);
  const next = await get(R.okPart2);
  assert.equal(next.status, 200);
  await bytes(next);
});

test("limits: an already-aborted request takes and immediately frees its slot", async () => {
  slotsModule.resetStreamSlotsForTests(1, 64);
  await signIn();
  const controller = new AbortController();
  controller.abort();
  const res = await get(R.ok, {}, { signal: controller.signal });
  assert.equal(slotsModule.getStreamSlots().inUse, 0);
  assert.equal((await bytes(res)).length, 0);
  const next = await get(R.ok);
  assert.equal(next.status, 200);
  await bytes(next);
});

// ---- Integrity, configuration, storage cache -----------------------------------------------------

test("integrity: a READY recording without its file is 500 RECORDING_FILE_UNAVAILABLE; logged with the id only; no slot", async () => {
  await signIn();
  const row = rowOf(R.ok);
  fs.rmSync(path.join(storageRoot, ...keys.recordingFileKey({ teacherId: row.teacherId, lectureId: row.lectureId, recordingId: row.id, storedName: STORED }).split("/")));
  for (const method of ["GET", "HEAD"]) {
    const res = await call(method, R.ok);
    await expectError(res, 500, "RECORDING_FILE_UNAVAILABLE");
  }
  assert.equal(slotsModule.getStreamSlots().inUse, 0);
  const logged = JSON.stringify(state.logs);
  assert.ok(logged.includes(R.ok), "the recording id is logged");
  assert.ok(logged.includes("NOT_FOUND"));
  assertNoLeak(logged, "log");
});

test("integrity: a file whose size differs from the database is 500, no bytes sent, no slot", async () => {
  await signIn();
  rowOf(R.ok).sizeBytes = BigInt(SIZE + 1);
  const res = await get(R.ok);
  await expectError(res, 500, "RECORDING_FILE_UNAVAILABLE");
  assert.equal(counters.opens, 0);
  assert.equal(slotsModule.getStreamSlots().inUse, 0);
  assert.ok(JSON.stringify(state.logs).includes("SIZE_MISMATCH"));
});

test("integrity: a symlink in place of the recording file is refused (500), never followed", async (t) => {
  await signIn();
  const row = rowOf(R.ok);
  const absolute = path.join(storageRoot, ...keys.recordingFileKey({ teacherId: row.teacherId, lectureId: row.lectureId, recordingId: row.id, storedName: STORED }).split("/"));
  const outside = path.join(os.tmpdir(), `rl43-outside-${process.pid}.bin`);
  fs.writeFileSync(outside, DATA);
  fs.rmSync(absolute);
  try {
    fs.symlinkSync(outside, absolute);
  } catch {
    fs.rmSync(outside, { force: true });
    t.skip("symlinks need extra rights on this platform");
    return;
  }
  try {
    await expectError(await get(R.ok), 500, "RECORDING_FILE_UNAVAILABLE");
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test("configuration: no storage root is 503 RECORDED_LECTURES_NOT_CONFIGURED (after authorisation)", async () => {
  await signIn();
  delete process.env.FILE_STORAGE_ROOT;
  await expectError(await get(R.ok), 503, "RECORDED_LECTURES_NOT_CONFIGURED");
  assert.equal((await get(id(999))).status, 404, "an unknown id is still 404");
  process.env.FILE_STORAGE_ROOT = storageRoot;
});

test("storage cache: opened once for many Range requests; a per-file NOT_FOUND never invalidates it", async () => {
  await signIn();
  for (let i = 0; i < 5; i += 1) await bytes(await get(R.ok, { Range: `bytes=${i * 10}-${i * 10 + 9}` }));
  assert.equal(counters.storageOpens, 1);
  const row = rowOf(R.okPart2);
  fs.rmSync(path.join(storageRoot, ...keys.recordingFileKey({ teacherId: row.teacherId, lectureId: row.lectureId, recordingId: row.id, storedName: STORED }).split("/")));
  assert.equal((await get(R.okPart2)).status, 500);
  await bytes(await get(R.ok, { Range: "bytes=0-9" }));
  assert.equal(counters.storageOpens, 1, "still the same cached handle");
});

test("storage cache: a ROOT_* error drops the cached handle and answers 503", async () => {
  await signIn();
  await bytes(await get(R.ok, { Range: "bytes=0-9" }));
  const original = proto.stat;
  proto.stat = async () => {
    const { StorageError } = require(path.join(root, "lib", "file-storage", "types.ts"));
    throw new StorageError("ROOT_MISSING");
  };
  try {
    await expectError(await get(R.ok), 503, "RECORDED_LECTURES_NOT_CONFIGURED");
  } finally {
    proto.stat = original;
  }
  await bytes(await get(R.ok, { Range: "bytes=0-9" }));
  assert.equal(counters.storageOpens, 2, "re-opened after the root error");
});

test("no response (body or header) on any path leaks storage, teacher or upload information", async () => {
  await signIn();
  const responses = [
    await get(R.ok), await get(R.ok, { Range: "bytes=0-9" }), await get(R.ok, { Range: `bytes=${SIZE}-` }), await head(R.ok),
    await get(R.removed), await get(id(999)), await head(R.otherTeacher),
  ];
  for (const res of responses) {
    assertNoLeak(headerText(res), `headers ${res.status}`);
    if (res.body && res.headers.get("content-type") !== "video/mp4") assertNoLeak(Buffer.from(await res.arrayBuffer()).toString("utf8"), `body ${res.status}`);
    else if (res.body) await bytes(res);
  }
});
