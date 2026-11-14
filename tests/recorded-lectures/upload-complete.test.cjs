/*
 * Recorded Lectures RL-3.4: POST /api/recorded-lectures/uploads/[uploadId]/complete
 * (asynchronous: claim + 202, then a background job) through the real routes,
 * services and LocalFileStorage (helpers/upload-harness.cjs).
 *
 *   npm run test:recorded-lectures
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const v8 = require("node:v8");
const vm = require("node:vm");

const H = require("./helpers/upload-harness.cjs");
const { state, ids, constants, completion } = H;
const { OWNER, OTHER, LECTURE } = ids;
const { T0, MIB, GIB, STALE_MS } = constants;
const { StorageError } = require("../../lib/file-storage/types.ts");

H.install(test);

const CLAIM_NAME = /^[0-9a-f]{32}\.mp4$/;

async function completeAndWait(uploadId) {
  const result = await H.complete(uploadId);
  await completion.waitForCompletionJobs();
  return result;
}

/** Patches a storage method for calls whose first key matches `predicate`; others pass through. */
function patchFor(name, predicate, handler) {
  state.storagePatches[name] = async function (original, ...args) {
    if (predicate(args[0], args)) return handler.call(this, original, ...args);
    return original(...args);
  };
}
const isAssemblyOf = (claimName) => (key) => typeof key === "string" && key.endsWith(`.${claimName.slice(0, -4)}.assembly`);

function assertFailed(uploadId, code) {
  const s = H.sessionOf(uploadId);
  const r = H.recordingOf(uploadId);
  assert.equal(s.state, "FAILED", `session ${s.state}`);
  assert.equal(s.failureCode, code);
  assert.ok(s.endedAt instanceof Date);
  assert.equal(r.state, "FAILED");
  assert.equal(r.failureCode, code);
  assert.ok(r.failedAt instanceof Date);
  assert.ok(!H.allFiles().some((f) => f.endsWith(".assembly")), "no assembly file left");
  assert.ok(!H.allFiles().some((f) => f.startsWith("Teachers/") && f.endsWith(".mp4")), "nothing published");
}

// ---- Success ----------------------------------------------------------------------------------------------

test("complete: 202 COMPLETING, then READY: verified, assembled, inspected, published; chunk files deleted", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4();
  const uploadId = await H.uploadFile(file);
  const chunkTokens = H.chunksOf(uploadId).map((c) => c.leaseToken);

  const accepted = await H.complete(uploadId);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.data.uploadState, "COMPLETING");
  assert.equal(accepted.body.data.recordingState, "VERIFYING");
  assert.equal(accepted.body.data.completionStalled, false);
  for (const key of ["storedFileName", "leaseToken", "teacherId", "version"]) assert.ok(!JSON.stringify(accepted.body).includes(`"${key}"`));
  await completion.waitForCompletionJobs();

  const polled = await H.status(uploadId);
  assert.equal(polled.body.data.uploadState, "COMPLETED");
  assert.equal(polled.body.data.recordingState, "READY");

  const r = H.recordingOf(uploadId);
  assert.match(r.storedFileName, CLAIM_NAME);
  assert.equal(r.durationSeconds, 3600);
  assert.equal(r.videoCodec, "avc1.64001F");
  assert.equal(r.audioCodec, "mp4a.40.2");
  assert.equal(r.fragmented, false);
  assert.equal(r.width, 1280);
  assert.equal(r.height, 720);
  assert.equal(r.readyAt.getTime(), T0);
  const s = H.sessionOf(uploadId);
  assert.equal(s.state, "COMPLETED");
  assert.equal(s.endedAt.getTime(), T0);

  const published = fs.readFileSync(H.finalPath(uploadId, r.storedFileName));
  assert.ok(published.equals(file), "the published file is exactly the uploaded bytes");
  assert.deepEqual(H.allFiles(), [H.keys.recordingFileKey({ teacherId: OWNER, lectureId: LECTURE, recordingId: r.id, storedName: r.storedFileName })]);
  for (const token of chunkTokens) assert.ok(!fs.existsSync(H.chunkPath(uploadId, token)), "chunk files removed after READY");

  const synced = state.storageCalls.filter((c) => c.name === "syncDirectory").map((c) => c.key);
  assert.deepEqual(synced, ["System/TemporaryUploads", H.keys.recordingDirectoryKey({ teacherId: OWNER, lectureId: LECTURE, recordingId: r.id })]);
  assert.equal(state.unhandled.length, 0);
});

