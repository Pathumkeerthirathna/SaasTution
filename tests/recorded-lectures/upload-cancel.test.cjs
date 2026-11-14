/*
 * Recorded Lectures RL-3.4: DELETE /api/recorded-lectures/uploads/[uploadId]
 * (cancellation) through the real routes, services and LocalFileStorage
 * (helpers/upload-harness.cjs). Cancellation changes the database only; it
 * never deletes a file (RL-3.5 cleans up).
 *
 *   npm run test:recorded-lectures
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const H = require("./helpers/upload-harness.cjs");
const { state, ids, constants, completion } = H;
const { OWNER, OTHER } = ids;
const { T0, MIB, STALE_MS } = constants;

H.install(test);

const chunkFiles = () => H.allFiles().filter((f) => f.endsWith(".chunk"));

function holdPromote() {
  const hold = H.gate();
  state.storagePatches.promote = async (original, ...args) => {
    await hold.promise;
    return original(...args);
  };
  return hold;
}

/** A body that sends `firstBytes`, then waits for resume(), then the rest. */
function pausedBody(bytes, firstBytes) {
  let resume;
  const resumed = new Promise((resolve) => (resume = resolve));
  let paused;
  const reachedPause = new Promise((resolve) => (paused = resolve));
  let sent = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (sent >= bytes.length) return controller.close();
      if (sent >= firstBytes && sent < firstBytes + 1) {
        paused();
        await resumed;
      }
      const piece = bytes.subarray(sent, Math.min(bytes.length, sent === 0 ? firstBytes : bytes.length));
      sent += piece.length;
      controller.enqueue(piece);
    },
  }, { highWaterMark: 0 });
  return { stream, reachedPause, resume };
}

function putStreaming(uploadId, offset, bytes, body) {
  const request = new Request(`http://localhost/api/recorded-lectures/uploads/${uploadId}/chunks`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "upload-offset": String(offset), "content-length": String(bytes.length) },
    body: body.stream,
    duplex: "half",
  });
  const chunkRoute = require("../../app/api/recorded-lectures/uploads/[uploadId]/chunks/route.ts");
  return chunkRoute.PUT(request, { params: { uploadId } }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

// ---- ACTIVE -------------------------------------------------------------------------------------------------

test("ACTIVE -> CANCELLED (recording FAILED UPLOAD_CANCELLED); committed chunk files are NOT deleted; idempotent", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4();
  const started = await H.createUpload(file.length);
  const uploadId = started.body.data.uploadId;
  assert.equal((await H.putChunk(uploadId, 0, file.subarray(0, MIB))).status, 200);
  const before = chunkFiles();
  const version = H.sessionOf(uploadId).version;

  const { status: code, body } = await H.cancel(uploadId);
  assert.equal(code, 200);
  assert.equal(body.data.uploadState, "CANCELLED");
  assert.equal(body.data.recordingState, "FAILED");
  assert.equal(body.data.failureCode, "UPLOAD_CANCELLED");
  const s = H.sessionOf(uploadId);
  assert.equal(s.endedAt.getTime(), T0);
  assert.equal(s.version, version + 1);
  assert.equal(s.leaseToken, null);
  assert.equal(H.recordingOf(uploadId).failedAt.getTime(), T0);
  assert.deepEqual(chunkFiles(), before, "cancellation deletes no file");

  const again = await H.cancel(uploadId);
  assert.equal(again.status, 200);
  assert.equal(again.body.data.uploadState, "CANCELLED");
  assert.equal(H.sessionOf(uploadId).version, version + 1, "no second transition");
  // A cancelled upload accepts no chunk.
  assert.equal((await H.putChunk(uploadId, MIB, file.subarray(MIB, 2 * MIB))).status, 409);
});

test("an expired ACTIVE upload is reported EXPIRED (not cancelled)", async () => {
  await H.signInAs(OWNER);
  const uploadId = (await H.createUpload(MIB)).body.data.uploadId;
  state.clock = T0 + 24 * 3600_000;
  const { status: code, body } = await H.cancel(uploadId);
  assert.equal(code, 200);
  assert.equal(body.data.uploadState, "EXPIRED");
  assert.equal(body.data.failureCode, "UPLOAD_EXPIRED");
});

