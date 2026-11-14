/*
 * Recorded Lectures RL-3.5: maintenance (cleanup, expiry, recovery) through the
 * real services and LocalFileStorage (helpers/upload-harness.cjs) with the
 * in-memory database fake. The scheduler is NOT used here (it is not wired);
 * runs are called directly.
 *
 *   npm run test:recorded-lectures
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const H = require("./helpers/upload-harness.cjs");
const { state, ids, constants, completion, maintenance } = H;
const { OWNER, OTHER, LECTURE, LECTURE_OTHER } = ids;
const { T0, MIB, STALE_MS } = constants;
const { StorageError } = require("../../lib/file-storage/types.ts");
const locks = require("../../lib/recorded-lectures/upload-locks.ts");
const { MAX_WRITE_PIECE_BYTES } = require("../../lib/recorded-lectures/chunk-stream.ts");

H.install(test);

const GRACE = 15 * 60_000;
const ORPHAN = 48 * 3_600_000;

// ---- Helpers ---------------------------------------------------------------------------------------------------

const tempDir = () => path.join(H.storageRoot(), "System", "TemporaryUploads");
const tempFiles = () => (fs.existsSync(tempDir()) ? fs.readdirSync(tempDir()).sort() : []);
const token = () => crypto.randomBytes(32).toString("hex");

/** Sets a file's modification time to `ageMs` before the (fake) server clock. */
function age(file, ageMs) {
  const t = (state.clock - ageMs) / 1000;
  fs.utimesSync(file, t, t);
}

function writeTemp(name, ageMs, bytes = Buffer.from("x")) {
  const p = path.join(tempDir(), name);
  fs.mkdirSync(tempDir(), { recursive: true });
  fs.writeFileSync(p, bytes);
  age(p, ageMs);
  return p;
}

const run = (phases, limits) => maintenance.runRecordedLectureMaintenance({ phases, limits });
const TEMP = { expire: false, recover: false, temporary: true, finals: false };
const FINALS = { expire: false, recover: false, temporary: false, finals: true };
const EXPIRE = { expire: true, recover: false, temporary: false, finals: false };
const RECOVER = { expire: false, recover: true, temporary: false, finals: false };

/** A paused chunk writer: sends `firstBytes`, then waits for resume(). Released after each test. */
function pausedPut(uploadId, offset, bytes, firstBytes) {
  let resume;
  const resumed = new Promise((r) => (resume = r));
  let paused;
  const reachedPause = new Promise((r) => (paused = r));
  state.gates.push({ open: resume });
  let sent = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (sent >= bytes.length) return controller.close();
      if (sent === firstBytes) {
        paused();
        await resumed;
      }
      const piece = bytes.subarray(sent, sent === 0 ? firstBytes : bytes.length);
      sent += piece.length;
      controller.enqueue(piece);
    },
  }, { highWaterMark: 0 });
  const request = new Request(`http://localhost/api/recorded-lectures/uploads/${uploadId}/chunks`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "upload-offset": String(offset), "content-length": String(bytes.length) },
    body: stream,
    duplex: "half",
  });
  const route = require("../../app/api/recorded-lectures/uploads/[uploadId]/chunks/route.ts");
  const pending = route.PUT(request, { params: { uploadId } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { pending, reachedPause, resume };
}

function holdStorage(name, predicate = () => true) {
  const hold = H.gate();
  const reached = H.gate();
  state.storagePatches[name] = async (original, ...args) => {
    if (predicate(...args)) {
      reached.open();
      await hold.promise;
    }
    return original(...args);
  };
  return { hold, reached };
}

// ---- Temporary files --------------------------------------------------------------------------------------

test("temp: an uncommitted token file is deleted exactly from the 15-minute grace on; younger ones are kept", async () => {
  await H.signInAs(OWNER);
  const uploadId = (await H.createUpload(MIB)).body.data.uploadId;
  const young = writeTemp(`${uploadId}.${token()}.chunk`, GRACE - 1000);
  const old = writeTemp(`${uploadId}.${token()}.chunk`, GRACE);
  const report = await run(TEMP);
  assert.equal(report.temporary.deleted, 1);
  assert.ok(fs.existsSync(young));
  assert.ok(!fs.existsSync(old));
});

test("temp: the CURRENT lease's file is kept however old it looks; the writer then commits", async () => {
  await H.signInAs(OWNER);
  const uploadId = (await H.createUpload(MIB)).body.data.uploadId;
  const writer = pausedPut(uploadId, 0, Buffer.alloc(MIB, 4), 64 * 1024);
  await writer.reachedPause;
  const current = path.join(tempDir(), `${uploadId}.${H.sessionOf(uploadId).leaseToken}.chunk`);
  age(current, 10 * GRACE);
  const report = await run(TEMP);
  assert.equal(report.temporary.deleted, 0);
  assert.ok(fs.existsSync(current));
  writer.resume();
  assert.equal((await writer.pending).status, 200);
  assert.ok(fs.existsSync(current), "now a committed chunk");
});

test("temp: committed chunks are kept while ACTIVE / COMPLETING, deleted 15 minutes after the upload ended", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4();
  const uploadId = await H.uploadFile(file);
  for (const f of tempFiles()) age(path.join(tempDir(), f), 100 * GRACE);
  assert.equal((await run(TEMP)).temporary.deleted, 0, "ACTIVE");

  assert.equal((await H.cancel(uploadId)).status, 200);
  assert.equal((await run(TEMP)).temporary.deleted, 0, "just cancelled: within the grace after endedAt");
  state.clock += GRACE;
  const report = await run(TEMP);
  assert.equal(report.temporary.deleted, 3);
  assert.deepEqual(tempFiles(), []);
});

