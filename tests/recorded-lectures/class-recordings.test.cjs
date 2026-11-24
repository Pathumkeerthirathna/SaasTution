/*
 * Recorded Lectures redesign, Stage 1 (backend): teacher General Recordings on
 * the class's default lecture (services/class-recordings-service.ts):
 *   GET  /api/classes/[id]/recorded-lectures[?lectureId=]
 *   POST /api/classes/[id]/recorded-lectures/uploads[?lectureId=]
 * and the recorded-lecture paths that accept the default lecture for an
 * EXISTING recording (chunks, completion, list, edit, preview, delete), the
 * publication refusal, and the lecture-scoped routes that keep refusing it.
 *
 *   npm run test:recorded-lectures
 *
 * The real routes, services, upload protocol, verification and local storage
 * run (helpers/upload-harness.cjs: the in-memory upload database, a temporary
 * FILE_STORAGE_ROOT, the server clock). No database.
 */

"use strict";

const H = require("./helpers/upload-harness.cjs");

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { state, ids, completion } = H;
const { OWNER, OTHER, CLASS, CLASS_OTHER, LECTURE, LECTURE_OTHER, id } = ids;
const root = path.resolve(__dirname, "..", "..");

const APP_ORIGIN = "https://app.example.test";
process.env.APP_URL = APP_ORIGIN;

const DEFAULT = id(290); // CLASS's default lecture
const DEFAULT_OTHER = id(291); // CLASS_OTHER's default lecture
const CLASS_NO_DEFAULT = id(103);

const routes = {
  classList: require(path.join(root, "app", "api", "classes", "[id]", "recorded-lectures", "route.ts")),
  classStart: require(path.join(root, "app", "api", "classes", "[id]", "recorded-lectures", "uploads", "route.ts")),
  lectureList: require(path.join(root, "app", "api", "lectures", "[id]", "recorded-lectures", "route.ts")),
  lectureStart: require(path.join(root, "app", "api", "lectures", "[id]", "recorded-lectures", "uploads", "route.ts")),
  recording: require(path.join(root, "app", "api", "recorded-lectures", "[recordingId]", "route.ts")),
  preview: require(path.join(root, "app", "api", "recorded-lectures", "[recordingId]", "stream", "route.ts")),
  publication: require(path.join(root, "app", "api", "recorded-lectures", "[recordingId]", "publication", "route.ts")),
};

H.install(test);
test.beforeEach(() => {
  const { db } = state.fakeDb;
  db.classes.push({ id: CLASS_NO_DEFAULT, teacherId: OWNER, status: 0, name: "No default yet" });
  db.lectures.push(
    { id: DEFAULT, classId: CLASS, status: 0, title: "General Notes", date: new Date("2026-01-05T00:00:00.000Z"), endDate: null, isDefault: true },
    { id: DEFAULT_OTHER, classId: CLASS_OTHER, status: 0, title: "General Notes", date: new Date("2026-01-05T00:00:00.000Z"), endDate: null, isDefault: true }
  );
});

const body = (sizeBytes, part = 1, extra = {}) => JSON.stringify({ title: `General ${part}`, partNumber: part, fileName: "general.mp4", mimeType: "video/mp4", sizeBytes, ...extra });