// ---- Preconditions --------------------------------------------------------------------------------------

test("preconditions: auth, ownership, incomplete, blocked teacher, removed lecture, expired, completed, cancelled", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4(64 * 1024);
  const started = await H.createUpload(file.length);
  const partial = started.body.data.uploadId;
  assert.equal((await H.putChunk(partial, 0, file.subarray(0, 1000))).status, 200);

  state.cookie = null;
  assert.equal((await H.complete(partial)).status, 401);
  await H.signInAs(OTHER);
  assert.equal((await H.complete(partial)).body.error.code, "UPLOAD_NOT_FOUND");
  await H.signInAs(OWNER);
  assert.equal((await H.complete("ABCDEF00-0000-4000-8000-000000000001")).status, 404);

  const incomplete = await H.complete(partial);
  assert.equal(incomplete.status, 409);
  assert.equal(incomplete.body.error.code, "UPLOAD_INCOMPLETE");
  assert.equal(incomplete.body.error.details.receivedBytes, 1000);

  const uploadId = await H.uploadFile(file, { part: 2 });
  H.db().teachers[0].isBlocked = true;
  assert.equal((await H.complete(uploadId)).body.error.code, "TEACHER_ACCOUNT_INACTIVE");
  H.db().teachers[0].isBlocked = false;
  H.db().lectures[0].status = 1;
  assert.equal((await H.complete(uploadId)).body.error.code, "LECTURE_NOT_ACTIVE");
  H.db().lectures[0].status = 0;
  assert.equal(H.sessionOf(uploadId).state, "ACTIVE", "refusals change nothing");

  state.clock = T0 + 24 * 3600_000;
  const expired = await H.complete(uploadId);
  assert.equal(expired.status, 410);
  assert.equal(H.sessionOf(uploadId).state, "EXPIRED");

  state.clock = T0;
  const done = await H.uploadFile(file, { part: 3 });
  await completeAndWait(done);
  const again = await H.complete(done);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "UPLOAD_ALREADY_COMPLETED");

  const cancelled = await H.uploadFile(file, { part: 4 });
  assert.equal((await H.cancel(cancelled)).status, 200);
  assert.equal((await H.complete(cancelled)).body.error.code, "UPLOAD_NOT_ACTIVE");
});

// ---- Capacity ---------------------------------------------------------------------------------------------

test("capacity: the claim reserves the full size for assembly; too little space -> 507 and nothing changes", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4();
  const uploadId = await H.uploadFile(file);
  state.freeBytes = 5 * GIB + file.length - 1;
  const refused = await H.complete(uploadId);
  assert.equal(refused.status, 507);
  assert.equal(refused.body.error.code, "INSUFFICIENT_STORAGE");
  assert.equal(H.sessionOf(uploadId).state, "ACTIVE");
  assert.equal(H.recordingOf(uploadId).state, "UPLOADING");
  assert.equal(H.recordingOf(uploadId).storedFileName, null);

  state.freeBytes = 5 * GIB + file.length;
  assert.equal((await completeAndWait(uploadId)).status, 202);
  assert.equal(H.recordingOf(uploadId).state, "READY");
});

test("capacity: a COMPLETING upload's assembly reservation blocks concurrent starts and chunk grants", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4();
  const uploadId = await H.uploadFile(file);
  const other = (await H.createUpload(MIB, { part: 2 })).body.data.uploadId; // ACTIVE, nothing received

  const hold = H.gate();
  patchFor("promote", () => true, async (original, ...args) => {
    await hold.promise;
    return original(...args);
  });
  assert.equal((await H.complete(uploadId)).status, 202);
  await H.until(() => state.storageCalls.some((c) => c.name === "promote"), "the job reaches promote");

  // Room for the other upload's chunk WITHOUT the assembly reservation, not with it.
  state.freeBytes = 5 * GIB + file.length + 2 * MIB - 1;
  const grant = await H.putChunk(other, 0, Buffer.alloc(MIB));
  assert.equal(grant.status, 507, "chunk grant refused while assembly is reserved");
  const start = await H.createUpload(MIB, { part: 3 });
  assert.equal(start.status, 507, "start refused while assembly is reserved");

  hold.open();
  await completion.waitForCompletionJobs();
  assert.equal(H.recordingOf(uploadId).state, "READY");
  // The reservation ended with COMPLETED: the same free space now suffices.
  assert.equal((await H.putChunk(other, 0, Buffer.alloc(MIB))).status, 200);
});

