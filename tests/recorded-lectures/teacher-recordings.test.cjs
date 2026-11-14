/*
 * Recorded Lectures, teacher side: the teacher management APIs (list, edit,
 * soft delete, owner preview) and the browser upload engine, end to end
 * through the REAL routes, services, LocalFileStorage and completion job
 * (helpers/upload-harness.cjs: in-memory database fake, temporary storage).
 *
 * The engine's fetch is a transport that hands each request to the matching
 * route handler, so retries, pauses, resumes, expiry, duplicate completion,
 * cancellation and interruption are tested against the real protocol.
 */

"use strict";

const H = require("./helpers/upload-harness.cjs");

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { state, ids, constants, F, signInAs, validMp4, until, db } = H;
const { OWNER, OTHER, LECTURE, LECTURE_2, LECTURE_OTHER, id } = ids;
const { MIB } = constants;
const root = path.resolve(__dirname, "..", "..");

const E = require(path.join(root, "components", "recorded-lectures", "upload-engine.ts"));
const Store = require(path.join(root, "components", "recorded-lectures", "recording-store.ts"));
const { uploadLocalRecording } = require(path.join(root, "components", "recorded-lectures", "studio-upload.ts"));
const Studio = require(path.join(root, "components", "recorded-lectures", "studio-helpers.ts"));
const M = require(path.join(root, "lib", "recorded-lectures", "mp4-inspect.ts"));
const { fragmentedRecording } = require("./helpers/fragmented-mp4.cjs");

const routes = {
  start: require(path.join(root, "app", "api", "lectures", "[id]", "recorded-lectures", "uploads", "route.ts")),
  list: require(path.join(root, "app", "api", "lectures", "[id]", "recorded-lectures", "route.ts")),
  chunk: require(path.join(root, "app", "api", "recorded-lectures", "uploads", "[uploadId]", "chunks", "route.ts")),
  upload: require(path.join(root, "app", "api", "recorded-lectures", "uploads", "[uploadId]", "route.ts")),
  complete: require(path.join(root, "app", "api", "recorded-lectures", "uploads", "[uploadId]", "complete", "route.ts")),
  recording: require(path.join(root, "app", "api", "recorded-lectures", "[recordingId]", "route.ts")),
  preview: require(path.join(root, "app", "api", "recorded-lectures", "[recordingId]", "stream", "route.ts")),
};

H.install(test);

// ---- Transport: fetch -> route handlers ------------------------------------------------------------------

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/**
 * hooks.beforeChunk(n, request) may throw (network failure) or await a gate; n counts chunk PUTs from 1.
 * hooks.beforeComplete(n) likewise. calls records every request.
 */
function transport(hooks = {}) {
  const calls = [];
  let chunkCalls = 0;
  let completeCalls = 0;
  const fetch = async (url, init = {}) => {
    if (init.signal?.aborted) throw abortError();
    const method = (init.method ?? "GET").toUpperCase();
    const u = new URL(url, "http://localhost");
    const headers = new Headers(init.headers ?? {});
    let body = init.body ?? undefined;
    if (body instanceof Blob) {
      body = Buffer.from(await body.arrayBuffer());
      headers.set("content-length", String(body.length));
    }
    calls.push({ method, path: u.pathname });
    const request = new Request(u, { method, headers, body });
    let m;
    const abortable = async (promise) => {
      if (!init.signal) return promise;
      if (init.signal.aborted) throw abortError();
      return Promise.race([promise, new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(abortError()), { once: true }))]);
    };
    if ((m = u.pathname.match(/^\/api\/lectures\/([^/]+)\/recorded-lectures\/uploads$/)) && method === "POST") return routes.start.POST(request, { params: { id: m[1] } });
    if ((m = u.pathname.match(/^\/api\/lectures\/([^/]+)\/recorded-lectures$/)) && method === "GET") return routes.list.GET(request, { params: { id: m[1] } });
    if ((m = u.pathname.match(/^\/api\/recorded-lectures\/uploads\/([^/]+)\/chunks$/)) && method === "PUT") {
      chunkCalls += 1;
      if (hooks.beforeChunk) await abortable(Promise.resolve(hooks.beforeChunk(chunkCalls, request)));
      return abortable(routes.chunk.PUT(request, { params: { uploadId: m[1] } }));
    }
    if ((m = u.pathname.match(/^\/api\/recorded-lectures\/uploads\/([^/]+)\/complete$/)) && method === "POST") {
      completeCalls += 1;
      if (hooks.beforeComplete) await hooks.beforeComplete(completeCalls);
      return routes.complete.POST(request, { params: { uploadId: m[1] } });
    }
    if ((m = u.pathname.match(/^\/api\/recorded-lectures\/uploads\/([^/]+)$/))) {
      if (hooks.beforeStatus) await hooks.beforeStatus(method);
      return method === "DELETE" ? routes.upload.DELETE(request, { params: { uploadId: m[1] } }) : routes.upload.GET(request, { params: { uploadId: m[1] } });
    }
    if ((m = u.pathname.match(/^\/api\/recorded-lectures\/([^/]+)\/stream$/))) return routes.preview[method](request, { params: { recordingId: m[1] } });
    if ((m = u.pathname.match(/^\/api\/recorded-lectures\/([^/]+)$/))) return routes.recording[method](request, { params: { recordingId: m[1] } });
    throw new Error(`transport: no route for ${method} ${u.pathname}`);
  };
  return { fetch, calls, counts: () => ({ chunkCalls, completeCalls }) };
}