test("temp: committed chunks of a COMPLETING upload are kept (its completion needs them)", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4());
  const { hold, reached } = holdStorage("writeNewFile", (key) => key.endsWith(".assembly"));
  await H.complete(uploadId);
  await reached.promise;
  for (const f of tempFiles()) age(path.join(tempDir(), f), 100 * GRACE);
  assert.equal((await run(TEMP)).temporary.deleted, 0);
  hold.open();
  await completion.waitForCompletionJobs();
  assert.equal(H.recordingOf(uploadId).state, "READY");
});

test("temp: the current claim's assembly is kept; a taken-over claim's assembly is deleted after the grace", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4());
  const { hold, reached } = holdStorage("openByteSource", (key) => key.endsWith(".assembly"));
  await H.complete(uploadId);
  await reached.promise; // the assembly file exists, the job inspects it
  const claimA = H.recordingOf(uploadId).storedFileName;
  const assemblyA = H.assemblyPath(uploadId, claimA);
  age(assemblyA, 100 * GRACE);
  assert.equal((await run(TEMP)).temporary.deleted, 0, "current claim");

  // A crash: the claim goes stale and is taken over (the old job stays paused).
  state.clock += STALE_MS;
  H.asOtherProcess();
  delete state.storagePatches.openByteSource;
  await H.complete(uploadId);
  await H.until(() => H.recordingOf(uploadId).state === "READY", "takeover READY");
  age(assemblyA, GRACE);
  const report = await run(TEMP);
  assert.ok(!fs.existsSync(assemblyA), "the stale claim's assembly is gone");
  assert.ok(report.temporary.deleted >= 1);
  hold.open();
});

test("temp: unknown files, odd names, symlinks and directories are never deleted", async (t) => {
  await H.signInAs(OWNER);
  const uploadId = (await H.createUpload(MIB)).body.data.uploadId;
  const unknown = [writeTemp("notes.txt", 100 * GRACE), writeTemp(`${uploadId}.short.chunk`, 100 * GRACE), writeTemp(`${uploadId.toUpperCase()}.${token()}.chunk`, 100 * GRACE)];
  fs.mkdirSync(path.join(tempDir(), "a-directory"));
  let link = null;
  try {
    const target = writeTemp(`${uploadId}.${token()}.chunk`, 0);
    link = path.join(tempDir(), `${uploadId}.${token()}.chunk-link`);
    fs.symlinkSync(target, link, "file");
  } catch (error) {
    t.diagnostic(`symlink not created (${error.code})`);
  }
  const report = await run(TEMP);
  for (const f of unknown) assert.ok(fs.existsSync(f), f);
  assert.ok(fs.existsSync(path.join(tempDir(), "a-directory")));
  if (link) assert.ok(fs.lstatSync(link).isSymbolicLink(), "link kept");
  assert.ok(report.temporary.unknown >= 4);
});

test("temp: a legacy .part is deleted only for a finished upload, after the grace", async () => {
  await H.signInAs(OWNER);
  const active = (await H.createUpload(MIB)).body.data.uploadId;
  const ended = (await H.createUpload(MIB, { part: 2 })).body.data.uploadId;
  await H.cancel(ended);
  const a = writeTemp(`${active}.part`, 100 * GRACE);
  const b = writeTemp(`${ended}.part`, 100 * GRACE);
  await run(TEMP);
  assert.ok(fs.existsSync(a));
  assert.ok(!fs.existsSync(b));
});