// ---- Duplicates and concurrency ------------------------------------------------------------------------------

test("duplicate complete while the job runs -> 202 with the same claim; one job; READY once", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4());
  const hold = H.gate();
  patchFor("promote", () => true, async (original, ...args) => {
    await hold.promise;
    return original(...args);
  });
  assert.equal((await H.complete(uploadId)).status, 202);
  const claimName = H.recordingOf(uploadId).storedFileName;
  const version = H.sessionOf(uploadId).version;

  const second = await H.complete(uploadId);
  assert.equal(second.status, 202);
  assert.equal(second.body.data.uploadState, "COMPLETING");
  assert.equal(H.recordingOf(uploadId).storedFileName, claimName, "no second claim");
  assert.equal(H.sessionOf(uploadId).version, version);

  hold.open();
  await completion.waitForCompletionJobs();
  assert.equal(H.recordingOf(uploadId).state, "READY");
  assert.equal(H.recordingOf(uploadId).storedFileName, claimName);
  assert.equal(state.storageCalls.filter((c) => c.name === "promote").length, 1);
});

test("concurrent complete from two processes (both read ACTIVE) -> exactly one claim", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4());
  const arrivals = [];
  const both = H.gate();
  const first = H.gate();
  H.db().hooks.beforeAdvisoryLock = async (key) => {
    if (key !== "recorded-lectures:capacity" || arrivals.length >= 2) return;
    arrivals.push(key);
    if (arrivals.length === 1) first.open();
    if (arrivals.length === 2) both.open();
    await both.promise;
  };
  H.asOtherProcess();
  const a = H.complete(uploadId);
  await first.promise;
  H.asOtherProcess();
  const b = H.complete(uploadId);
  const results = await Promise.all([a, b]);
  H.db().hooks.beforeAdvisoryLock = null;
  await completion.waitForCompletionJobs();

  assert.equal(arrivals.length, 2);
  assert.deepEqual(results.map((r) => `${r.status}${r.body.error ? ` ${r.body.error.code}` : ""}`).sort(), ["202", "409 UPLOAD_BUSY"]);
  assert.equal(H.recordingOf(uploadId).state, "READY");
  assert.equal(state.storageCalls.filter((c) => c.name === "promote").length, 1);
});

// ---- Permanent failures ----------------------------------------------------------------------------------------

const tamper = {
  "missing chunk file": [(u) => fs.rmSync(H.chunkPath(u, H.chunksOf(u)[1].leaseToken)), "CHUNK_MISSING"],
  "chunk file one byte longer": [(u) => fs.appendFileSync(H.chunkPath(u, H.chunksOf(u)[0].leaseToken), Buffer.from([1])), "CHUNK_SIZE_MISMATCH"],
  "chunk content changed, same size": [
    (u) => {
      const p = H.chunkPath(u, H.chunksOf(u)[1].leaseToken);
      const bytes = fs.readFileSync(p);
      bytes[100] ^= 0xff;
      fs.writeFileSync(p, bytes);
    },
    "CHUNK_HASH_MISMATCH",
  ],
  "a chunk without a hash": [(u) => (H.chunksOf(u)[0].sha256 = null), "CHUNK_PLAN_INVALID"],
  "chunk order swapped": [
    (u) => {
      const [a, b] = H.chunksOf(u);
      [a.chunkIndex, b.chunkIndex] = [b.chunkIndex, a.chunkIndex];
    },
    "CHUNK_PLAN_INVALID",
  ],
  "offset gap": [(u) => (H.chunksOf(u)[1].startOffset += BigInt(1)), "CHUNK_PLAN_INVALID"],
  "offset overlap": [(u) => (H.chunksOf(u)[1].startOffset -= BigInt(1)), "CHUNK_PLAN_INVALID"],
  "a chunk record missing": [(u) => H.db().chunks.splice(H.db().chunks.indexOf(H.chunksOf(u)[2]), 1), "CHUNK_PLAN_INVALID"],
};