const noSleep = async () => undefined;
const source = (bytes) => {
  const blob = new Blob([bytes]);
  return { size: blob.size, slice: (s, e) => blob.slice(s, e) };
};

function uploader(bytes, transportFetch, options = {}) {
  const updates = [];
  const u = new E.RecordingUploader(
    options.lecture ?? LECTURE,
    source(bytes),
    { title: options.title ?? "Algebra part 1", partNumber: options.part ?? 1, fileName: "algebra.mp4", sizeBytes: bytes.length },
    { fetch: transportFetch, sleep: noSleep, pollIntervalMs: 0, maxNetworkRetries: options.maxNetworkRetries ?? 3, onUpdate: (s) => updates.push(s) },
    options.existing
  );
  return { u, updates };
}

async function api(method, url, body) {
  const t = transport();
  const response = await t.fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null, text };
}

const finished = () => H.completion.waitForCompletionJobs();

// ---- Upload engine: success and progress -----------------------------------------------------------------

test("engine: uploads in bounded chunks, reports server-acknowledged progress, completes to READY", async () => {
  await signInAs(OWNER);
  const file = validMp4(2 * MIB + 300 * 1024);
  const t = transport();
  const { u, updates } = uploader(file, t.fetch);
  const result = await u.run();
  assert.equal(result.phase, "ready", JSON.stringify(result));
  assert.equal(result.receivedBytes, file.length);
  assert.equal(t.counts().chunkCalls, 3, "1 MiB chunks (the server's chunkBytes)");
  assert.equal(t.counts().completeCalls, 1);
  // Progress never goes backwards and never claims more than the server stored.
  let last = 0;
  for (const s of updates) {
    assert.ok(s.receivedBytes >= last, "monotonic");
    assert.ok(s.receivedBytes <= file.length);
    last = s.receivedBytes;
  }
  assert.ok(updates.some((s) => s.phase === "verifying" || s.phase === "completing"));
  const rec = H.recordingOf(result.uploadId);
  assert.equal(rec.state, "READY");
  assert.equal(E.progressPercent(file.length - 1, file.length), 99, "never 100 % before every byte");
  assert.equal(E.progressPercent(file.length, file.length), 100);
});

test("engine: a dropped connection is retried and continues from the server's offset (no bytes skipped or repeated)", async () => {
  await signInAs(OWNER);
  const file = validMp4(2 * MIB + 300 * 1024);
  let dropped = 0;
  const t = transport({
    beforeChunk: (n) => {
      if (n === 2 && dropped === 0) {
        dropped += 1;
        throw new TypeError("Failed to fetch");
      }
    },
  });
  const { u, updates } = uploader(file, t.fetch);
  const result = await u.run();
  assert.equal(result.phase, "ready");
  assert.ok(updates.some((s) => s.phase === "retrying" && s.code === "NETWORK"));
  const session = H.sessionOf(result.uploadId);
  assert.equal(Number(session.receivedBytes), file.length);
  assert.equal(H.chunksOf(result.uploadId).length, 3, "every chunk stored exactly once");
});