test("authorization: 401 without a session; 404 for another teacher's upload; a blocked owner may cancel", async () => {
  await H.signInAs(OWNER);
  const uploadId = (await H.createUpload(MIB)).body.data.uploadId;
  state.cookie = null;
  assert.equal((await H.cancel(uploadId)).status, 401);
  await H.signInAs(OTHER);
  assert.equal((await H.cancel(uploadId)).body.error.code, "UPLOAD_NOT_FOUND");
  assert.equal((await H.cancel("ABCDEF00-0000-4000-8000-000000000001")).status, 404);
  await H.signInAs(OWNER);
  H.db().teachers[0].isBlocked = true;
  const { status: code, body } = await H.cancel(uploadId);
  assert.equal(code, 200);
  assert.equal(body.data.uploadState, "CANCELLED");
});

// ---- Cancellation and a chunk in progress -----------------------------------------------------------------------

test("a chunk in progress in this process: cancel waits, then 409 UPLOAD_BUSY and changes NOTHING (lease kept)", async () => {
  await H.signInAs(OWNER);
  const uploadId = (await H.createUpload(MIB)).body.data.uploadId;
  const bytes = Buffer.alloc(MIB, 3);
  const body = pausedBody(bytes, 64 * 1024);
  const pending = putStreaming(uploadId, 0, bytes, body);
  await body.reachedPause;
  const leased = { ...H.sessionOf(uploadId) };
  assert.ok(leased.leaseToken);

  const busy = await H.cancel(uploadId);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, "UPLOAD_BUSY");
  const after = H.sessionOf(uploadId);
  assert.equal(after.state, "ACTIVE");
  assert.equal(after.leaseToken, leased.leaseToken, "lease (and its capacity reservation) kept");
  assert.equal(after.version, leased.version);

  body.resume();
  assert.equal((await pending).status, 200);
  assert.equal((await H.cancel(uploadId)).body.data.uploadState, "CANCELLED");
  assert.equal(chunkFiles().length, 1, "the committed chunk file is kept");
});

// ---- Cancellation and chunk writers in OTHER processes (database lease) -----------------------------------------

/**
 * A chunk body of `bytes`, sent in pieces of `pieceBytes`; after `pauseAfter` pieces it waits for
 * resume(). Counts the pieces delivered after resuming, and whether the reader cancelled it.
 */