for (const [name, [apply, code]] of Object.entries(tamper)) {
  test(`permanent failure: ${name} -> FAILED ${code}; nothing published; chunk files kept for cleanup`, async () => {
    await H.signInAs(OWNER);
    const uploadId = await H.uploadFile(H.validMp4());
    apply(uploadId);
    const remaining = H.chunksOf(uploadId).map((c) => c.leaseToken).filter((t) => fs.existsSync(H.chunkPath(uploadId, t)));
    assert.equal((await completeAndWait(uploadId)).status, 202);
    assertFailed(uploadId, code);
    for (const t of remaining) assert.ok(fs.existsSync(H.chunkPath(uploadId, t)));
    assert.equal((await H.status(uploadId)).body.data.failureCode, code);
  });
}

test("permanent failure: not an MP4 -> FAILED MP4_NOT_MP4", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(Buffer.alloc(3 * MIB, 7));
  await completeAndWait(uploadId);
  assertFailed(uploadId, "MP4_NOT_MP4");
});

test("permanent failure: duration over 48 hours -> FAILED DURATION_INVALID", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4(2 * MIB, { moovBox: H.F.moov({ header: H.F.mvhd({ duration: 172_801_000 }) }) });
  const uploadId = await H.uploadFile(file);
  await completeAndWait(uploadId);
  assertFailed(uploadId, "DURATION_INVALID");
});

test("D5 second pass: an assembled file changed after the copy -> ASSEMBLY_HASH_MISMATCH / ASSEMBLY_SIZE_MISMATCH", async () => {
  for (const [change, code] of [
    [(p) => { const b = fs.readFileSync(p); b[MIB + 10] ^= 1; fs.writeFileSync(p, b); }, "ASSEMBLY_HASH_MISMATCH"],
    [(p) => fs.appendFileSync(p, Buffer.from([0])), "ASSEMBLY_SIZE_MISMATCH"],
  ]) {
    await H.signInAs(OWNER);
    const uploadId = await H.uploadFile(H.validMp4(), { part: code === "ASSEMBLY_HASH_MISMATCH" ? 1 : 2 });
    patchFor("writeNewFile", (key) => key.endsWith(".assembly"), async (original, key, source, options) => {
      const result = await original(key, source, options);
      change(H.storageRoot() + "/" + key);
      return result;
    });
    await completeAndWait(uploadId);
    assertFailed(uploadId, code);
    delete state.storagePatches.writeNewFile;
  }
});

test("permanent failure at READY: the lecture removed during completion -> FAILED LECTURE_NOT_ACTIVE; published file removed", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4());
  const hold = H.gate();
  patchFor("promote", () => true, async (original, ...args) => {
    await hold.promise;
    return original(...args);
  });
  await H.complete(uploadId);
  await H.until(() => state.storageCalls.some((c) => c.name === "promote"), "promote");
  H.db().lectures[0].status = 1;
  hold.open();
  await completion.waitForCompletionJobs();
  assertFailed(uploadId, "LECTURE_NOT_ACTIVE");
});

// ---- Temporary failures, crash, takeover -------------------------------------------------------------------------

test("disk full during assembly: the claim is kept (stalled), nothing published; the next complete resumes it", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4());
  let failed = false;
  patchFor("writeNewFile", (key) => key.endsWith(".assembly") && !failed, async () => {
    failed = true;
    throw new StorageError("NO_SPACE");
  });
  await completeAndWait(uploadId);
  const firstClaim = H.recordingOf(uploadId).storedFileName;
  assert.equal(H.sessionOf(uploadId).state, "COMPLETING");
  assert.equal(H.recordingOf(uploadId).state, "VERIFYING");
  assert.equal(H.sessionOf(uploadId).lastActivityAt.getTime(), T0 - STALE_MS, "made stale for an immediate retry");
  const polled = (await H.status(uploadId)).body.data;
  assert.equal(polled.uploadState, "COMPLETING");
  assert.equal(polled.completionStalled, true);
  assert.ok(!H.allFiles().some((f) => f.endsWith(".assembly")));

  const resumed = await completeAndWait(uploadId);
  assert.equal(resumed.status, 202);
  const r = H.recordingOf(uploadId);
  assert.equal(r.state, "READY");
  assert.notEqual(r.storedFileName, firstClaim, "the retry is a new claim with its own file name");
  assert.equal(state.unhandled.length, 0);
});