test("engine: offline beyond the retries pauses; a later run (or a new engine after a refresh) resumes and completes", async () => {
  await signInAs(OWNER);
  const file = validMp4(2 * MIB + 300 * 1024);
  let offline = true;
  const t = transport({ beforeChunk: (n) => { if (n >= 2 && offline) throw new TypeError("offline"); } });
  const { u } = uploader(file, t.fetch, { maxNetworkRetries: 2 });
  const paused = await u.run();
  assert.equal(paused.phase, "paused");
  assert.equal(paused.code, "NETWORK");
  // 1 accepted chunk + exactly (maxNetworkRetries + 1) failed attempts, then it stops trying.
  assert.equal(t.counts().chunkCalls, 1 + 3);
  assert.equal(paused.receivedBytes, MIB, "the first chunk is acknowledged");
  offline = false;
  // A refresh: a NEW engine for the same upload, from the stored uploadId.
  const again = uploader(file, t.fetch, { existing: { uploadId: paused.uploadId } });
  const result = await again.u.run();
  assert.equal(result.phase, "ready");
  assert.equal(H.chunksOf(result.uploadId).length, 3);
});

test("engine: pause during a chunk stops sending; resume continues from the server's offset", async () => {
  await signInAs(OWNER);
  const file = validMp4(2 * MIB + 300 * 1024);
  const g = H.gate();
  state.gates.push(g);
  let engine;
  const t = transport({
    beforeChunk: async (n) => {
      if (n === 2) {
        engine.pause();
        await g.promise;
      }
    },
  });
  const { u } = uploader(file, t.fetch);
  engine = u;
  const first = await u.run();
  assert.equal(first.phase, "paused");
  g.open();
  const second = await u.run();
  assert.equal(second.phase, "ready");
});

test("engine: an expired upload is reported as expired (the teacher starts again)", async () => {
  await signInAs(OWNER);
  const file = validMp4(2 * MIB + 300 * 1024);
  const t = transport();
  const started = await H.createUpload(file.length);
  const uploadId = started.body.data.uploadId;
  state.clock += 25 * 60 * 60 * 1000; // past the 24 h expiry
  const { u } = uploader(file, t.fetch, { existing: { uploadId } });
  const result = await u.run();
  assert.equal(result.phase, "expired");
  assert.equal(result.code, "UPLOAD_EXPIRED");
  assert.match(result.message, /expired/i);
});

test("engine: duplicate completion (two tabs / a repeated click) verifies once and both end READY", async () => {
  await signInAs(OWNER);
  const file = validMp4(2 * MIB + 300 * 1024);
  const uploadId = await H.uploadFile(file);
  // Another tab already asked to complete:
  const other = await H.complete(uploadId);
  assert.equal(other.status, 202);
  const t = transport();
  const { u } = uploader(file, t.fetch, { existing: { uploadId } });
  const result = await u.run();
  assert.equal(result.phase, "ready");
  assert.ok(t.counts().completeCalls <= 1, "the engine sends complete at most once");
  await finished();
  assert.equal(H.recordingOf(uploadId).state, "READY");
  const finals = H.allFiles().filter((f) => f.includes("RecordedLectures"));
  assert.equal(finals.length, 1, "one published file");
});

test("engine: cancel during an upload cancels it on the server; the part number becomes free", async () => {
  await signInAs(OWNER);
  const file = validMp4(2 * MIB + 300 * 1024);
  const g = H.gate();
  state.gates.push(g);
  let engine;
  const t = transport({
    beforeChunk: async (n) => {
      if (n === 2) {
        setImmediate(() => void engine.cancel());
        await g.promise;
      }
    },
  });
  const { u } = uploader(file, t.fetch);
  engine = u;
  const running = u.run();
  await until(() => u.state.phase === "cancelled" || u.state.phase === "error", "cancel finished");
  g.open();
  await running;
  assert.equal(u.state.phase, "cancelled", JSON.stringify(u.state));
  const session = H.sessionOf(u.state.uploadId);
  assert.equal(session.state, "CANCELLED");
  assert.equal(H.recordingOf(u.state.uploadId).failureCode, "UPLOAD_CANCELLED");
  // The same part number can be used again.
  const again = uploader(file, t.fetch);
  assert.equal((await again.u.run()).phase, "ready");
});