function piecewiseBody(bytes, pieceBytes, pauseAfter) {
  let sent = 0;
  let pieces = 0;
  let isResumed = false;
  let resume;
  const resumed = new Promise((resolve) => (resume = resolve)).then(() => (isResumed = true));
  let paused;
  const reachedPause = new Promise((resolve) => (paused = resolve));
  const control = { reachedPause, resume, afterResume: 0, cancelled: false };
  // Released after every test (harness afterEach), so a failing assertion never leaves a writer paused.
  state.gates.push({ open: resume });
  control.stream = new ReadableStream({
    async pull(controller) {
      if (pieces === pauseAfter && !isResumed) {
        paused();
        await resumed;
      }
      if (sent >= bytes.length) return controller.close();
      const piece = bytes.subarray(sent, Math.min(bytes.length, sent + pieceBytes));
      sent += piece.length;
      pieces++;
      if (isResumed) control.afterResume++;
      controller.enqueue(piece);
    },
    cancel() {
      control.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return control;
}

/** An upload of 2 MiB with its first 1 MiB committed; returns its id and the committed chunk file(s). */
async function halfUploaded() {
  const uploadId = (await H.createUpload(2 * MIB)).body.data.uploadId;
  assert.equal((await H.putChunk(uploadId, 0, Buffer.alloc(MIB, 1))).status, 200);
  const committed = chunkFiles();
  const bytes = committed.map((f) => fs.readFileSync(H.storageRoot() + "/" + f));
  return { uploadId, committed, bytes };
}

function assertCommittedUntouched(committed, bytes) {
  committed.forEach((f, i) => assert.ok(fs.readFileSync(H.storageRoot() + "/" + f).equals(bytes[i]), `${f} untouched`));
}

test("cross-process: a current chunk lease blocks cancellation (409 + Retry-After); nothing changes; its reservation still counts", async () => {
  await H.signInAs(OWNER);
  const { uploadId, committed, bytes } = await halfUploaded();
  const writer = piecewiseBody(Buffer.alloc(MIB, 2), 64 * 1024, 2); // "process A"
  H.asOtherProcess();
  const pending = putStreaming(uploadId, MIB, Buffer.alloc(MIB, 2), writer);
  await writer.reachedPause;
  const sessionBefore = { ...H.sessionOf(uploadId) };
  const recordingBefore = { ...H.recordingOf(uploadId) };

  state.clock = T0 + 100_000;
  H.asOtherProcess(); // "process B": its own mutex is free, so only the database lease can tell
  const refused = await H.cancel(uploadId);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "CHUNK_IN_PROGRESS");
  const retryAfter = Number(refused.response.headers.get("Retry-After"));
  assert.equal(retryAfter, Math.ceil((sessionBefore.leaseExpiresAt.getTime() - state.clock) / 1000));
  assert.deepEqual(H.sessionOf(uploadId), sessionBefore, "session, lease and version unchanged");
  assert.deepEqual(H.recordingOf(uploadId), recordingBefore, "recording unchanged");

  // The writer's reservation (remaining 0 + 2 x 1 MiB lease) still counts: another upload cannot take that space.
  state.freeBytes = 5 * 1024 * MIB + 2 * MIB + MIB - 1;
  const competitor = await H.createUpload(MIB, { part: 2 });
  assert.equal(competitor.status, 507, "the space the writer still needs is not handed out");

  writer.resume();
  assert.equal((await pending).status, 200, "the writer finishes normally");
  const afterWrite = chunkFiles();
  assert.equal(afterWrite.length, 2);
  const cancelled = await H.cancel(uploadId);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.uploadState, "CANCELLED");
  assertCommittedUntouched(committed, bytes);
  assert.deepEqual(chunkFiles(), afterWrite, "cancellation deletes no committed chunk");
  assert.equal((await H.createUpload(MIB, { part: 2 })).status, 201, "the reservation is released only now");
});

test("cross-process: an expired lease -> cancellation succeeds only once the writer is past its write deadline; the writer then stops", async () => {
  await H.signInAs(OWNER);
  const { uploadId, committed, bytes } = await halfUploaded();
  const writer = piecewiseBody(Buffer.alloc(MIB, 2), 64 * 1024, 2);
  H.asOtherProcess();
  const pending = putStreaming(uploadId, MIB, Buffer.alloc(MIB, 2), writer);
  await writer.reachedPause;
  const leaseExpiresAt = H.sessionOf(uploadId).leaseExpiresAt.getTime();
  const writeDeadline = leaseExpiresAt - 60_000; // writeMarginMs(300 s lease) = 60 s

  H.asOtherProcess();
  state.clock = leaseExpiresAt - 1;
  assert.equal((await H.cancel(uploadId)).body.error.code, "CHUNK_IN_PROGRESS", "one millisecond before the lease expires");
  assert.equal(H.sessionOf(uploadId).state, "ACTIVE");

  state.clock = leaseExpiresAt;
  assert.ok(state.clock >= writeDeadline + 60_000, "the writer is a full write margin past its deadline");
  const cancelled = await H.cancel(uploadId);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.uploadState, "CANCELLED");
  assert.equal(H.sessionOf(uploadId).leaseToken, null);

  // The writer resumes: the piece it was already receiving is written, then its deadline stops it.
  writer.resume();
  const result = await pending;
  assert.equal(result.status, 408);
  assert.equal(result.body.error.code, "CHUNK_TIMEOUT");
  assert.ok(writer.afterResume <= 1, `at most the one in-flight piece after the deadline (${writer.afterResume})`);
  assert.ok(writer.cancelled, "the rest of the body is not read");
  assert.deepEqual(chunkFiles(), committed, "the writer removed its own file; committed chunks remain");
  assertCommittedUntouched(committed, bytes);
  assert.equal(H.chunksOf(uploadId).length, 1);
});