test("temp: database unavailable -> nothing is deleted; the phase is reported failed and retried later", async () => {
  await H.signInAs(OWNER);
  const uploadId = (await H.createUpload(MIB)).body.data.uploadId;
  const orphan = writeTemp(`${uploadId}.${token()}.chunk`, 100 * GRACE);
  H.db().faults.down = true;
  const report = await run(TEMP);
  H.db().faults.down = false;
  assert.deepEqual(report.failedPhases, ["temporary"]);
  assert.ok(fs.existsSync(orphan));
  assert.equal((await run(TEMP)).temporary.deleted, 1, "retried by the next run");
});

test("temp: a failing deletion is counted and does not stop the others; the next run retries it", async () => {
  await H.signInAs(OWNER);
  const uploadId = (await H.createUpload(MIB)).body.data.uploadId;
  const files = [0, 1, 2].map(() => writeTemp(`${uploadId}.${token()}.chunk`, 100 * GRACE));
  const failing = path.basename(files[1]);
  state.storagePatches.remove = async (original, key) => {
    if (key.endsWith(failing)) throw new StorageError("IO_ERROR");
    return original(key);
  };
  const report = await run(TEMP);
  assert.equal(report.temporary.deleted, 2);
  assert.equal(report.temporary.errors, 1);
  assert.ok(fs.existsSync(files[1]));
  delete state.storagePatches.remove;
  assert.equal((await run(TEMP)).temporary.deleted, 1);
});

test("temp: bounded work: at most tempMaxDeletes per run; a zero time budget does nothing", async () => {
  await H.signInAs(OWNER);
  const uploadId = (await H.createUpload(MIB)).body.data.uploadId;
  for (let i = 0; i < 25; i++) writeTemp(`${uploadId}.${token()}.chunk`, 100 * GRACE);
  assert.equal((await run(TEMP, { runBudgetMs: 0 })).timedOut, true);
  assert.equal(tempFiles().length, 25);
  assert.equal((await run(TEMP, { tempMaxDeletes: 10 })).temporary.deleted, 10);
  assert.equal((await run(TEMP, { tempMaxDeletes: 10 })).temporary.deleted, 10);
  assert.equal((await run(TEMP, { tempMaxDeletes: 10, tempBatchUploads: 1 })).temporary.deleted, 5);
  assert.deepEqual(tempFiles(), []);
});

test("temp race: a chunk commit landing between the session read and the chunk read never loses the chunk", async () => {
  await H.signInAs(OWNER);
  const uploadId = (await H.createUpload(MIB)).body.data.uploadId;
  // The PUT writes its file, then waits before its commit transaction.
  const commitGate = H.gate();
  let tokenAtCommit = null;
  H.db().hooks.beforeTransaction = async () => {
    const s = H.sessionOf(uploadId);
    if (!tokenAtCommit && s.leaseToken && fs.existsSync(path.join(tempDir(), `${uploadId}.${s.leaseToken}.chunk`)) && fs.statSync(path.join(tempDir(), `${uploadId}.${s.leaseToken}.chunk`)).size === MIB) {
      tokenAtCommit = s.leaseToken;
      await commitGate.promise;
    }
  };
  const put = H.putChunk(uploadId, 0, Buffer.alloc(MIB, 9));
  await H.until(() => tokenAtCommit !== null, "file written, commit waiting");
  const file = path.join(tempDir(), `${uploadId}.${tokenAtCommit}.chunk`);
  age(file, 100 * GRACE);
  // The commit lands right AFTER the maintenance's FIRST database read of the batch, whichever
  // it is. Reading the lease first (correct) sees it current; reading the chunk rows first
  // (wrong order) would see no row, then a cleared lease: and would delete the committed file.
  let fired = false;
  const commitNow = async (where) => {
    if (fired || !(where.id?.in || where.leaseToken?.in)) return;
    fired = true;
    commitGate.open();
    await put;
  };
  H.db().hooks.afterSessionFindMany = commitNow;
  H.db().hooks.afterChunkFindMany = commitNow;
  const report = await run(TEMP);
  assert.ok(fired, "the commit happened between the maintenance's reads");
  assert.equal((await put).status, 200);
  assert.equal(report.temporary.deleted, 0);
  assert.ok(fs.existsSync(file), "the committed chunk's file survives");
  assert.equal(H.chunksOf(uploadId).length, 1);
});

