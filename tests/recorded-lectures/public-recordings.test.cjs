/*
 * Uploaded recorded lectures on the PUBLIC class pages (public teacher
 * profile integration), through the REAL code: the public service, the
 * public stream route, the teacher publication route, the existing student
 * and teacher stream routes (unchanged access), cached storage, stream slots
 * and LocalFileStorage on a temporary FILE_STORAGE_ROOT holding real files,
 * with an evaluating Prisma double (helpers/fake-public-db.cjs).
 *
 *   npm run test:recorded-lectures
 *
 * Rules checked:
 * - Privacy x viewing access: PRIVATE (Locked or Unlocked) is never public;
 *   PUBLIC + LOCKED is listed without a stream URL and never streams;
 *   PUBLIC + FREE ("Unlocked") is listed with the public stream URL and plays.
 * - Only active READY recordings with a file, of an active lecture and class,
 *   of a teacher whose public profile exists and is enabled.
 * - Every GET / HEAD (each Range request) is authorised again: a change takes
 *   effect on the next request. Every refusal is the same 404.
 * - Range / 206 / 416 / HEAD behave as for students; slots are released.
 * - Teacher publication: owner only (server-side), validated.
 * - Enrolled students and the teacher preview keep their access to every
 *   READY recording, private or locked.
 * - YouTube sessions on the public pages are unchanged by the merge.
 */

"use strict";

require("../helpers/no-class-access-restrictions.cjs"); // this suite does not model class fees (tests/class-access covers access control)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

process.env.JWT_SECRET = "public-recordings-test-secret-not-a-real-one-0123456789";

const root = path.resolve(__dirname, "..", "..");
require("../helpers/server-only.cjs");
require("tsx/cjs/api").register();

const { createFakePublicDb } = require("./helpers/fake-public-db.cjs");

function fakeAt(filename, exports) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
const fake = (relativePath, exports) => fakeAt(path.join(root, relativePath), exports);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-19T10:00:00.000Z");
const state = { cookie: null, fake: null };

fakeAt(require.resolve("next/headers", { paths: [root] }), {
  cookies: () => ({ get: (name) => (name === "teacher_session" && state.cookie ? { name, value: state.cookie } : undefined) }),
  headers: () => new Headers(),
});
fake("lib/prisma.ts", {
  get prisma() {
    return state.fake.prisma;
  },
});
fake("lib/server-clock.ts", {
  serverNow: async () => new Date(NOW),
  serverNowSync: () => new Date(NOW),
  resetServerClock() {},
});
fake("lib/error-logging/server-logger.ts", { logErrorEntry: () => null });
fake("lib/session-events.ts", { emitStudentDataChange: () => {} });

const { signAuthToken } = require(path.join(root, "lib", "auth.ts"));
const { LocalFileStorage } = require(path.join(root, "lib", "file-storage", "local-file-storage.ts"));
const keys = require(path.join(root, "lib", "recorded-lectures", "keys.ts"));
const slotsModule = require(path.join(root, "lib", "recorded-lectures", "stream-slots.ts"));
const publicSlotsModule = require(path.join(root, "lib", "recorded-lectures", "public-stream-slots.ts"));
const storageModule = require(path.join(root, "lib", "recorded-lectures", "storage.ts"));
const { buildTeacherRecordingDto } = require(path.join(root, "lib", "recorded-lectures", "teacher-dto.ts"));
const publicService = require(path.join(root, "services", "recorded-lecture-public-service.ts"));
const classService = require(path.join(root, "services", "class-service.ts"));
const publicRoute = require(path.join(root, "app", "api", "public", "recorded-lectures", "[recordingId]", "stream", "route.ts"));
const publicationRoute = require(path.join(root, "app", "api", "recorded-lectures", "[recordingId]", "publication", "route.ts"));
const studentRoute = require(path.join(root, "app", "api", "student", "recorded-lectures", "[recordingId]", "stream", "route.ts"));
const teacherPreviewRoute = require(path.join(root, "app", "api", "recorded-lectures", "[recordingId]", "stream", "route.ts"));