test("concurrent grant vs cancellation (cancellation first): the grant's conditional update fails; no lease, no file", async () => {
  await H.signInAs(OWNER);
  const { uploadId, committed } = await halfUploaded();
  const atLock = H.gate();
  const release = H.gate();
  H.db().hooks.beforeAdvisoryLock = async (key) => {
    if (key !== "recorded-lectures:capacity") return;
    H.db().hooks.beforeAdvisoryLock = null;
    atLock.open();
    await release.promise; // the grant has read the session (no lease) and waits here
  };
  H.asOtherProcess();
  const chunk = H.putChunk(uploadId, MIB, Buffer.alloc(MIB, 2));
  await atLock.promise;
  H.asOtherProcess();
  const cancelled = await H.cancel(uploadId);
  assert.equal(cancelled.status, 200);
  release.open();
  const granted = await chunk;
  assert.equal(granted.status, 409);
  assert.equal(H.sessionOf(uploadId).state, "CANCELLED");
  assert.equal(H.sessionOf(uploadId).leaseToken, null);
  assert.deepEqual(chunkFiles(), committed);
});

test("concurrent grant vs cancellation (grant commits between the cancellation's read and update): 409 CHUNK_IN_PROGRESS; nothing changes", async () => {
  await H.signInAs(OWNER);
  const { uploadId, committed, bytes } = await halfUploaded();
  let writer = null;
  let pending = null;
  H.db().hooks.beforeSessionUpdateMany = async (where, data) => {
    if (data.state !== "CANCELLED" || writer) return;
    // The cancellation read "no lease"; before its update, another process is granted a lease.
    writer = piecewiseBody(Buffer.alloc(MIB, 2), 64 * 1024, 1);
    H.asOtherProcess();
    pending = putStreaming(uploadId, MIB, Buffer.alloc(MIB, 2), writer);
    await writer.reachedPause;
  };
  H.asOtherProcess();
  const result = await H.cancel(uploadId);
  H.db().hooks.beforeSessionUpdateMany = null;
  assert.ok(writer, "the race happened");
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "CHUNK_IN_PROGRESS");
  assert.ok(Number(result.response.headers.get("Retry-After")) >= 1);
  assert.equal(H.sessionOf(uploadId).state, "ACTIVE");
  assert.ok(H.sessionOf(uploadId).leaseToken, "the writer's lease (and reservation) stay");

  writer.resume();
  assert.equal((await pending).status, 200);
  assertCommittedUntouched(committed, bytes);
  assert.equal((await H.cancel(uploadId)).status, 200);
  assert.equal(chunkFiles().length, 2, "cancellation deletes no committed chunk");
});

// ---- COMPLETING / COMPLETED ---------------------------------------------------------------------------------

test("COMPLETING with a live heartbeat -> 409 UPLOAD_COMPLETING; the completion then finishes READY", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4());
  const hold = holdPromote();
  assert.equal((await H.complete(uploadId)).status, 202);
  H.asOtherProcess();
  state.clock = T0 + STALE_MS - 1;
  const refused = await H.cancel(uploadId);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "UPLOAD_COMPLETING");
  hold.open();
  await completion.waitForCompletionJobs();
  assert.equal(H.recordingOf(uploadId).state, "READY");
  const done = await H.cancel(uploadId);
  assert.equal(done.status, 409);
  assert.equal(done.body.error.code, "UPLOAD_ALREADY_COMPLETED");
});