// ---- Final files ---------------------------------------------------------------------------------------------

test("finals: READY kept; orphans (old claim name, missing recording, FAILED) deleted only after 48 h; folders cleaned", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4(64 * 1024);
  const readyId = await H.uploadFile(file);
  await H.complete(readyId);
  await completion.waitForCompletionJobs();
  const r = H.recordingOf(readyId);
  const readyPath = H.finalPath(readyId, r.storedFileName);
  const dir = path.dirname(readyPath);
  const oldClaim = path.join(dir, `${"1".repeat(32)}.mp4`);
  fs.writeFileSync(oldClaim, "old claim");
  const unknownInDir = path.join(dir, "readme.txt");
  fs.writeFileSync(unknownInDir, "?");
  // A folder of a recording that no longer exists.
  const ghostDir = path.join(H.storageRoot(), "Teachers", OWNER, "Lectures", LECTURE, "RecordedLectures", ids.id(999));
  fs.mkdirSync(ghostDir, { recursive: true });
  const ghost = path.join(ghostDir, `${"2".repeat(32)}.mp4`);
  fs.writeFileSync(ghost, "ghost");
  for (const p of [readyPath, oldClaim, unknownInDir, ghost]) age(p, ORPHAN - 1000);

  let report = await run(FINALS);
  assert.equal(report.finals.deleted, 0, "within the 48-hour grace");
  for (const p of [readyPath, oldClaim, ghost]) age(p, ORPHAN);
  report = await run(FINALS);
  assert.equal(report.finals.deleted, 2);
  assert.ok(fs.readFileSync(readyPath).equals(file), "the READY file is untouched");
  assert.ok(!fs.existsSync(oldClaim));
  assert.ok(!fs.existsSync(ghost));
  assert.ok(!fs.existsSync(ghostDir), "the removed recording's empty folder is gone");
  assert.ok(fs.existsSync(unknownInDir), "unknown files are never deleted");
  assert.ok(fs.existsSync(dir), "a READY recording's folder stays");
  assert.equal(report.finals.complete, true);
});

test("finals: a READY recording whose file is missing is reported, nothing is 'fixed'", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4(64 * 1024));
  await H.complete(uploadId);
  await completion.waitForCompletionJobs();
  fs.rmSync(H.finalPath(uploadId, H.recordingOf(uploadId).storedFileName));
  const report = await run(FINALS);
  assert.equal(report.finals.missingReadyFiles, 1);
  assert.equal(H.recordingOf(uploadId).state, "READY");
});

test("finals race: the file published by a claim that is not yet READY (between promote and READY) is kept", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4(64 * 1024));
  const { hold, reached } = holdStorage("syncDirectory", (key) => key.startsWith("Teachers/"));
  await H.complete(uploadId);
  await reached.promise; // promoted, READY not yet recorded
  const name = H.recordingOf(uploadId).storedFileName;
  assert.equal(H.recordingOf(uploadId).state, "VERIFYING");
  age(H.finalPath(uploadId, name), 10 * ORPHAN);
  const report = await run(FINALS);
  assert.equal(report.finals.deleted, 0);
  assert.ok(fs.existsSync(H.finalPath(uploadId, name)));
  hold.open();
  await completion.waitForCompletionJobs();
  assert.equal(H.recordingOf(uploadId).state, "READY");
});

test("finals: bounded per run; the next run resumes after the last recording folder", async () => {
  await H.signInAs(OWNER);
  const base = path.join(H.storageRoot(), "Teachers", OWNER, "Lectures", LECTURE, "RecordedLectures");
  const ghosts = [901, 902, 903].map((n) => {
    const d = path.join(base, ids.id(n));
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, `${String(n % 10).repeat(32)}.mp4`);
    fs.writeFileSync(f, "x");
    age(f, ORPHAN);
    return f;
  });
  const reports = [];
  for (let i = 0; i < 3; i++) reports.push((await run(FINALS, { finalMaxRecordingDirs: 1 })).finals);
  assert.deepEqual(reports.map((r) => r.deleted), [1, 1, 1]);
  assert.deepEqual(reports.map((r) => r.complete), [false, false, true], "the third run reaches the end of the walk");
  for (const f of ghosts) assert.ok(!fs.existsSync(f));
  const again = (await run(FINALS, { finalMaxRecordingDirs: 1 })).finals;
  assert.equal(again.deleted, 0, "the next walk starts over; nothing left");
});