test("crash mid-assembly: a stuck job cannot block; after 10 minutes another process takes over; the old job then stops", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4();
  const uploadId = await H.uploadFile(file);
  const stuck = H.gate();
  let stuckClaim = null;
  patchFor("writeNewFile", (key) => key.endsWith(".assembly"), async function (original, key, source, options) {
    if (stuckClaim === null) {
      stuckClaim = key;
      async function* thenStall() {
        let sent = 0;
        for await (const piece of source) {
          yield piece;
          sent += piece.byteLength;
          if (sent >= MIB) {
            await stuck.promise; // the "dead" process
          }
        }
      }
      return original(key, thenStall(), options);
    }
    return original(key, source, options);
  });
  assert.equal((await H.complete(uploadId)).status, 202);
  const oldName = H.recordingOf(uploadId).storedFileName;
  await H.until(() => fs.existsSync(H.assemblyPath(uploadId, oldName)) && fs.statSync(H.assemblyPath(uploadId, oldName)).size >= MIB, "partial assembly");

  // Before the claim is stale: another complete only reports the status.
  H.asOtherProcess();
  state.clock = T0 + STALE_MS - 1;
  assert.equal((await H.complete(uploadId)).body.data.uploadState, "COMPLETING");
  assert.equal(H.recordingOf(uploadId).storedFileName, oldName);

  // Stale: taken over by a new claim, which publishes.
  state.clock = T0 + STALE_MS;
  assert.equal((await H.complete(uploadId)).status, 202);
  const newName = H.recordingOf(uploadId).storedFileName;
  assert.notEqual(newName, oldName);
  await H.until(() => H.recordingOf(uploadId).state === "READY", "the new claim reaches READY");

  // The old job resumes: its heartbeat fails (claim lost), it stops and removes only its own file.
  stuck.open();
  await completion.waitForCompletionJobs();
  const r = H.recordingOf(uploadId);
  assert.equal(r.state, "READY");
  assert.equal(r.storedFileName, newName);
  assert.ok(fs.readFileSync(H.finalPath(uploadId, newName)).equals(file));
  assert.ok(!fs.existsSync(H.assemblyPath(uploadId, oldName)), "the stale job removed its own assembly");
  assert.ok(!state.storageCalls.some((c) => c.name === "promote" && c.key.includes(oldName.slice(0, -4))), "the stale job never published");
  assert.equal(state.unhandled.length, 0);
});

test("stale publish: an old claim paused before promote, taken over; it then cannot mark READY nor touch the new file", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4();
  const uploadId = await H.uploadFile(file);
  const hold = H.gate();
  let heldName = null;
  patchFor("promote", (key) => heldName === null || key.includes(heldName), async (original, from, to) => {
    if (heldName === null) heldName = from.split(".")[1];
    if (from.includes(heldName)) await hold.promise;
    return original(from, to);
  });
  await H.complete(uploadId);
  await H.until(() => heldName !== null, "the old claim reaches promote");
  const oldName = `${heldName}.mp4`;

  state.clock = T0 + STALE_MS;
  H.asOtherProcess();
  await H.complete(uploadId);
  await H.until(() => H.recordingOf(uploadId).state === "READY", "new claim READY");
  const newName = H.recordingOf(uploadId).storedFileName;
  const versionAfterNew = H.sessionOf(uploadId).version;
  const newFile = fs.readFileSync(H.finalPath(uploadId, newName));

  hold.open();
  await completion.waitForCompletionJobs();
  const r = H.recordingOf(uploadId);
  assert.equal(r.state, "READY");
  assert.equal(r.storedFileName, newName, "the stale claim did not mark itself READY");
  assert.equal(H.sessionOf(uploadId).version, versionAfterNew, "no transition by the stale claim");
  assert.ok(fs.readFileSync(H.finalPath(uploadId, newName)).equals(newFile), "the new file is untouched");
  assert.ok(!fs.existsSync(H.finalPath(uploadId, oldName)), "the stale claim removed only its own published file");
  assert.ok(newFile.equals(file));
});

test("stale failure: an old claim that later finds the file bad cannot mark the newer claim FAILED", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4());
  const hold = H.gate();
  let heldKey = null;
  patchFor("openByteSource", (key) => key.endsWith(".assembly") && (heldKey === null || key === heldKey), async (original, key) => {
    heldKey = key;
    await hold.promise;
    fs.writeFileSync(H.storageRoot() + "/" + key, Buffer.alloc(fs.statSync(H.storageRoot() + "/" + key).size)); // the old claim sees garbage
    return original(key);
  });
  await H.complete(uploadId);
  await H.until(() => heldKey !== null, "old claim at inspection");

  state.clock = T0 + STALE_MS;
  H.asOtherProcess();
  await H.complete(uploadId);
  await H.until(() => H.recordingOf(uploadId).state === "READY", "new claim READY");
  hold.open();
  await completion.waitForCompletionJobs();
  assert.equal(H.recordingOf(uploadId).state, "READY");
  assert.equal(H.sessionOf(uploadId).state, "COMPLETED");
  assert.ok(!fs.existsSync(H.storageRoot() + "/" + heldKey), "the old claim removed its own assembly only");
});