test("engine: a duplicate part number and an invalid title stop before any byte is sent", async () => {
  await signInAs(OWNER);
  const file = validMp4(2 * MIB + 300 * 1024);
  const t = transport();
  assert.equal((await uploader(file, t.fetch).u.run()).phase, "ready");
  const dup = await uploader(file, t.fetch).u.run();
  assert.equal(dup.phase, "error");
  assert.equal(dup.code, "PART_NUMBER_IN_USE");
  assert.match(dup.message, /part number/i);
  const bad = await uploader(file, t.fetch, { title: "   ", part: 2 }).u.run();
  assert.equal(bad.code, "UPLOAD_DECLARATION_INVALID");
  assert.match(bad.message, /title/i);
  assert.equal(t.counts().chunkCalls, 3, "only the first upload sent chunks");
});

test("engine: a session that ends mid-upload asks to sign in (the upload can be resumed afterwards)", async () => {
  await signInAs(OWNER);
  const file = validMp4(2 * MIB + 300 * 1024);
  const t = transport({ beforeChunk: (n) => { if (n === 2) state.cookie = null; } });
  const { u } = uploader(file, t.fetch);
  const result = await u.run();
  assert.equal(result.phase, "error");
  assert.equal(result.code, "UNAUTHORIZED");
  assert.equal(result.signIn, true);
  await signInAs(OWNER);
  const resumed = await uploader(file, t.fetch, { existing: { uploadId: result.uploadId } }).u.run();
  assert.equal(resumed.phase, "ready");
});

test("engine: another teacher can neither resume nor cancel someone else's upload", async () => {
  await signInAs(OWNER);
  const file = validMp4(2 * MIB + 300 * 1024);
  const started = await H.createUpload(file.length);
  await signInAs(OTHER);
  const t = transport();
  const result = await uploader(file, t.fetch, { existing: { uploadId: started.body.data.uploadId } }).u.run();
  assert.equal(result.phase, "error");
  assert.equal(result.code, "UPLOAD_NOT_FOUND");
  const cancelled = await uploader(file, t.fetch, { existing: { uploadId: started.body.data.uploadId } }).u.cancel();
  assert.notEqual(H.sessionOf(started.body.data.uploadId).state, "CANCELLED");
  assert.ok(["cancelled", "error"].includes(cancelled.phase));
});

test("engine: a file that is not the declared one (other size) is refused before sending", async () => {
  await signInAs(OWNER);
  const file = validMp4(2 * MIB + 300 * 1024);
  const started = await H.createUpload(file.length);
  const t = transport();
  const result = await uploader(Buffer.concat([file, Buffer.alloc(10)]), t.fetch, { existing: { uploadId: started.body.data.uploadId } }).u.run();
  assert.equal(result.code, "SOURCE_MISMATCH");
  assert.equal(t.counts().chunkCalls, 0);
});

test("engine: a file the server rejects (not H.264 + AAC MP4) ends FAILED with a fixed message", async () => {
  await signInAs(OWNER);
  const bad = validMp4(2 * MIB, { moovBox: F.moov({ tracks: [F.videoTrack()] }) }); // no audio track
  const t = transport();
  const result = await uploader(bad, t.fetch).u.run();
  assert.equal(result.phase, "failed");
  assert.match(result.code, /^MP4_/);
  assert.match(result.message, /H\.264 video and AAC audio/);
});

// ---- Studio recordings: fragmented MP4, recovery, cleanup ---------------------------------------------------

function inChunks(bytes, size) {
  const parts = [];
  for (let at = 0; at < bytes.length; at += size) parts.push(new Blob([bytes.subarray(at, Math.min(bytes.length, at + size))]));
  return parts;
}