async function json(response) {
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function classStart(classId, sizeBytes, { query = "", headers = { origin: APP_ORIGIN }, part = 1, extra } = {}) {
  const request = new Request(`${APP_ORIGIN}/api/classes/${classId}/recorded-lectures/uploads${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body(sizeBytes, part, extra),
  });
  return json(await routes.classStart.POST(request, { params: { id: classId } }));
}

async function classList(classId, query = "") {
  return json(await routes.classList.GET(new Request(`${APP_ORIGIN}/api/classes/${classId}/recorded-lectures${query}`), { params: { id: classId } }));
}

/** A General Recording, uploaded completely and verified to READY. */
async function readyGeneralRecording(part = 1) {
  const file = H.validMp4(64 * 1024);
  const started = await classStart(CLASS, file.length, { part });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { uploadId, recordingId } = started.body.data;
  for (let offset = 0; offset < file.length; offset += 1024 * 1024) {
    const piece = file.subarray(offset, Math.min(file.length, offset + 1024 * 1024));
    const put = await H.putChunk(uploadId, offset, piece);
    assert.equal(put.status, 200, JSON.stringify(put.body));
  }
  assert.equal((await H.complete(uploadId)).status, 202);
  await completion.waitForCompletionJobs();
  const row = state.fakeDb.db.recordings.find((r) => r.id === recordingId);
  assert.equal(row.state, "READY", "verified through the existing pipeline");
  return row;
}

// ---- Upload start -----------------------------------------------------------------------------------

test("General upload start: the class's default lecture, resolved on the server; the existing upload lifecycle to READY", async () => {
  await H.signInAs(OWNER);
  const row = await readyGeneralRecording();
  assert.equal(row.lectureId, DEFAULT);
  assert.equal(row.classId, CLASS);
  assert.equal(row.teacherId, OWNER);
  assert.ok(row.storedFileName, "stored and published");
  assert.notEqual(row.visibility, "PUBLIC", "never public (the upload never sets publication)");
});

test("General upload start: a lectureId / classId in the body is ignored; ?lectureId= picks a NORMAL lecture of the class only", async () => {
  await H.signInAs(OWNER);
  const ignored = await classStart(CLASS, 1000, { extra: { lectureId: LECTURE, classId: CLASS_OTHER } });
  assert.equal(ignored.status, 201);
  assert.equal(state.fakeDb.db.recordings.find((r) => r.id === ignored.body.data.recordingId).lectureId, DEFAULT);

  const normal = await classStart(CLASS, 1000, { query: `?lectureId=${LECTURE}`, part: 2 });
  assert.equal(normal.status, 201);
  assert.equal(state.fakeDb.db.recordings.find((r) => r.id === normal.body.data.recordingId).lectureId, LECTURE);

  for (const lectureId of [DEFAULT, LECTURE_OTHER, DEFAULT_OTHER]) {
    const refused = await classStart(CLASS, 1000, { query: `?lectureId=${lectureId}`, part: 3 });
    assert.deepEqual([refused.status, refused.body.error.code], [404, "LECTURE_NOT_FOUND"], lectureId);
  }
});

test("General upload start: same-origin first (403, nothing read); another teacher's class 404; no default lecture 409; no session 401", async () => {
  await H.signInAs(OWNER);
  for (const headers of [{}, { origin: "https://evil.example" }, { origin: APP_ORIGIN, "sec-fetch-site": "cross-site" }]) {
    const refused = await classStart(CLASS, 1000, { headers });
    assert.deepEqual([refused.status, refused.body.error.code], [403, "CROSS_ORIGIN_REQUEST_REJECTED"]);
  }
  assert.equal(state.fakeDb.db.recordings.length, 0);

  const other = await classStart(CLASS_OTHER, 1000);
  assert.deepEqual([other.status, other.body.error.code], [404, "CLASS_NOT_FOUND"]);
  const missing = await classStart(CLASS_NO_DEFAULT, 1000);
  assert.deepEqual([missing.status, missing.body.error.code], [409, "DEFAULT_LECTURE_MISSING"]);
  assert.equal(state.fakeDb.db.lectures.filter((l) => l.classId === CLASS_NO_DEFAULT).length, 0, "no default lecture is created");
  state.cookie = null;
  assert.equal((await classStart(CLASS, 1000)).status, 401);
  assert.equal(state.fakeDb.db.recordings.length, 0);
});

test("General upload start keeps the existing validation and quota rules (an invalid declaration is 400, nothing created)", async () => {
  await H.signInAs(OWNER);
  const bad = await classStart(CLASS, 1000, { extra: { mimeType: "video/webm" } });
  assert.equal(bad.status, 400);
  assert.equal(state.fakeDb.db.recordings.length, 0);
});

test("the lecture-scoped routes still refuse the default lecture (a client-supplied default lecture id is never enough)", async () => {
  await H.signInAs(OWNER);
  const start = await json(
    await routes.lectureStart.POST(
      new Request(`${APP_ORIGIN}/api/lectures/${DEFAULT}/recorded-lectures/uploads`, { method: "POST", headers: { "content-type": "application/json" }, body: body(1000) }),
      { params: { id: DEFAULT } }
    )
  );
  assert.deepEqual([start.status, start.body.error.code], [404, "LECTURE_NOT_FOUND"]);
  const list = await json(await routes.lectureList.GET(new Request(`${APP_ORIGIN}/api/lectures/${DEFAULT}/recorded-lectures`), { params: { id: DEFAULT } }));
  assert.equal(list.status, 404);
});

// ---- Listing ------------------------------------------------------------------------------------------

test("class list: General Recordings by default (section GENERAL), lecture recordings with ?lectureId=; ownership and class checks", async () => {
  await H.signInAs(OWNER);
  await readyGeneralRecording(1);
  await classStart(CLASS, 1000, { query: `?lectureId=${LECTURE}` });

  const general = await classList(CLASS);
  assert.equal(general.status, 200);
  assert.equal(general.body.data.section, "GENERAL");
  assert.deepEqual(general.body.data.lecture, { id: DEFAULT, title: "General Notes", date: "2026-01-05T00:00:00.000Z", isDefault: true });
  assert.deepEqual(general.body.data.class, { id: CLASS, name: "Grade 10" });
  assert.equal(general.body.data.recordings.length, 1);
  assert.equal(general.body.data.recordings[0].state, "READY");
  assert.equal(general.body.data.nextPartNumber, 2);
  assert.ok(general.body.data.limits.chunkBytes > 0);

  const lecture = await classList(CLASS, `?lectureId=${LECTURE}`);
  assert.equal(lecture.body.data.section, "LECTURE");
  assert.equal(lecture.body.data.recordings.length, 1);
  assert.equal(lecture.body.data.lecture.isDefault, false);

  for (const lectureId of [DEFAULT, LECTURE_OTHER]) {
    assert.deepEqual([(await classList(CLASS, `?lectureId=${lectureId}`)).status], [404], lectureId);
  }
  assert.equal((await classList(CLASS, "?lectureId=../x")).status, 400);
  await H.signInAs(OTHER);
  assert.deepEqual([(await classList(CLASS)).status, (await classList(CLASS)).body.error.code], [404, "CLASS_NOT_FOUND"]);
  await H.signInAs(OWNER);
  assert.deepEqual([(await classList(CLASS_NO_DEFAULT)).status, (await classList(CLASS_NO_DEFAULT)).body.error.code], [409, "DEFAULT_LECTURE_MISSING"]);
});

// ---- Edit, preview, publication, delete ---------------------------------------------------------------

test("a General Recording is edited, previewed (Range) and deleted permanently by its teacher; another teacher gets 404 everywhere", async () => {
  await H.signInAs(OWNER);
  const row = await readyGeneralRecording(1);
  const at = (method, extra = {}) => new Request(`${APP_ORIGIN}/api/recorded-lectures/${row.id}`, { method, ...extra });

  const edited = await json(await routes.recording.PATCH(at("PATCH", { headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Course overview" }) }), { params: { recordingId: row.id } }));
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(state.fakeDb.db.recordings.find((r) => r.id === row.id).title, "Course overview");

  const preview = await routes.preview.GET(new Request(`${APP_ORIGIN}/api/recorded-lectures/${row.id}/stream`, { headers: { range: "bytes=0-99" } }), { params: { recordingId: row.id } });
  assert.equal(preview.status, 206);
  assert.equal((await preview.arrayBuffer()).byteLength, 100);

  await H.signInAs(OTHER);
  assert.equal((await routes.recording.PATCH(at("PATCH", { headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x y" }) }), { params: { recordingId: row.id } })).status, 404);
  assert.equal((await routes.preview.GET(new Request(`${APP_ORIGIN}/api/recorded-lectures/${row.id}/stream`), { params: { recordingId: row.id } })).status, 404);
  assert.equal((await routes.recording.DELETE(at("DELETE"), { params: { recordingId: row.id } })).status, 404);

  await H.signInAs(OWNER);
  const deleted = await json(await routes.recording.DELETE(at("DELETE"), { params: { recordingId: row.id } }));
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(state.fakeDb.db.recordings.find((r) => r.id === row.id).status, 1, "the existing permanent deletion: purged");
});

// (A normal lecture's recording is still published as before: tests/recorded-lectures/public-recordings.test.cjs.)
test("publication: a General Recording cannot be made public (409, refused before any change); another teacher still gets 404", async () => {
  await H.signInAs(OWNER);
  const general = await readyGeneralRecording(1);
  const put = (recordingId) =>
    routes.publication.PUT(
      new Request(`${APP_ORIGIN}/api/recorded-lectures/${recordingId}/publication`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: "PUBLIC" }) }),
      { params: { recordingId } }
    );
  const updates = () => state.fakeDb.db.log.filter((entry) => entry.kind === "recordedLecture.updateMany").length;
  const before = updates();
  const refused = await json(await put(general.id));
  assert.deepEqual([refused.status, refused.body.error.code], [409, "GENERAL_RECORDING_NOT_PUBLISHABLE"]);
  assert.notEqual(state.fakeDb.db.recordings.find((r) => r.id === general.id).visibility, "PUBLIC", "nothing changed");
  assert.equal(updates(), before, "refused before any update");

  await H.signInAs(OTHER);
  assert.equal((await put(general.id)).status, 404, "another teacher: still the same 404");
});

// ---- Regression and isolation -------------------------------------------------------------------------

test("normal lecture recordings are unchanged: the lecture-scoped start / list work exactly as before", async () => {
  await H.signInAs(OWNER);
  const started = await H.createUpload(1000);
  assert.equal(started.status, 201);
  const list = await json(await routes.lectureList.GET(new Request(`${APP_ORIGIN}/api/lectures/${LECTURE}/recorded-lectures`), { params: { id: LECTURE } }));
  assert.equal(list.status, 200);
  assert.equal(list.body.data.recordings.length, 1);
  assert.equal(list.body.data.lecture.id, LECTURE);
});

test("source: includeDefault is only ever decided on the server, from the class; nothing else widened", () => {
  const fs = require("node:fs");
  const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
  const service = read("services", "class-recordings-service.ts");
  assert.match(service, /includeDefault: lecture\.isDefault/);
  assert.equal((service.match(/includeDefault/g) ?? []).length >= 2, true);
  for (const route of [["app", "api", "classes", "[id]", "recorded-lectures", "route.ts"], ["app", "api", "classes", "[id]", "recorded-lectures", "uploads", "route.ts"], ["app", "api", "lectures", "[id]", "recorded-lectures", "uploads", "route.ts"], ["app", "api", "lectures", "[id]", "recorded-lectures", "route.ts"]]) {
    assert.doesNotMatch(read(...route), /includeDefault/, route.join("/"));
  }
  const upload = read("services", "recorded-lecture-upload-service.ts");
  assert.match(upload, /const includeDefault = input\.includeDefault === true;/);
  assert.match(upload, /\.\.\.\(includeDefault \? \{\} : NORMAL_LECTURE_WHERE\)/);
  assert.match(read("services", "lecture-service.ts"), /\.\.\.\(options\.includeDefault \? \{\} : NORMAL_LECTURE_WHERE\)/, "the global default (exclude) is unchanged");
  // YouTube recording and live start keep excluding default lectures.
  assert.match(read("lib", "youtube-feature-lifecycle.ts"), /where: \{ id: lectureId, \.\.\.NORMAL_LECTURE_WHERE \}/);
  assert.match(read("services", "session-service.ts"), /\.\.\.NORMAL_LECTURE_WHERE/);
});

// ---- The upload engine with the class-scoped start (Stage 2: the Recorded Lectures page) ----------------

test("engine: a General upload starts at the class-scoped URL (never a lecture id), then chunks, completes and verifies to READY", async () => {
  await H.signInAs(OWNER);
  const E = require(path.join(root, "components", "recorded-lectures", "upload-engine.ts"));
  const chunkRoute = require(path.join(root, "app", "api", "recorded-lectures", "uploads", "[uploadId]", "chunks", "route.ts"));
  const uploadRoute = require(path.join(root, "app", "api", "recorded-lectures", "uploads", "[uploadId]", "route.ts"));
  const completeRoute = require(path.join(root, "app", "api", "recorded-lectures", "uploads", "[uploadId]", "complete", "route.ts"));
  const calls = [];
  const fetchViaRoutes = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const u = new URL(url, APP_ORIGIN);
    calls.push(`${method} ${u.pathname}${u.search}`);
    const headers = new Headers(init.headers ?? {});
    headers.set("origin", APP_ORIGIN); // what a same-origin browser fetch sends
    let body = init.body ?? undefined;
    if (body instanceof Blob) {
      body = Buffer.from(await body.arrayBuffer());
      headers.set("content-length", String(body.length));
    }
    const request = new Request(u, { method, headers, body });
    let m;
    if ((m = u.pathname.match(/^\/api\/classes\/([^/]+)\/recorded-lectures\/uploads$/)) && method === "POST") return routes.classStart.POST(request, { params: { id: m[1] } });
    if ((m = u.pathname.match(/^\/api\/recorded-lectures\/uploads\/([^/]+)\/chunks$/))) return chunkRoute.PUT(request, { params: { uploadId: m[1] } });
    if ((m = u.pathname.match(/^\/api\/recorded-lectures\/uploads\/([^/]+)\/complete$/))) return completeRoute.POST(request, { params: { uploadId: m[1] } });
    if ((m = u.pathname.match(/^\/api\/recorded-lectures\/uploads\/([^/]+)$/))) return method === "DELETE" ? uploadRoute.DELETE(request, { params: { uploadId: m[1] } }) : uploadRoute.GET(request, { params: { uploadId: m[1] } });
    throw new Error(`no route for ${method} ${u.pathname}`);
  };
  const file = H.validMp4(64 * 1024);
  const blob = new Blob([file]);
  const uploader = new E.RecordingUploader(
    "not-used-for-the-start", // the engine's lecture id: only the default start URL would use it
    { size: blob.size, slice: (s, e) => blob.slice(s, e) },
    { title: "General 1", partNumber: 1, fileName: "general.mp4", sizeBytes: file.length },
    { fetch: fetchViaRoutes, sleep: async () => undefined, pollIntervalMs: 0, startUrl: E.classRecordingUploadStartUrl(CLASS) }
  );
  const result = await uploader.run();
  assert.equal(result.phase, "ready", JSON.stringify(result));
  assert.equal(calls[0], `POST /api/classes/${CLASS}/recorded-lectures/uploads`);
  assert.ok(!calls.some((c) => c.includes(DEFAULT) || c.includes("/api/lectures/")), "the default lecture's id is never sent");
  const row = state.fakeDb.db.recordings.find((r) => r.id === result.recordingId);
  assert.deepEqual([row.lectureId, row.state], [DEFAULT, "READY"]);
});

test("engine: a refused class-scoped start (no default lecture yet) ends with the server's code and a readable message", async () => {
  await H.signInAs(OWNER);
  const E = require(path.join(root, "components", "recorded-lectures", "upload-engine.ts"));
  const fetchViaRoutes = async (url, init = {}) => {
    const u = new URL(url, APP_ORIGIN);
    const headers = new Headers(init.headers ?? {});
    headers.set("origin", APP_ORIGIN);
    return routes.classStart.POST(new Request(u, { method: "POST", headers, body: init.body }), { params: { id: CLASS_NO_DEFAULT } });
  };
  const uploader = new E.RecordingUploader(
    "x",
    { size: 10, slice: () => new Blob([]) },
    { title: "General 1", partNumber: 1, fileName: "general.mp4", sizeBytes: 10 },
    { fetch: fetchViaRoutes, sleep: async () => undefined, startUrl: E.classRecordingUploadStartUrl(CLASS_NO_DEFAULT) }
  );
  const result = await uploader.run();
  assert.deepEqual([result.phase, result.code, result.message], ["error", "DEFAULT_LECTURE_MISSING", "General recordings are not set up for this class yet."]);
  assert.equal(state.fakeDb.db.recordings.length, 0);
});