test("two live claims: a stale claim resumes while the newer claim is still COMPLETING -> its heartbeat fails; it never publishes or transitions", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4();
  const uploadId = await H.uploadFile(file);

  // Claim A pauses inside its MP4 inspection (after its last heartbeat check).
  const holdA = H.gate();
  let aKey = null;
  const holdB = H.gate();
  state.storagePatches.openByteSource = async (original, key) => {
    if (aKey === null && key.endsWith(".assembly")) {
      aKey = key;
      await holdA.promise;
    }
    return original(key);
  };
  await H.complete(uploadId);
  await H.until(() => aKey !== null, "claim A at inspection");
  const nameA = H.recordingOf(uploadId).storedFileName;

  // Claim B takes over and pauses before publishing; chunk files still exist.
  state.storagePatches.promote = async (original, from, to) => {
    if (!from.includes(nameA.slice(0, -4))) await holdB.promise;
    return original(from, to);
  };
  state.clock = T0 + STALE_MS;
  H.asOtherProcess();
  assert.equal((await H.complete(uploadId)).status, 202);
  const nameB = H.recordingOf(uploadId).storedFileName;
  const versionB = H.sessionOf(uploadId).version;
  await H.until(() => state.storageCalls.some((c) => c.name === "promote" && c.key.includes(nameB.slice(0, -4))), "claim B at promote");

  // A resumes: its confirming heartbeat is conditional on its claim and fails.
  holdA.open();
  await H.until(() => !fs.existsSync(H.storageRoot() + "/" + aKey), "claim A stopped and removed its own assembly");
  assert.ok(!state.storageCalls.some((c) => c.name === "promote" && c.key.includes(nameA.slice(0, -4))), "A never published");
  assert.equal(H.sessionOf(uploadId).state, "COMPLETING");
  assert.equal(H.sessionOf(uploadId).version, versionB, "A changed nothing");
  assert.equal(H.recordingOf(uploadId).state, "VERIFYING");
  assert.equal(H.recordingOf(uploadId).storedFileName, nameB);

  holdB.open();
  await completion.waitForCompletionJobs();
  const r = H.recordingOf(uploadId);
  assert.equal(r.state, "READY");
  assert.equal(r.storedFileName, nameB);
  assert.ok(fs.readFileSync(H.finalPath(uploadId, nameB)).equals(file));
  assert.ok(!fs.existsSync(H.finalPath(uploadId, nameA)));
});

test("takeover race: a heartbeat between the takeover's read and its update prevents the takeover", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4());
  const hold = H.gate();
  state.storagePatches.promote = async (original, ...args) => {
    await hold.promise;
    return original(...args);
  };
  await H.complete(uploadId);
  await H.until(() => state.storageCalls.some((c) => c.name === "promote"), "job at promote");
  const nameA = H.recordingOf(uploadId).storedFileName;

  state.clock = T0 + STALE_MS; // stale when the takeover reads the session...
  H.db().hooks.beforeSessionUpdateMany = async (where) => {
    if (where.lastActivityAt && where.state === "COMPLETING") {
      H.db().hooks.beforeSessionUpdateMany = null;
      H.sessionOf(uploadId).lastActivityAt = new Date(state.clock); // ...but the old job beats just before the update
    }
  };
  H.asOtherProcess();
  const result = await H.complete(uploadId);
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "UPLOAD_BUSY");
  assert.equal(H.recordingOf(uploadId).storedFileName, nameA, "no takeover (rolled back)");

  hold.open();
  await completion.waitForCompletionJobs();
  assert.equal(H.recordingOf(uploadId).state, "READY");
  assert.equal(H.recordingOf(uploadId).storedFileName, nameA);
});

// ---- The READY transition and ambiguous commits ------------------------------------------------------------------