// ---- Data ------------------------------------------------------------------------------------------

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TEACHER_A = id(1); // public profile enabled
const TEACHER_B = id(2); // public profile disabled
const TEACHER_C = id(3); // no profile at all
const STUDENT = id(11); // enrolled in CLASS_A, approved
const CLASS_A = id(101);
const CLASS_A_INACTIVE = id(102);
const CLASS_B = id(103);
const CLASS_C = id(104);
const L_YOUTUBE = id(201); // CLASS_A, older, YouTube + one upload
const L_UPLOADS = id(202); // CLASS_A, newer, uploads only
const L_DELETED = id(203);
const L_INACTIVE = id(204);
const L_B = id(205);
const L_C = id(206);
const L_EMPTY = id(207); // CLASS_A, nothing public

const STORED = "0123456789abcdef0123456789abcdef.mp4";
const SIZE = 200_000;
const DATA = Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 17) % 251));

const R = {
  pubFree: id(501),
  pubLocked: id(502),
  privLocked: id(503),
  privFree: id(504),
  onYoutubeLecture: id(505),
  uploading: id(506),
  purgePending: id(507),
  removed: id(508),
  deletedLecture: id(509),
  inactiveClass: id(510),
  profileOff: id(511),
  noProfile: id(512),
  failed: id(513),
};

function recording(recId, lectureId, classId, teacherId, extra = {}) {
  return {
    id: recId,
    lectureId,
    classId,
    teacherId,
    title: `Recording ${recId.slice(-3)}`,
    partNumber: 1,
    displayFileName: "Teacher original name.mp4",
    mimeType: "video/mp4",
    sizeBytes: BigInt(SIZE),
    storedFileName: STORED,
    durationSeconds: 3725,
    width: 1280,
    height: 720,
    videoCodec: "avc1.64001F",
    audioCodec: "mp4a.40.2",
    fragmented: false,
    state: "READY",
    failureCode: null,
    visibility: "PUBLIC",
    access: "FREE",
    status: 0,
    deletedAt: null,
    deletedByTeacherId: null,
    purgeRequestedAt: null,
    purgedAt: null,
    createdAt: new Date(NOW - 2 * DAY),
    updatedAt: new Date(NOW - 2 * DAY),
    readyAt: new Date(NOW - DAY),
    failedAt: null,
    ...extra,
  };
}

const lecture = (lectureId, classId, createdDaysAgo, extra = {}) => ({
  id: lectureId,
  classId,
  title: `Lecture ${lectureId.slice(-3)}`,
  date: new Date(NOW - createdDaysAgo * DAY),
  endDate: null,
  createdAt: new Date(NOW - createdDaysAgo * DAY),
  classStatus: "COMPLETED",
  status: 0,
  ...extra,
});

const youtube = (ytId, lectureId, visibility, access, videoId, startedDaysAgo) => ({
  id: ytId,
  lectureId,
  videoId,
  youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
  visibility,
  access,
  startedAt: new Date(NOW - startedDaysAgo * DAY),
  endedAt: new Date(NOW - startedDaysAgo * DAY + 3_600_000),
});