test("finals: the resume position moves on even when processed folders stay (kept files)", async () => {
  await H.signInAs(OWNER);
  const base = path.join(H.storageRoot(), "Teachers", OWNER, "Lectures", LECTURE, "RecordedLectures");
  // Three recording folders that stay (an unknown file is never deleted); an orphan only in the last.
  for (const n of [911, 912, 913]) {
    const d = path.join(base, ids.id(n));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "keep.txt"), "kept");
  }
  const orphan = path.join(base, ids.id(913), `${"7".repeat(32)}.mp4`);
  fs.writeFileSync(orphan, "x");
  age(orphan, ORPHAN);
  for (let i = 0; i < 3; i++) await run(FINALS, { finalMaxRecordingDirs: 1 });
  assert.ok(!fs.existsSync(orphan), "the third run reached the third folder");
});

test("finals: a file is referenced only at its own recording's path (owner teacher and lecture)", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4(64 * 1024));
  await H.complete(uploadId);
  await completion.waitForCompletionJobs();
  const r = H.recordingOf(uploadId);
  // The same recording id and file name, but under ANOTHER teacher's folder: not the published file.
  const wrong = path.join(H.storageRoot(), "Teachers", OTHER, "Lectures", LECTURE, "RecordedLectures", r.id, r.storedFileName);
  fs.mkdirSync(path.dirname(wrong), { recursive: true });
  fs.writeFileSync(wrong, "misplaced");
  age(wrong, ORPHAN);
  await run(FINALS);
  assert.ok(!fs.existsSync(wrong), "deleted: not referenced at that path");
  assert.ok(fs.existsSync(H.finalPath(uploadId, r.storedFileName)), "the real file stays");
});

test("paths: nothing outside the feature folders is listed or deleted", async () => {
  await H.signInAs(OWNER);
  const other = path.join(H.storageRoot(), "Other");
  fs.mkdirSync(other, { recursive: true });
  const outsideFile = path.join(other, `${ids.id(1)}.${token()}.chunk`);
  fs.writeFileSync(outsideFile, "keep");
  const teacherLevel = path.join(H.storageRoot(), "Teachers", OWNER, `${"3".repeat(32)}.mp4`);
  fs.mkdirSync(path.dirname(teacherLevel), { recursive: true });
  fs.writeFileSync(teacherLevel, "keep");
  age(outsideFile, 100 * ORPHAN);
  age(teacherLevel, 100 * ORPHAN);
  await run({ expire: true, recover: true, temporary: true, finals: true });
  assert.ok(fs.existsSync(outsideFile));
  assert.ok(fs.existsSync(teacherLevel));
  assert.ok(!state.storageCalls.some((c) => typeof c.key === "string" && c.key.startsWith("Other")));
});

// ---- Expiry and capacity (both bug fixes) --------------------------------------------------------------------------

test("expiry: an ACTIVE upload past 24 h without a lease is expired by maintenance (recording FAILED)", async () => {
  await H.signInAs(OWNER);
  const uploadId = (await H.createUpload(MIB)).body.data.uploadId;
  state.clock = T0 + 24 * 3600_000;
  const report = await run(EXPIRE);
  assert.equal(report.expired, 1);
  assert.equal(H.sessionOf(uploadId).state, "EXPIRED");
  assert.equal(H.recordingOf(uploadId).failureCode, "UPLOAD_EXPIRED");
});

test("expiry with a CURRENT lease: not expired (lazy or by maintenance); its reservation still counts; expired once the lease ends", async () => {
  await H.signInAs(OWNER);
  const uploadId = (await H.createUpload(2 * MIB)).body.data.uploadId;
  state.clock = T0 + 24 * 3600_000 - 60_000; // granted one minute before the upload expires
  const writer = pausedPut(uploadId, 0, Buffer.alloc(MIB, 5), 64 * 1024);
  await writer.reachedPause;
  const leaseExpiresAt = H.sessionOf(uploadId).leaseExpiresAt.getTime();

  state.clock = T0 + 24 * 3600_000 + 1; // the upload has expired; the lease has not
  assert.equal((await run(EXPIRE)).expired, 0, "maintenance waits for the lease");
  assert.equal((await H.status(uploadId)).body.data.uploadState, "ACTIVE", "lazy expiry waits too (bug 1)");
  assert.ok(H.sessionOf(uploadId).leaseToken, "lease kept");

  // Bug 2: the writer's lease (2 x 1 MiB) still counts although the upload expired.
  state.freeBytes = 5 * 1024 * MIB + 2 * MIB + MIB - 1;
  assert.equal((await H.createUpload(MIB, { part: 2 })).status, 507, "space the writer may still use is not handed out");

  state.clock = leaseExpiresAt;
  assert.equal((await run(EXPIRE)).expired, 1);
  assert.equal(H.sessionOf(uploadId).state, "EXPIRED");
  assert.equal(H.sessionOf(uploadId).leaseToken, null);
  assert.equal((await H.createUpload(MIB, { part: 2 })).status, 201, "released only now");
  writer.resume();
  const result = await writer.pending;
  assert.equal(result.status, 408, "the writer is past its deadline and stops");
});