async function storeRecording(store, bytes, extra = {}) {
  const local = {
    id: id(9000 + Math.floor(Math.random() * 999)), teacherId: OWNER, lectureId: LECTURE, mimeType: "video/mp4", startedAt: 1, updatedAt: 1,
    status: "stopped", durationMs: 0, uploadId: null, title: null, partNumber: null, uploadBytes: null, ...extra,
  };
  await store.putRecording(local);
  let i = 0;
  for (const part of inChunks(bytes, 64 * 1024)) await store.appendChunk(local.id, i++, part);
  return local;
}

test("studio: a browser-style fragmented MP4 (no mvhd duration) uploads from stored chunks and becomes READY with its duration", async () => {
  await signInAs(OWNER);
  const recording = fragmentedRecording({ fragments: 90, mediaBytes: 24 * 1024 }); // ~2.2 MiB, 90 s
  const store = Store.createMemoryStore();
  const local = await storeRecording(store, recording);
  const blob = await store.assemble(local.id, "video/mp4");
  assert.equal(blob.size, recording.length);
  const t = transport();
  const result = await uploadLocalRecording({ store, local, blob, title: "Studio recording", partNumber: 1, fileName: "studio.mp4", deps: { fetch: t.fetch, sleep: noSleep, pollIntervalMs: 0 } });
  assert.equal(result.phase, "ready", JSON.stringify(result));
  const rec = H.recordingOf(result.uploadId);
  assert.equal(rec.durationSeconds, 90);
  assert.equal(rec.fragmented, true);
  assert.equal(await store.getRecording(local.id), null, "local copy removed only after READY");
});

test("studio: the upload id is remembered; after an interruption the SAME upload resumes (no second upload)", async () => {
  await signInAs(OWNER);
  const recording = fragmentedRecording({ fragments: 90, mediaBytes: 24 * 1024 });
  const store = Store.createMemoryStore();
  const local = await storeRecording(store, recording);
  const blob = await store.assemble(local.id, "video/mp4");
  let offline = true;
  const t = transport({ beforeChunk: (n) => { if (n >= 2 && offline) throw new TypeError("offline"); } });
  const first = await uploadLocalRecording({ store, local, blob, title: "Studio", partNumber: 1, fileName: "s.mp4", deps: { fetch: t.fetch, sleep: noSleep, pollIntervalMs: 0, maxNetworkRetries: 1 } });
  assert.equal(first.phase, "paused");
  const remembered = await store.getRecording(local.id);
  assert.equal(remembered.uploadId, first.uploadId);
  assert.equal(remembered.status, "uploading");
  offline = false;
  const second = await uploadLocalRecording({ store, local: remembered, blob, title: "Studio", partNumber: 1, fileName: "s.mp4", deps: { fetch: t.fetch, sleep: noSleep, pollIntervalMs: 0 } });
  assert.equal(second.phase, "ready");
  assert.equal(second.uploadId, first.uploadId, "the same upload");
  assert.equal(db().sessions.length, 1);
});

test("studio recovery: a recording cut mid-fragment by a crash is trimmed to its complete fragments and still uploads", async () => {
  await signInAs(OWNER);
  const full = fragmentedRecording({ fragments: 90, mediaBytes: 24 * 1024 });
  const crashed = full.subarray(0, full.length - 10_000); // ends inside the last mdat
  const store = Store.createMemoryStore();
  const local = await storeRecording(store, crashed, { status: "recording" });
  const blob = await store.assemble(local.id, "video/mp4");
  const recovered = await Studio.recoverableLength(M.blobByteSource(blob));
  assert.equal(recovered.hasMoov, true);
  assert.equal(recovered.fragments, 89);
  assert.ok(recovered.droppedBytes > 0);
  const trimmed = blob.slice(0, recovered.length);
  const inspected = await M.inspectMp4(M.blobByteSource(trimmed), { maxMoovBytes: 64 * MIB });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.info.durationSeconds, 89);
  const t = transport();
  const result = await uploadLocalRecording({ store, local, blob: trimmed, title: "Recovered", partNumber: 1, fileName: "r.mp4", deps: { fetch: t.fetch, sleep: noSleep, pollIntervalMs: 0 } });
  assert.equal(result.phase, "ready");
  assert.equal(H.recordingOf(result.uploadId).durationSeconds, 89);
});