function seed() {
  state.fake = createFakePublicDb();
  const { db } = state.fake;
  db.teachers.push({ id: TEACHER_A }, { id: TEACHER_B }, { id: TEACHER_C });
  db.profiles.push({ id: id(901), teacherId: TEACHER_A, slug: "teacher-a", isPublic: true }, { id: id(902), teacherId: TEACHER_B, slug: "teacher-b", isPublic: false });
  db.students.push({ id: STUDENT, status: 0, sessionVersion: 0, confirmationStatus: "APPROVED", teacherId: TEACHER_A });
  db.classes.push(
    { id: CLASS_A, teacherId: TEACHER_A, status: 0, name: "Grade 10 Maths", schedule: "TBD" },
    { id: CLASS_A_INACTIVE, teacherId: TEACHER_A, status: 1, name: "Old class", schedule: "TBD" },
    { id: CLASS_B, teacherId: TEACHER_B, status: 0, name: "Profile off", schedule: "TBD" },
    { id: CLASS_C, teacherId: TEACHER_C, status: 0, name: "No profile", schedule: "TBD" }
  );
  db.classStudents.push({ id: id(301), classId: CLASS_A, studentId: STUDENT, isActive: true });
  db.lectures.push(
    lecture(L_YOUTUBE, CLASS_A, 5),
    lecture(L_UPLOADS, CLASS_A, 1),
    lecture(L_DELETED, CLASS_A, 2, { status: 1 }),
    lecture(L_INACTIVE, CLASS_A_INACTIVE, 3),
    lecture(L_B, CLASS_B, 3),
    lecture(L_C, CLASS_C, 3),
    lecture(L_EMPTY, CLASS_A, 4)
  );
  db.youtubeRecordings.push(
    youtube(id(601), L_YOUTUBE, "PUBLIC", "FREE", "ytFreePublic01", 5),
    youtube(id(602), L_YOUTUBE, "PUBLIC", "LOCKED", "ytLockedPublic2", 4),
    youtube(id(603), L_YOUTUBE, "PRIVATE", "FREE", "ytPrivate000003", 3)
  );
  db.recordings.push(
    recording(R.pubFree, L_UPLOADS, CLASS_A, TEACHER_A, { partNumber: 1 }),
    recording(R.pubLocked, L_UPLOADS, CLASS_A, TEACHER_A, { partNumber: 2, access: "LOCKED" }),
    recording(R.privLocked, L_UPLOADS, CLASS_A, TEACHER_A, { partNumber: 3, visibility: "PRIVATE", access: "LOCKED" }),
    recording(R.privFree, L_UPLOADS, CLASS_A, TEACHER_A, { partNumber: 4, visibility: "PRIVATE", access: "FREE" }),
    recording(R.onYoutubeLecture, L_YOUTUBE, CLASS_A, TEACHER_A, { partNumber: 1, durationSeconds: 1800 }),
    recording(R.uploading, L_UPLOADS, CLASS_A, TEACHER_A, { partNumber: 5, state: "UPLOADING", storedFileName: null, readyAt: null }),
    recording(R.purgePending, L_UPLOADS, CLASS_A, TEACHER_A, { partNumber: 6, status: 2 }),
    recording(R.removed, L_UPLOADS, CLASS_A, TEACHER_A, { partNumber: 7, status: 1 }),
    recording(R.failed, L_UPLOADS, CLASS_A, TEACHER_A, { partNumber: 8, state: "FAILED", failureCode: "MP4_INVALID", readyAt: null }),
    recording(R.deletedLecture, L_DELETED, CLASS_A, TEACHER_A),
    recording(R.inactiveClass, L_INACTIVE, CLASS_A_INACTIVE, TEACHER_A),
    recording(R.profileOff, L_B, CLASS_B, TEACHER_B),
    recording(R.noProfile, L_C, CLASS_C, TEACHER_C)
  );
}

const rowOf = (recId) => state.fake.db.recordings.find((r) => r.id === recId);
const snapshotRows = () => JSON.stringify(state.fake.db.recordings, (_key, value) => (typeof value === "bigint" ? `${value}n` : value));
const profileOf = (teacherId) => state.fake.db.profiles.find((p) => p.teacherId === teacherId);

async function signInStudent() {
  state.cookie = await signAuthToken({ sub: STUDENT, email: "s@example.com", name: "Student", role: "STUDENT", sessionVersion: 0 });
}
async function signInTeacher(teacherId = TEACHER_A) {
  state.cookie = await signAuthToken({ sub: teacherId, email: "t@example.com", name: "Teacher", role: "TEACHER" });
}

// ---- Storage, slots and env --------------------------------------------------------------------------