test("capacity: an expired upload's lease stays in the in-flight cap until it ends", async () => {
  await H.signInAs(OWNER);
  process.env.RECORDED_LECTURE_MAX_INFLIGHT_CHUNK_BYTES = String(MIB);
  try {
    const a = (await H.createUpload(MIB)).body.data.uploadId;
    const b = (await H.createUpload(MIB, { part: 2 })).body.data.uploadId;
    state.clock = T0 + 24 * 3600_000 - 60_000;
    const writer = pausedPut(a, 0, Buffer.alloc(MIB, 1), 64 * 1024);
    await writer.reachedPause;
    state.clock = T0 + 24 * 3600_000 - 30_000; // b is still valid; a's lease is current
    // b's own expiry is the same instant; grant b before it: the cap counts a's lease.
    const refused = await H.putChunk(b, 0, Buffer.alloc(MIB, 2));
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, "INFLIGHT_CHUNK_CAP");
    writer.resume();
    assert.equal((await writer.pending).status, 200);
  } finally {
    delete process.env.RECORDED_LECTURE_MAX_INFLIGHT_CHUNK_BYTES;
  }
});

// ---- Recovery ---------------------------------------------------------------------------------------------------

async function stalledCompletion() {
  const file = H.validMp4(64 * 1024);
  const uploadId = await H.uploadFile(file);
  const { hold, reached } = holdStorage("promote", (from) => from.endsWith(".assembly"));
  await H.complete(uploadId);
  await reached.promise;
  return { uploadId, file, hold, oldName: H.recordingOf(uploadId).storedFileName };
}

test("recovery (PM2 restart simulation): no teacher request; a stale claim is taken over and published; the old claim stays fenced", async () => {
  await H.signInAs(OWNER);
  const { uploadId, file, hold, oldName } = await stalledCompletion(); // the "dead" process's job
  delete state.storagePatches.promote;
  state.cookie = null; // nobody is signed in

  state.clock += STALE_MS - 1;
  H.asOtherProcess();
  assert.deepEqual((await run(RECOVER)).recovery.outcomes, {}, "not stale yet: nothing examined");
  state.clock += 1;
  const report = await run(RECOVER);
  assert.deepEqual(report.recovery.outcomes, { recovered: 1 });
  await H.until(() => H.recordingOf(uploadId).state === "READY", "recovered READY");
  const r = H.recordingOf(uploadId);
  assert.notEqual(r.storedFileName, oldName);
  assert.ok(fs.readFileSync(H.finalPath(uploadId, r.storedFileName)).equals(file));

  hold.open(); // the old job resumes: fenced
  await completion.waitForCompletionJobs();
  assert.equal(H.recordingOf(uploadId).storedFileName, r.storedFileName);
  assert.ok(!fs.existsSync(H.finalPath(uploadId, oldName)));
});

test("recovery: two workers (two processes) racing for one stale claim -> exactly one takes it", async () => {
  await H.signInAs(OWNER);
  const { uploadId, hold } = await stalledCompletion();
  delete state.storagePatches.promote;
  state.clock += STALE_MS;
  const both = H.gate();
  let arrived = 0;
  H.db().hooks.beforeSessionUpdateMany = async (where) => {
    if (!(where.state === "COMPLETING" && where.lastActivityAt) || arrived >= 2) return;
    arrived++;
    if (arrived === 2) both.open();
    await both.promise;
  };
  H.asOtherProcess();
  const first = completion.recoverStaleCompletion(uploadId);
  await H.until(() => arrived === 1, "first worker at its takeover");
  H.asOtherProcess();
  const second = completion.recoverStaleCompletion(uploadId);
  const outcomes = (await Promise.all([first, second])).sort();
  H.db().hooks.beforeSessionUpdateMany = null;
  assert.deepEqual(outcomes, ["lost-race", "recovered"]);
  await H.until(() => H.recordingOf(uploadId).state === "READY", "READY");
  hold.open();
});