test("studio recovery: nothing usable without a moov (crash before the first fragment header)", async () => {
  const full = fragmentedRecording({ fragments: 2 });
  const tiny = full.subarray(0, 40);
  const recovered = await Studio.recoverableLength(M.bytesByteSource(new Uint8Array(tiny)));
  assert.deepEqual(recovered, { length: 0, hasMoov: false, fragments: 0, droppedBytes: 40 });
});

test("studio: an expired upload keeps the local recording for a NEW upload", async () => {
  await signInAs(OWNER);
  const recording = fragmentedRecording({ fragments: 90, mediaBytes: 24 * 1024 });
  const store = Store.createMemoryStore();
  const started = await H.createUpload(recording.length);
  const local = await storeRecording(store, recording, { status: "uploading", uploadId: started.body.data.uploadId, uploadBytes: recording.length });
  state.clock += 25 * 60 * 60 * 1000;
  const blob = await store.assemble(local.id, "video/mp4");
  const t = transport();
  const result = await uploadLocalRecording({ store, local, blob, title: "S", partNumber: 2, fileName: "s.mp4", deps: { fetch: t.fetch, sleep: noSleep, pollIntervalMs: 0 } });
  assert.equal(result.phase, "expired");
  const kept = await store.getRecording(local.id);
  assert.ok(kept, "kept");
  assert.equal(kept.uploadId, null);
  assert.equal(kept.status, "stopped");
});

// ---- Teacher management APIs ----------------------------------------------------------------------------

async function readyRecording(part = 1, lecture = LECTURE) {
  const file = validMp4(2 * MIB + 300 * 1024);
  const uploadId = await H.uploadFile(file, { part, lecture });
  assert.equal((await H.complete(uploadId)).status, 202);
  await until(() => H.recordingOf(uploadId).state === "READY", "READY");
  return { uploadId, recording: H.recordingOf(uploadId), file };
}

test("list: the owner sees every state with progress; nothing internal leaks", async () => {
  await signInAs(OWNER);
  const { recording } = await readyRecording(1);
  const partial = await H.createUpload(3 * MIB, { part: 2 });
  await H.putChunk(partial.body.data.uploadId, 0, Buffer.alloc(MIB, 1));
  const res = await api("GET", `/api/lectures/${LECTURE}/recorded-lectures`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store, max-age=0");
  const data = res.body.data;
  assert.deepEqual(data.recordings.map((r) => [r.partNumber, r.state]), [[1, "READY"], [2, "UPLOADING"]]);
  assert.equal(data.nextPartNumber, 3);
  const ready = data.recordings[0];
  assert.equal(ready.previewUrl, `/api/recorded-lectures/${recording.id}/stream`);
  assert.equal(ready.sizeBytes, String(Number(recording.sizeBytes)));
  assert.equal(ready.durationSeconds, 3600);
  const uploading = data.recordings[1];
  assert.equal(uploading.upload.receivedBytes, MIB);
  assert.equal(uploading.upload.expectedBytes, 3 * MIB);
  assert.equal(uploading.previewUrl, null);
  for (const secret of [recording.storedFileName, "teacherId", "classId", "storedFileName", "leaseToken", "Teachers/", "TemporaryUploads"]) {
    assert.ok(!res.text.includes(secret), secret);
  }
  assert.deepEqual(Object.keys(data.limits).sort(), ["chunkBytes", "maxMoovBytes", "maxPartBytes", "maxPartsPerLecture"]);
});

test("list: other teachers get 404, no session 401, a malformed lecture id 404", async () => {
  await signInAs(OTHER);
  assert.equal((await api("GET", `/api/lectures/${LECTURE}/recorded-lectures`)).status, 404);
  state.cookie = null;
  assert.equal((await api("GET", `/api/lectures/${LECTURE}/recorded-lectures`)).status, 401);
  await signInAs(OWNER);
  assert.equal((await api("GET", `/api/lectures/not-a-uuid/recorded-lectures`)).status, 404);
  assert.equal((await api("GET", `/api/lectures/${LECTURE_OTHER}/recorded-lectures`)).status, 404);
});

test("edit: title and part number; a part number in use is 409; invalid values 400; others 404", async () => {
  await signInAs(OWNER);
  const a = await readyRecording(1);
  const b = await readyRecording(2);
  const renamed = await api("PATCH", `/api/recorded-lectures/${a.recording.id}`, { title: "  Algebra — introduction  " });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.recording.title, "Algebra — introduction");
  const clash = await api("PATCH", `/api/recorded-lectures/${a.recording.id}`, { partNumber: 2 });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, "PART_NUMBER_IN_USE");
  assert.equal(H.recordingOf(a.uploadId).partNumber, 1, "unchanged");
  const moved = await api("PATCH", `/api/recorded-lectures/${b.recording.id}`, { partNumber: 5 });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.data.recording.partNumber, 5);
  for (const body of [{ title: "" }, { partNumber: 0 }, { partNumber: 1.5 }, { title: "x".repeat(201) }, {}]) {
    const res = await api("PATCH", `/api/recorded-lectures/${a.recording.id}`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  await signInAs(OTHER);
  assert.equal((await api("PATCH", `/api/recorded-lectures/${a.recording.id}`, { title: "Mine now" })).status, 404);
});