let storageRoot = null;
const savedRoot = process.env.FILE_STORAGE_ROOT;
const savedProxy = process.env.TRUSTED_PROXY_COUNT;
const openBodies = [];
const counters = { opens: 0 };
const proto = LocalFileStorage.prototype;
const originalOpenRead = proto.openRead;
proto.openRead = function countedOpenRead(...args) {
  counters.opens += 1;
  return originalOpenRead.apply(this, args);
};

async function writeRecordingFile(row) {
  const storage = await LocalFileStorage.open({ root: storageRoot });
  const key = keys.recordingFileKey({ teacherId: row.teacherId, lectureId: row.lectureId, recordingId: row.id, storedName: STORED });
  await storage.writeNewFile(key, (async function* () { yield new Uint8Array(DATA); })(), { maxBytes: SIZE });
}

test.beforeEach(async () => {
  seed();
  state.cookie = null;
  delete process.env.TRUSTED_PROXY_COUNT;
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rl-public-"));
  process.env.FILE_STORAGE_ROOT = storageRoot;
  storageModule.resetRecordedLectureStorageCacheForTests();
  slotsModule.resetStreamSlotsForTests();
  publicSlotsModule.resetPublicStreamSlotsForTests();
  // Every recording with a stored name has a real file, so a 404 is never "no file".
  for (const row of state.fake.db.recordings) if (row.storedFileName) await writeRecordingFile(row);
  counters.opens = 0;
});