test("READY commit ambiguous but committed -> READY kept; chunk files deleted", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4());
  let faulted = false;
  H.db().faults.commit = () => {
    if (!faulted && H.recordingOf(uploadId).state === "READY") {
      faulted = true;
      return "commit-then-throw";
    }
    return null;
  };
  await completeAndWait(uploadId);
  assert.ok(faulted);
  const r = H.recordingOf(uploadId);
  assert.equal(r.state, "READY");
  assert.ok(fs.existsSync(H.finalPath(uploadId, r.storedFileName)));
  assert.equal(H.allFiles().filter((f) => f.endsWith(".chunk")).length, 0);
});

test("READY commit ambiguous and NOT committed -> re-read shows the claim, one retry, READY", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4());
  let faulted = false;
  H.db().faults.commit = () => {
    if (!faulted && H.recordingOf(uploadId).state === "READY") {
      faulted = true;
      return "rollback-then-throw";
    }
    return null;
  };
  await completeAndWait(uploadId);
  assert.ok(faulted);
  assert.equal(H.recordingOf(uploadId).state, "READY");
});

test("READY outcome unknown (database down): every file is kept; later a takeover publishes under a new name", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4();
  const uploadId = await H.uploadFile(file);
  let faulted = false;
  H.db().faults.commit = () => {
    if (!faulted && H.recordingOf(uploadId).state === "READY") {
      faulted = true;
      H.db().faults.down = true;
      return "rollback-then-throw";
    }
    return null;
  };
  await completeAndWait(uploadId);
  assert.ok(faulted);
  H.db().faults.down = false;
  const oldName = H.recordingOf(uploadId).storedFileName;
  assert.equal(H.sessionOf(uploadId).state, "COMPLETING");
  assert.equal(H.recordingOf(uploadId).state, "VERIFYING");
  assert.ok(fs.existsSync(H.finalPath(uploadId, oldName)), "the possibly-published file is kept");
  assert.ok(H.chunksOf(uploadId).every((c) => fs.existsSync(H.chunkPath(uploadId, c.leaseToken))), "chunks kept");

  state.clock = T0 + STALE_MS;
  await completeAndWait(uploadId);
  const r = H.recordingOf(uploadId);
  assert.equal(r.state, "READY");
  assert.notEqual(r.storedFileName, oldName);
  assert.ok(fs.readFileSync(H.finalPath(uploadId, r.storedFileName)).equals(file));
  assert.ok(fs.existsSync(H.finalPath(uploadId, oldName)), "the old claim's file is an orphan for RL-3.5 cleanup");
});

test("the claim transaction ambiguous but committed -> the request still answers 202 and the job runs", async () => {
  await H.signInAs(OWNER);
  const uploadId = await H.uploadFile(H.validMp4());
  let faulted = false;
  H.db().faults.commit = () => {
    if (!faulted && H.sessionOf(uploadId).state === "COMPLETING") {
      faulted = true;
      return "commit-then-throw";
    }
    return null;
  };
  const result = await completeAndWait(uploadId);
  assert.ok(faulted);
  assert.equal(result.status, 202);
  assert.equal(H.recordingOf(uploadId).state, "READY");
});

// ---- Memory ---------------------------------------------------------------------------------------------------

test("memory: assembling and verifying a 64 MiB upload uses bounded memory", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4(64 * MIB);
  const uploadId = await H.uploadFile(file);
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc");
  gc();
  const baseline = process.memoryUsage().arrayBuffers;
  let peak = 0;
  let pieces = 0;
  patchFor("writeNewFile", (key) => key.endsWith(".assembly"), async (original, key, source, options) => {
    async function* sampled() {
      for await (const piece of source) {
        if (++pieces % 64 === 0) {
          gc();
          peak = Math.max(peak, process.memoryUsage().arrayBuffers - baseline);
        }
        yield piece;
      }
    }
    return original(key, sampled(), options);
  });
  await completeAndWait(uploadId);
  assert.equal(H.recordingOf(uploadId).state, "READY");
  console.log(`# memory: assembling ${(file.length / MIB).toFixed(1)} MiB in ${pieces} pieces, peak arrayBuffers growth ${(peak / MIB).toFixed(2)} MiB`);
  assert.ok(pieces > 64);
  assert.ok(peak < 16 * MIB, `peak ${peak}`);
});

test("no unhandled promise rejections in any of the above", () => {
  assert.deepEqual(state.unhandled, []);
});