test("delete: soft delete (status 2, purge pending); an active upload is cancelled first; others 404", async () => {
  await signInAs(OWNER);
  const { uploadId, recording } = await readyRecording(1);
  await signInAs(OTHER);
  assert.equal((await api("DELETE", `/api/recorded-lectures/${recording.id}`)).status, 404);
  await signInAs(OWNER);
  const res = await api("DELETE", `/api/recorded-lectures/${recording.id}`);
  assert.equal(res.status, 200);
  const row = H.recordingOf(uploadId);
  assert.equal(row.status, 2);
  assert.ok(row.deletedAt instanceof Date && row.purgeRequestedAt instanceof Date);
  assert.equal(row.deletedByTeacherId, OWNER);
  assert.equal((await api("DELETE", `/api/recorded-lectures/${recording.id}`)).status, 404, "already deleted");
  const list = await api("GET", `/api/lectures/${LECTURE}/recorded-lectures`);
  assert.equal(list.body.data.recordings.length, 0);

  // An upload in progress: cancelled, then deleted.
  const partial = await H.createUpload(3 * MIB, { part: 1 });
  await H.putChunk(partial.body.data.uploadId, 0, Buffer.alloc(MIB, 1));
  const recId = H.recordingOf(partial.body.data.uploadId).id;
  assert.equal((await api("DELETE", `/api/recorded-lectures/${recId}`)).status, 200);
  assert.equal(H.sessionOf(partial.body.data.uploadId).state, "CANCELLED");
  assert.equal(H.recordingOf(partial.body.data.uploadId).status, 2);
});

test("delete: refused (409) while the recording is being verified", async () => {
  await signInAs(OWNER);
  const file = validMp4(2 * MIB + 300 * 1024);
  const uploadId = await H.uploadFile(file);
  const g = H.gate();
  state.gates.push(g);
  state.storagePatches.promote = async (original, ...args) => {
    await g.promise;
    return original(...args);
  };
  assert.equal((await H.complete(uploadId)).status, 202);
  await until(() => H.recordingOf(uploadId).state === "VERIFYING" && H.sessionOf(uploadId).state === "COMPLETING", "verifying");
  const res = await api("DELETE", `/api/recorded-lectures/${H.recordingOf(uploadId).id}`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "UPLOAD_COMPLETING");
  g.open();
  await finished();
  assert.equal(H.recordingOf(uploadId).status, 0);
});