test.afterEach(async () => {
  for (const body of openBodies.splice(0)) await body.cancel().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(slotsModule.getStreamSlots().inUse, 0, "every shared slot released after the test");
  assert.equal(publicSlotsModule.getPublicStreamSlots().inUse, 0, "every public slot released after the test");
  storageModule.resetRecordedLectureStorageCacheForTests();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

test.after(() => {
  proto.openRead = originalOpenRead;
  if (savedRoot === undefined) delete process.env.FILE_STORAGE_ROOT;
  else process.env.FILE_STORAGE_ROOT = savedRoot;
  if (savedProxy === undefined) delete process.env.TRUSTED_PROXY_COUNT;
  else process.env.TRUSTED_PROXY_COUNT = savedProxy;
});

// ---- Calling routes -----------------------------------------------------------------------------------

async function callStream(route, base, method, recordingId, headers = {}) {
  const request = new Request(`http://localhost${base}/${recordingId}/stream`, { method, headers });
  const response = await route[method](request, { params: { recordingId } });
  if (response.body) openBodies.push(response.body);
  return response;
}
const pub = (method, recordingId, headers) => callStream(publicRoute, "/api/public/recorded-lectures", method, recordingId, headers);
const studentStream = (recordingId, headers) => callStream(studentRoute, "/api/student/recorded-lectures", "GET", recordingId, headers);
const teacherStream = (recordingId, headers) => callStream(teacherPreviewRoute, "/api/recorded-lectures", "GET", recordingId, headers);

async function bytes(response) {
  return Buffer.from(await response.arrayBuffer());
}
async function json(response) {
  return JSON.parse(Buffer.from(await response.arrayBuffer()).toString("utf8"));
}

async function putPublication(recordingId, body, contentType = "application/json") {
  const request = new Request(`http://localhost/api/recorded-lectures/${recordingId}/publication`, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const response = await publicationRoute.PUT(request, { params: { recordingId } });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null, headers: response.headers };
}

const SECRETS = () => [STORED, "0123456789abcdef", "Teacher original name", TEACHER_A, storageRoot, path.basename(storageRoot), "Teachers/", "RecordedLectures/", "TemporaryUploads"];
function assertNoLeak(text, where) {
  for (const secret of SECRETS()) assert.ok(!text.includes(secret), `${where}: ${secret}`);
}

const PRIVATE_OR_HIDDEN = [R.privLocked, R.privFree, R.uploading, R.purgePending, R.removed, R.failed, R.deletedLecture, R.inactiveClass, R.profileOff, R.noProfile];

// ---- Listing ------------------------------------------------------------------------------------------

test("listing: uploads merge into their course sessions; Unlocked carries the public stream URL, Locked none; nothing private or internal", async () => {
  const sessions = await publicService.getPublicClassSessionsWithUploads(CLASS_A);
  const payload = JSON.stringify(sessions);

  assert.deepEqual(sessions.map((s) => s.id), [L_UPLOADS, L_YOUTUBE], "newest lecture first; an uploads-only lecture becomes a session");

  const [uploadsOnly, withYoutube] = sessions;
  assert.deepEqual(uploadsOnly.recordings, [], "no YouTube recordings on the uploads-only lecture");
  assert.deepEqual(uploadsOnly.uploads, [
    { source: "UPLOAD", id: R.pubFree, title: "Recording 501", partNumber: 1, durationSeconds: 3725, access: "FREE", streamUrl: `/api/public/recorded-lectures/${R.pubFree}/stream` },
    { source: "UPLOAD", id: R.pubLocked, title: "Recording 502", partNumber: 2, durationSeconds: 3725, access: "LOCKED", streamUrl: null },
  ]);
  assert.equal(uploadsOnly.title, `Lecture ${L_UPLOADS.slice(-3)}`);

  assert.deepEqual(withYoutube.uploads.map((u) => [u.id, u.access]), [[R.onYoutubeLecture, "FREE"]]);

  for (const hidden of PRIVATE_OR_HIDDEN) assert.ok(!payload.includes(hidden), `not listed: ${hidden}`);
  assertNoLeak(payload, "listing");
  assert.ok(!payload.includes(`${R.pubLocked}/stream`), "no stream URL for the Locked recording");
});

test("listing: YouTube sessions are exactly getPublicClassSessions' (same objects and order) plus `uploads`", async () => {
  const youtubeOnly = await classService.getPublicClassSessions(CLASS_A);
  const merged = await publicService.getPublicClassSessionsWithUploads(CLASS_A);
  const mergedYoutube = merged.find((s) => s.id === L_YOUTUBE);
  const { uploads, ...rest } = mergedYoutube;
  assert.ok(uploads.length === 1);
  assert.deepEqual(rest, youtubeOnly.find((s) => s.id === L_YOUTUBE), "YouTube part of the session unchanged");
  assert.deepEqual(rest.recordings.map((r) => [r.access, r.videoId]), [["FREE", "ytFreePublic01"], ["LOCKED", null]], "YouTube rules unchanged");

  // No uploads at all: the YouTube list itself is returned, untouched.
  for (const row of state.fake.db.recordings) row.visibility = "PRIVATE";
  const none = await publicService.getPublicClassSessionsWithUploads(CLASS_A);
  assert.deepEqual(none, await classService.getPublicClassSessions(CLASS_A));
  assert.ok(none.every((s) => !("uploads" in s)), "no `uploads` key without uploads");
});

test("listing: a disabled or missing public profile hides uploads (YouTube rules are left as they are)", async () => {
  assert.deepEqual(await publicService.getPublicClassSessionsWithUploads(CLASS_B), []);
  assert.deepEqual(await publicService.getPublicClassSessionsWithUploads(CLASS_C), []);

  profileOf(TEACHER_A).isPublic = false;
  const sessions = await publicService.getPublicClassSessionsWithUploads(CLASS_A);
  assert.ok(sessions.every((s) => !s.uploads), "no uploads while the profile is disabled");
  assert.deepEqual(sessions, await classService.getPublicClassSessions(CLASS_A), "YouTube behaviour unchanged");
});

test("listing: deny by default for an unexpected access value (no stream URL)", () => {
  const listed = publicService.toPublicUploadedRecording({ id: R.pubFree, title: "x", partNumber: 1, durationSeconds: null, access: "SOMETHING" });
  assert.equal(listed.access, "LOCKED");
  assert.equal(listed.streamUrl, null);
});

// ---- Privacy x viewing access matrix ---------------------------------------------------------------------

test("matrix: Private+Locked, Private+Unlocked hidden; Public+Locked listed but never plays; Public+Unlocked plays", async () => {
  const cases = [
    ["PRIVATE", "LOCKED", { listed: false, playable: false }],
    ["PRIVATE", "FREE", { listed: false, playable: false }],
    ["PUBLIC", "LOCKED", { listed: true, playable: false }],
    ["PUBLIC", "FREE", { listed: true, playable: true }],
  ];
  for (const [visibility, access, expected] of cases) {
    Object.assign(rowOf(R.pubFree), { visibility, access });
    const sessions = await publicService.getPublicClassSessionsWithUploads(CLASS_A);
    const listed = sessions.flatMap((s) => s.uploads ?? []).find((u) => u.id === R.pubFree);
    const label = `${visibility} + ${access}`;
    assert.equal(Boolean(listed), expected.listed, `${label}: listed`);
    if (listed) assert.equal(listed.streamUrl !== null, expected.playable, `${label}: stream URL`);
    const res = await pub("GET", R.pubFree, { Range: "bytes=0-9" });
    assert.equal(res.status, expected.playable ? 206 : 404, `${label}: stream`);
    await res.arrayBuffer();
  }
});

// ---- Public playback -----------------------------------------------------------------------------------

function assertPlaybackHeaders(res) {
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(res.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-disposition"), 'inline; filename="recording.mp4"');
  for (const absent of ["etag", "last-modified", "set-cookie"]) assert.equal(res.headers.get(absent), null, absent);
  assertNoLeak(JSON.stringify([...res.headers.entries()]), "headers");
}

test("playback: no session needed; 200 whole file, 206 ranges (seeking), 416, If-Range ignored", async () => {
  const whole = await pub("GET", R.pubFree);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-length"), String(SIZE));
  assertPlaybackHeaders(whole);
  assert.ok((await bytes(whole)).equals(DATA));

  // A player seeking around: every Range request is answered (and authorised) on its own.
  for (const [range, start, end] of [["bytes=0-1023", 0, 1023], ["bytes=150000-", 150000, SIZE - 1], ["bytes=-500", SIZE - 500, SIZE - 1], ["bytes=90000-90099", 90000, 90099]]) {
    const res = await pub("GET", R.pubFree, { Range: range });
    assert.equal(res.status, 206, range);
    assert.equal(res.headers.get("content-range"), `bytes ${start}-${end}/${SIZE}`);
    assertPlaybackHeaders(res);
    assert.ok((await bytes(res)).equals(DATA.subarray(start, end + 1)), range);
  }

  const unsatisfiable = await pub("GET", R.pubFree, { Range: `bytes=${SIZE}-` });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${SIZE}`);
  assert.equal((await bytes(unsatisfiable)).length, 0);

  const ifRange = await pub("GET", R.pubFree, { Range: "bytes=0-9", "If-Range": '"x"' });
  assert.equal(ifRange.status, 200);
  await ifRange.arrayBuffer();
});

test("playback: HEAD answers like GET without a body, never opens the file or takes a slot", async () => {
  const res = await pub("HEAD", R.pubFree, { Range: "bytes=0-99" });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-length"), "100");
  assert.equal(res.body, null);
  assert.equal(counters.opens, 0);
  assert.equal(publicSlotsModule.getPublicStreamSlots().inUse, 0);

  const locked = await pub("HEAD", R.pubLocked);
  assert.equal(locked.status, 404);
  assert.equal(locked.body, null);
});

test("playback: every refusal is the same 404 (missing, malformed, private, locked, not ready, deleted, inactive, profile off / missing)", async () => {
  const reference = await pub("GET", id(999));
  assert.equal(reference.status, 404);
  const referenceBody = await json(reference);
  assert.equal(referenceBody.error.code, "RECORDED_LECTURE_NOT_FOUND");

  for (const recId of [...PRIVATE_OR_HIDDEN, R.pubLocked, "not-a-uuid", "../../etc/passwd"]) {
    const res = await pub("GET", recId, { Range: "bytes=0-9" });
    assert.equal(res.status, 404, recId);
    assert.equal(res.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.deepEqual(await json(res), referenceBody, `identical body for ${recId}`);
  }
  assert.equal(counters.opens, 0, "no refused request opened a file");
});

test("playback: a change takes effect on the very next Range request (access, privacy, profile, deletion)", async () => {
  const changes = [
    () => (rowOf(R.pubFree).access = "LOCKED"),
    () => (rowOf(R.pubFree).visibility = "PRIVATE"),
    () => (profileOf(TEACHER_A).isPublic = false),
    () => Object.assign(rowOf(R.pubFree), { status: 2, deletedAt: new Date(NOW), purgeRequestedAt: new Date(NOW) }),
  ];
  for (const change of changes) {
    seed();
    const first = await pub("GET", R.pubFree, { Range: "bytes=0-9" });
    assert.equal(first.status, 206);
    await first.arrayBuffer();
    change();
    const next = await pub("GET", R.pubFree, { Range: "bytes=10-19" });
    assert.equal(next.status, 404, String(change));
    await next.arrayBuffer();
  }
});

test("playback slots: per client (trusted proxy) and per process, released afterwards; enrolled students keep streaming", async () => {
  process.env.TRUSTED_PROXY_COUNT = "1";
  const client = { "X-Forwarded-For": "203.0.113.7", Range: "bytes=0-9" };
  const held = [];
  for (let i = 0; i < publicSlotsModule.MAX_PUBLIC_STREAMS_PER_CLIENT; i += 1) {
    const res = await pub("GET", R.pubFree, client);
    assert.equal(res.status, 206);
    held.push(res);
  }
  const refused = await pub("GET", R.pubFree, client);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), "5");
  assert.equal((await json(refused)).error.code, "STREAM_LIMIT_REACHED");

  // Another client is still served; a student is unaffected by the public limits.
  const other = await pub("GET", R.pubFree, { "X-Forwarded-For": "198.51.100.2", Range: "bytes=0-9" });
  assert.equal(other.status, 206);
  held.push(other);
  await signInStudent();
  const student = await studentStream(R.pubFree, { Range: "bytes=0-9" });
  assert.equal(student.status, 206);
  held.push(student);

  for (const res of held) await res.arrayBuffer();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(publicSlotsModule.getPublicStreamSlots().inUse, 0);
  assert.equal(slotsModule.getStreamSlots().inUse, 0);

  // Per-process public limit (no trusted proxy: only this limit applies).
  delete process.env.TRUSTED_PROXY_COUNT;
  publicSlotsModule.resetPublicStreamSlotsForTests(4, 2);
  const a = await pub("GET", R.pubFree, { Range: "bytes=0-9" });
  const b = await pub("GET", R.pubFree, { Range: "bytes=0-9" });
  assert.deepEqual([a.status, b.status], [206, 206]);
  const busy = await pub("GET", R.pubFree, { Range: "bytes=0-9" });
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("retry-after"), "5");
  assert.equal((await json(busy)).error.code, "STREAMING_BUSY");
  assert.equal(slotsModule.getStreamSlots().inUse, 2, "a refused public request holds no shared slot");
  await a.arrayBuffer();
  await b.arrayBuffer();
});

// ---- Existing access preserved ---------------------------------------------------------------------------

test("enrolled students and the teacher preview still play PRIVATE and LOCKED recordings (unchanged rules)", async () => {
  await signInStudent();
  for (const recId of [R.privLocked, R.privFree, R.pubLocked, R.pubFree]) {
    const res = await studentStream(recId, { Range: "bytes=0-9" });
    assert.equal(res.status, 206, `student ${recId}`);
    await res.arrayBuffer();
  }
  // The student filter does not depend on the public profile either.
  profileOf(TEACHER_A).isPublic = false;
  const res = await studentStream(R.privLocked, { Range: "bytes=0-9" });
  assert.equal(res.status, 206);
  await res.arrayBuffer();

  await signInTeacher();
  const preview = await teacherStream(R.privLocked, { Range: "bytes=0-9" });
  assert.equal(preview.status, 206);
  await preview.arrayBuffer();
});

test("signing in does not unlock the public endpoint: a student's session gives no public access to a Locked recording", async () => {
  await signInStudent();
  const res = await pub("GET", R.pubLocked, { Range: "bytes=0-9" });
  assert.equal(res.status, 404);
  await res.arrayBuffer();
});

// ---- Teacher publication settings ------------------------------------------------------------------------

test("publication: the owner changes privacy and viewing access; the public page follows", async () => {
  await signInTeacher();
  const made = await putPublication(R.privLocked, { visibility: "PUBLIC" });
  assert.equal(made.status, 200);
  assert.deepEqual(made.body.data.recording, { id: R.privLocked, visibility: "PUBLIC", access: "LOCKED" });
  assert.equal(made.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(rowOf(R.privLocked).visibility, "PUBLIC");
  assert.equal(rowOf(R.privLocked).updatedAt.getTime(), NOW);

  const unlocked = await putPublication(R.privLocked, { access: "FREE" });
  assert.deepEqual(unlocked.body.data.recording, { id: R.privLocked, visibility: "PUBLIC", access: "FREE" });
  const res = await pub("GET", R.privLocked, { Range: "bytes=0-9" });
  assert.equal(res.status, 206);
  await res.arrayBuffer();

  const both = await putPublication(R.privLocked, { visibility: "PRIVATE", access: "LOCKED" });
  assert.deepEqual(both.body.data.recording, { id: R.privLocked, visibility: "PRIVATE", access: "LOCKED" });
  assertNoLeak(both.text, "publication response");
});

test("publication: ownership is checked on the server (other teacher, student, no session, deleted, missing)", async () => {
  const before = snapshotRows();

  state.cookie = null;
  assert.equal((await putPublication(R.privLocked, { visibility: "PUBLIC" })).status, 401);
  await signInStudent();
  assert.equal((await putPublication(R.privLocked, { visibility: "PUBLIC" })).status, 401);

  await signInTeacher(TEACHER_B);
  const other = await putPublication(R.privLocked, { visibility: "PUBLIC" });
  assert.equal(other.status, 404);

  await signInTeacher();
  for (const recId of [R.purgePending, R.removed, R.deletedLecture, id(999), "not-a-uuid"]) {
    const res = await putPublication(recId, { visibility: "PUBLIC" });
    assert.equal(res.status, 404, recId);
    assert.equal(res.body.error.message, "Recording not found.");
  }
  assert.equal(snapshotRows(), before, "nothing changed");
});

test("publication: validation (values, unknown fields, empty, JSON only)", async () => {
  await signInTeacher();
  const before = snapshotRows();
  for (const body of [{}, { visibility: "public" }, { access: "UNLOCKED" }, { visibility: "PUBLIC", status: 0 }, { visibility: null }, [], "null"]) {
    const res = await putPublication(R.privLocked, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await putPublication(R.privLocked, "visibility=PUBLIC", "text/plain")).status, 415);
  assert.equal(snapshotRows(), before, "nothing changed");
});

// ---- Teacher DTO ---------------------------------------------------------------------------------------------

test("teacher DTO: carries the settings; a row without them (older data, fakes) shows the safe defaults", () => {
  const base = {
    id: R.pubFree, lectureId: L_UPLOADS, title: "t", partNumber: 1, displayFileName: "a.mp4", sizeBytes: BigInt(10),
    durationSeconds: 10, width: null, height: null, state: "READY", failureCode: null, createdAt: new Date(NOW), readyAt: new Date(NOW), failedAt: null, uploadSession: null,
  };
  const set = buildTeacherRecordingDto({ ...base, visibility: "PUBLIC", access: "FREE" });
  assert.equal(set.visibility, "PUBLIC");
  assert.equal(set.access, "FREE");
  const missing = buildTeacherRecordingDto(base);
  assert.equal(missing.visibility, "PRIVATE");
  assert.equal(missing.access, "LOCKED");
});