test("recovery: a stale claim of a blocked teacher or removed lecture is FAILED (fenced), not resumed", async () => {
  await H.signInAs(OWNER);
  const a = await stalledCompletion();
  delete state.storagePatches.promote;
  state.clock += STALE_MS;
  H.db().teachers[0].isBlocked = true;
  H.asOtherProcess();
  assert.equal(await completion.recoverStaleCompletion(a.uploadId), "failed-ineligible");
  assert.equal(H.sessionOf(a.uploadId).state, "FAILED");
  assert.equal(H.sessionOf(a.uploadId).failureCode, "TEACHER_ACCOUNT_INACTIVE");
  assert.equal(H.recordingOf(a.uploadId).state, "FAILED");
  a.hold.open();
  await completion.waitForCompletionJobs();
  assert.equal(H.recordingOf(a.uploadId).state, "FAILED", "the old job could not publish");

  H.db().teachers[0].isBlocked = false;
  await H.signInAs(OTHER);
  const b = await (async () => {
    const file = H.validMp4(64 * 1024);
    const uploadId = await H.uploadFile(file, { lecture: LECTURE_OTHER });
    const { hold, reached } = holdStorage("promote", (from) => from.endsWith(".assembly"));
    await H.complete(uploadId);
    await reached.promise;
    return { uploadId, hold };
  })();
  delete state.storagePatches.promote;
  state.clock += STALE_MS;
  H.db().lectures.find((l) => l.id === LECTURE_OTHER).status = 1;
  H.asOtherProcess();
  assert.equal(await completion.recoverStaleCompletion(b.uploadId), "failed-ineligible");
  assert.equal(H.sessionOf(b.uploadId).failureCode, "LECTURE_NOT_ACTIVE");
  b.hold.open();
});

test("recovery backoff: after a recovery that fails temporarily, the next run waits (1 minute, then doubling)", async () => {
  await H.signInAs(OWNER);
  const { uploadId, hold } = await stalledCompletion();
  delete state.storagePatches.promote;
  state.clock += STALE_MS;
  let failures = 0;
  state.storagePatches.writeNewFile = async (original, key, ...rest) => {
    if (key.endsWith(".assembly") && failures < 2) {
      failures++;
      throw new StorageError("NO_SPACE");
    }
    return original(key, ...rest);
  };
  H.asOtherProcess();
  assert.deepEqual((await run(RECOVER)).recovery.outcomes, { recovered: 1 });
  await H.until(() => failures === 1 && H.sessionOf(uploadId).lastActivityAt.getTime() < state.clock - STALE_MS + 1, "abandoned");
  assert.deepEqual((await run(RECOVER)).recovery.outcomes, { backoff: 1 }, "immediately: backoff");
  state.clock += 60_000;
  H.asOtherProcess();
  assert.deepEqual((await run(RECOVER)).recovery.outcomes, { recovered: 1 });
  await H.until(() => failures === 2 && H.sessionOf(uploadId).lastActivityAt.getTime() < state.clock - STALE_MS + 1, "abandoned again");
  state.clock += 60_000;
  assert.deepEqual((await run(RECOVER)).recovery.outcomes, { backoff: 1 }, "doubled to 2 minutes");
  state.clock += 60_000;
  H.asOtherProcess();
  assert.deepEqual((await run(RECOVER)).recovery.outcomes, { recovered: 1 });
  await H.until(() => H.recordingOf(uploadId).state === "READY", "READY");
  hold.open();
  assert.equal(maintenance.recoveryBackoffMs(1), 60_000);
  assert.equal(maintenance.recoveryBackoffMs(7), 3_600_000);
  assert.equal(maintenance.recoveryBackoffMs(20), 3_600_000);
});