test("preview: the owner streams a READY recording with Range; other teachers 404, no session 401, HEAD opens nothing", async () => {
  await signInAs(OWNER);
  const { recording, file } = await readyRecording(1);
  const t = transport();
  const full = await t.fetch(`/api/recorded-lectures/${recording.id}/stream`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), file);
  const ranged = await t.fetch(`/api/recorded-lectures/${recording.id}/stream`, { headers: { Range: "bytes=10-19" } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), file.subarray(10, 20));
  assert.equal(ranged.headers.get("x-accel-buffering"), "no");
  assert.equal(ranged.headers.get("cache-control"), "private, no-store, max-age=0");
  const head = await t.fetch(`/api/recorded-lectures/${recording.id}/stream`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  await signInAs(OTHER);
  assert.equal((await t.fetch(`/api/recorded-lectures/${recording.id}/stream`)).status, 404);
  state.cookie = null;
  assert.equal((await t.fetch(`/api/recorded-lectures/${recording.id}/stream`)).status, 401);
});

test("preview: not available while the recording is being verified (it already has a stored name)", async () => {
  await signInAs(OWNER);
  const file = validMp4(2 * MIB + 300 * 1024);
  const uploadId = await H.uploadFile(file);
  const g = H.gate();
  state.gates.push(g);
  state.storagePatches.promote = async (original, ...args) => {
    await g.promise;
    return original(...args);
  };
  assert.equal((await H.complete(uploadId)).status, 202);
  await until(() => H.recordingOf(uploadId).state === "VERIFYING" && H.recordingOf(uploadId).storedFileName !== null, "verifying with a claim name");
  const t = transport();
  const res = await t.fetch(`/api/recorded-lectures/${H.recordingOf(uploadId).id}/stream`);
  assert.equal(res.status, 404);
  g.open();
  await finished();
});

test("preview: not available before READY or after delete", async () => {
  await signInAs(OWNER);
  const partial = await H.createUpload(3 * MIB, { part: 1 });
  const recId = H.recordingOf(partial.body.data.uploadId).id;
  const t = transport();
  assert.equal((await t.fetch(`/api/recorded-lectures/${recId}/stream`)).status, 404);
  const { recording } = await readyRecording(2);
  await api("DELETE", `/api/recorded-lectures/${recording.id}`);
  assert.equal((await t.fetch(`/api/recorded-lectures/${recording.id}/stream`)).status, 404);
});

// ---- Students see only what the teacher completed ------------------------------------------------------------

test("students: a recording produced by the real upload pipeline matches the RL-4.2 access filter only when READY and not deleted", async () => {
  await signInAs(OWNER);
  const { createFakeStudentDb } = require("./helpers/fake-student-db.cjs");
  const { studentRecordedLectureAccessWhere } = require(path.join(root, "services", "recorded-lecture-student-service.ts"));
  const STUDENT = id(77);
  const ready = await readyRecording(1);
  const partial = await H.createUpload(3 * MIB, { part: 2 });
  const uploading = H.recordingOf(partial.body.data.uploadId);

  function studentView(rows) {
    const fake = createFakeStudentDb();
    fake.db.students.push({ id: STUDENT, status: 0, sessionVersion: 0, confirmationStatus: "APPROVED" });
    for (const c of db().classes) fake.db.classes.push({ ...c });
    fake.db.classStudents.push({ id: id(78), classId: ids.CLASS, studentId: STUDENT, isActive: true });
    for (const l of db().lectures) fake.db.lectures.push({ ...l });
    for (const r of rows) fake.db.recordings.push({ ...r });
    return fake.prisma.recordedLecture.findMany({ where: studentRecordedLectureAccessWhere(STUDENT), select: { id: true } });
  }

  assert.deepEqual((await studentView(db().recordings)).map((r) => r.id), [ready.recording.id], "UPLOADING is invisible");
  // While verifying: invisible.
  assert.deepEqual(await studentView([{ ...ready.recording, state: "VERIFYING", readyAt: null }]), []);
  // FAILED: invisible.
  assert.deepEqual(await studentView([{ ...uploading, state: "FAILED", failureCode: "UPLOAD_CANCELLED", failedAt: new Date() }]), []);
  // Deleted by the teacher: invisible.
  await api("DELETE", `/api/recorded-lectures/${ready.recording.id}`);
  assert.deepEqual(await studentView(db().recordings), []);
});