test("COMPLETING with a stale heartbeat -> CANCELLED; the stale job can then neither publish nor mark READY", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4());
  const hold = holdPromote();
  assert.equal((await H.complete(uploadId)).status, 202);
  await H.until(() => state.storageCalls.some((c) => c.name === "promote"), "job at promote");
  const claimName = H.recordingOf(uploadId).storedFileName;

  state.clock = T0 + STALE_MS;
  H.asOtherProcess();
  const { status: code, body } = await H.cancel(uploadId);
  assert.equal(code, 200);
  assert.equal(body.data.uploadState, "CANCELLED");
  assert.equal(body.data.recordingState, "FAILED");
  assert.equal(body.data.failureCode, "UPLOAD_CANCELLED");
  const version = H.sessionOf(uploadId).version;

  hold.open();
  await completion.waitForCompletionJobs();
  assert.equal(H.recordingOf(uploadId).state, "FAILED", "never READY");
  assert.equal(H.sessionOf(uploadId).state, "CANCELLED");
  assert.equal(H.sessionOf(uploadId).version, version, "the stale job changed nothing");
  assert.ok(!fs.existsSync(H.finalPath(uploadId, claimName)), "the stale job removed its own published file");
  assert.ok(chunkFiles().length > 0, "chunk files are kept for cleanup");
});

test("cancel race: a heartbeat between the cancellation's read and its update keeps the completion (409)", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4());
  const hold = holdPromote();
  await H.complete(uploadId);
  await H.until(() => state.storageCalls.some((c) => c.name === "promote"), "job at promote");
  state.clock = T0 + STALE_MS;
  H.db().hooks.beforeSessionUpdateMany = async (where, data) => {
    if (where.lastActivityAt && data.state === "CANCELLED") {
      H.db().hooks.beforeSessionUpdateMany = null;
      H.sessionOf(uploadId).lastActivityAt = new Date(state.clock); // the job beats just before the update
    }
  };
  H.asOtherProcess();
  const result = await H.cancel(uploadId);
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "UPLOAD_COMPLETING");
  assert.equal(H.sessionOf(uploadId).state, "COMPLETING");
  hold.open();
  await completion.waitForCompletionJobs();
  assert.equal(H.recordingOf(uploadId).state, "READY");
});

// ---- Races ---------------------------------------------------------------------------------------------------

test("cancel vs complete in two processes (both read ACTIVE): exactly one wins", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4());
  const atLock = H.gate();
  const release = H.gate();
  H.db().hooks.beforeAdvisoryLock = async (key) => {
    if (key !== "recorded-lectures:capacity") return;
    H.db().hooks.beforeAdvisoryLock = null;
    atLock.open();
    await release.promise;
  };
  H.asOtherProcess();
  const completing = H.complete(uploadId); // read ACTIVE, held before its update
  await atLock.promise;
  H.asOtherProcess();
  const cancelled = await H.cancel(uploadId);
  release.open();
  const completed = await completing;
  await completion.waitForCompletionJobs();

  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.uploadState, "CANCELLED");
  assert.equal(completed.status, 409);
  assert.equal(completed.body.error.code, "UPLOAD_BUSY");
  assert.equal(H.sessionOf(uploadId).state, "CANCELLED");
  assert.equal(H.recordingOf(uploadId).storedFileName, null, "no claim was made");
});

test("cancel vs cancel in two processes: both answer CANCELLED; one transition", async () => {
  await H.signInAs(OWNER);
  const uploadId = (await H.createUpload(MIB)).body.data.uploadId;
  const version = H.sessionOf(uploadId).version;
  H.asOtherProcess();
  const a = H.cancel(uploadId);
  H.asOtherProcess();
  const b = H.cancel(uploadId);
  const results = await Promise.all([a, b]);
  for (const r of results) {
    assert.equal(r.status, 200);
    assert.equal(r.body.data.uploadState, "CANCELLED");
  }
  assert.equal(H.sessionOf(uploadId).version, version + 1);
});

test("no unhandled promise rejections", () => {
  assert.deepEqual(state.unhandled, []);
});