test("graceful shutdown: running claims are abandoned (made stale at once), jobs stop; the next process recovers immediately", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4(64 * 1024);
  const uploadId = await H.uploadFile(file);
  const { hold, reached } = holdStorage("openByteSource", (key) => key.endsWith(".assembly"));
  await H.complete(uploadId);
  await reached.promise;
  const claim = H.recordingOf(uploadId).storedFileName;

  assert.equal(await H.scheduler.shutdownRecordedLectureMaintenance(), 1);
  assert.ok(H.sessionOf(uploadId).lastActivityAt.getTime() <= state.clock - STALE_MS, "stale at once");
  // While shutting down nothing new starts here.
  assert.equal(await completion.recoverStaleCompletion(uploadId), "busy");
  hold.open();
  await completion.waitForCompletionJobs();
  assert.ok(!fs.existsSync(H.assemblyPath(uploadId, claim)), "the stopping job removed its own assembly");
  assert.equal(H.sessionOf(uploadId).state, "COMPLETING");

  // "The next process": no shutdown flag, a fresh mutex, no clock advance needed.
  completion.resetCompletionShutdownForTests();
  delete state.storagePatches.openByteSource;
  H.asOtherProcess();
  assert.deepEqual((await run(RECOVER)).recovery.outcomes, { recovered: 1 });
  await H.until(() => H.recordingOf(uploadId).state === "READY", "READY");
  assert.ok(fs.readFileSync(H.finalPath(uploadId, H.recordingOf(uploadId).storedFileName)).equals(file));
});

// ---- Writer and job limits (capacity bound) -------------------------------------------------------------------------

test("capacity bound: at most 32 chunk writers and 4 completion jobs per process, pieces of at most 64 KiB", () => {
  assert.equal(locks.MAX_CONCURRENT_CHUNK_WRITERS, 32);
  assert.equal(locks.MAX_CONCURRENT_COMPLETION_JOBS, 4);
  assert.equal(MAX_WRITE_PIECE_BYTES, 64 * 1024);
  const unreservedPerProcess = (locks.MAX_CONCURRENT_CHUNK_WRITERS + locks.MAX_CONCURRENT_COMPLETION_JOBS) * MAX_WRITE_PIECE_BYTES;
  assert.equal(unreservedPerProcess, 2.25 * MIB);
  assert.ok(unreservedPerProcess * 2 < 5 * 1024 * MIB / 1000, "even two overlapping processes stay far below 0.1% of the 5 GiB margin");
});

test("writer limit: a writer slot is held until the write settles, also past its deadline", async () => {
  await H.signInAs(OWNER);
  globalThis.slRecordedLectureChunkWriters = new locks.SlotLimiter(1);
  const a = (await H.createUpload(MIB)).body.data.uploadId;
  const b = (await H.createUpload(MIB, { part: 2 })).body.data.uploadId;
  const writer = pausedPut(a, 0, Buffer.alloc(MIB, 1), 64 * 1024);
  await writer.reachedPause;
  const refused = await H.putChunk(b, 0, Buffer.alloc(MIB, 2));
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, "INFLIGHT_CHUNK_CAP");
  state.clock += 400_000; // a's lease (and deadline) passed, but its writer has not settled
  assert.equal((await H.putChunk(b, 0, Buffer.alloc(MIB, 2))).status, 503, "still held");
  writer.resume();
  assert.equal((await writer.pending).status, 408);
  assert.equal((await H.putChunk(b, 0, Buffer.alloc(MIB, 2))).status, 200, "released once settled");
});

test("job limit: a fifth completion in this process is refused (503, retry) while four run", async () => {
  const file = H.validMp4(64 * 1024);
  const uploads = [];
  await H.signInAs(OWNER);
  for (const part of [1, 2, 3]) uploads.push(await H.uploadFile(file, { part }));
  await H.signInAs(OTHER);
  for (const part of [1, 2]) uploads.push({ id: await H.uploadFile(file, { lecture: LECTURE_OTHER, part }), other: true });
  const hold = H.gate();
  state.storagePatches.promote = async (original, ...args) => {
    await hold.promise;
    return original(...args);
  };
  for (const u of uploads.slice(0, 4)) {
    const id = typeof u === "string" ? u : u.id;
    await (typeof u === "string" ? H.signInAs(OWNER) : H.signInAs(OTHER));
    assert.equal((await H.complete(id)).status, 202);
  }
  await H.signInAs(OTHER);
  const fifth = await H.complete(uploads[4].id);
  assert.equal(fifth.status, 503);
  assert.equal(fifth.body.error.code, "UPLOAD_BUSY");
  assert.equal(H.sessionOf(uploads[4].id).state, "ACTIVE", "nothing claimed");
  hold.open();
  await completion.waitForCompletionJobs();
  assert.equal((await H.complete(uploads[4].id)).status, 202);
});

test("no unhandled promise rejections", () => {
  assert.deepEqual(state.unhandled, []);
});
