/*
 * Teacher storage quota, Stage 3.3: Recorded Lectures upload starts are
 * checked against the teacher's quota, sharing one quota (and one lock) with
 * Notes / submission reservations.
 *
 *   npm run test:storage-quota
 *
 * The REAL Recorded Lectures routes and services (start, chunks, complete,
 * cancel, the completion job, MP4 inspection, LocalFileStorage on a temporary
 * FILE_STORAGE_ROOT) run through tests/recorded-lectures/helpers/upload-harness.cjs.
 * The database is that harness's in-memory FAKE (FIFO advisory locks held to
 * the end of the transaction, rollback, interleaving, the RL CHECKs; Stage 3.3
 * added the quota models). It is NOT PostgreSQL: real locking is
 * tests/storage-quota/enforcement.db.test.cjs (skipped without a local test database).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const H = require("../recorded-lectures/helpers/upload-harness.cjs");

const { state, completion } = H;
const { OWNER, OTHER, LECTURE, LECTURE_2, LECTURE_OTHER } = H.ids;
const { MIB, GIB } = H.constants;
const root = path.resolve(__dirname, "..", "..");
const { getTeacherStorageUsage } = require(path.join(root, "services", "teacher-storage-usage-service.ts"));
const R = require(path.join(root, "services", "storage-reservation-service.ts"));
const NK = require(path.join(root, "lib", "notes", "storage-keys.ts"));
const SK = require(path.join(root, "lib", "assignments", "submission-keys.ts"));

H.install(test);

const B = (n) => BigInt(n);
const db = () => H.db();
const limit = (teacherId, bytes) => db().storageLimits.push({ teacherId, limitBytes: B(bytes) });
const plan = (teacherId, storageGB, { status = "ACTIVE", endDate = null, updatedAt = new Date("2026-01-01") } = {}) =>
  db().subscriptions.push({ teacherId, status, endDate, updatedAt, plan: { storageGB } });
const usage = (teacherId = OWNER) => getTeacherStorageUsage(teacherId);
const start = (sizeBytes, part = 1, lecture = LECTURE) => H.createUpload(sizeBytes, { part, lecture });

// ==== Boundaries and limits =================================================================================

test("RL start: the exact boundary fits; one byte over is 413 STORAGE_QUOTA_EXCEEDED with the figures; nothing is created", async () => {
  await H.signInAs(OWNER);
  db().quotaNotesBytes.set(OWNER, B(1000)); // 1000 committed bytes of Notes
  limit(OWNER, 1000 + 5 * MIB);
  const over = await start(5 * MIB + 1);
  assert.equal(over.status, 413);
  assert.equal(over.body.error.code, "STORAGE_QUOTA_EXCEEDED");
  assert.deepEqual(over.body.error.details, {
    limitBytes: String(1000 + 5 * MIB),
    usedBytes: "1000",
    reservedBytes: "0",
    requestedBytes: String(5 * MIB + 1),
    remainingBytes: String(5 * MIB),
  });
  assert.equal(db().sessions.length, 0, "no session, no recording");
  assert.equal(db().recordings.length, 0);

  const exact = await start(5 * MIB);
  assert.equal(exact.status, 201);
  const u = await usage();
  assert.equal(u.reserved.recordedLectures, B(5 * MIB), "the session reserves its declared size");
  assert.equal(u.remainingBytes, B(0));
  assert.equal(db().reservations.length, 0, "no StorageReservation row for recordings");
});

test("RL start: unlimited teacher; individual override; active plan limit; cancelled / expired / suspended / ended plans supply nothing", async () => {
  await H.signInAs(OWNER);
  assert.equal((await start(3 * GIB, 1)).status, 201, "no limit at all: unlimited");

  plan(OWNER, 1); // 1 GB = 10^9 bytes, active; 3 GiB already reserved
  const overPlan = await start(MIB, 2);
  assert.equal(overPlan.status, 413);
  assert.equal(overPlan.body.error.details.limitBytes, "1000000000");

  for (const status of ["CANCELLED", "EXPIRED", "SUSPENDED"]) {
    db().subscriptions.length = 0;
    plan(OWNER, 1, { status });
    assert.equal((await start(MIB, 2)).status, 201, `${status}: no plan limit`);
    await H.cancel(db().sessions.find((s) => s.state === "ACTIVE" && s.expectedBytes === B(MIB)).id);
  }
  db().subscriptions.length = 0;
  plan(OWNER, 1, { endDate: new Date(state.clock - 1) });
  assert.equal((await start(MIB, 2)).status, 201, "an ACTIVE plan past its endDate supplies nothing");
  await H.cancel(db().sessions.find((s) => s.state === "ACTIVE" && s.expectedBytes === B(MIB)).id);

  db().subscriptions.length = 0;
  plan(OWNER, null, { status: "SUSPENDED" });
  limit(OWNER, 3 * GIB); // the override applies regardless of the subscription (3 GiB reserved already)
  const overOverride = await start(1, 2);
  assert.equal(overOverride.status, 413);
  assert.equal(overOverride.body.error.details.limitBytes, String(3 * GIB));
});

// ==== Existing protections are unchanged ============================================================================

test("RL start: the three-active-upload limit, global disk capacity (507) and the lecture checks still apply", async () => {
  await H.signInAs(OWNER);
  for (const part of [1, 2, 3]) assert.equal((await start(MIB, part)).status, 201);
  const fourth = await start(MIB, 4);
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error.code, "TOO_MANY_ACTIVE_UPLOADS");

  for (const s of db().sessions) await H.cancel(s.id);
  state.freeBytes = 5 * GIB + MIB; // under the 5 GiB minimum free space once 2 MiB are reserved
  const disk = await start(2 * MIB, 5);
  assert.equal(disk.status, 507, "the server's disk: 507, not the quota");
  assert.equal(disk.body.error.code, "INSUFFICIENT_STORAGE");

  limit(OWNER, MIB);
  const both = await start(2 * MIB, 5);
  assert.equal(both.status, 413, "over the quota AND short of disk: the quota is decided first (no disk work)");

  await H.signInAs(OTHER);
  assert.equal((await start(MIB, 1, LECTURE)).status, 404, "another teacher's lecture: the existing 404");
});

test("RL start: the lock order is teacher upload lock -> storage quota lock -> capacity lock, in one transaction", async () => {
  await H.signInAs(OWNER);
  assert.equal((await start(MIB)).status, 201);
  const locked = db().log.filter((e) => e.kind === "locked");
  const tx = locked[0].tx;
  assert.deepEqual(
    locked.filter((e) => e.tx === tx).map((e) => e.key.split(":").slice(0, 2).join(":")),
    ["recorded-lectures:teacher", "storage-quota:teacher", "recorded-lectures:capacity"]
  );
});

test("RL start: a quota lock timeout is 503 STORAGE_QUOTA_BUSY; a Recorded Lectures lock timeout stays 503 UPLOAD_BUSY", async () => {
  await H.signInAs(OWNER);
  db().faults.lockTimeout = (key) => key.startsWith("storage-quota:");
  const quotaBusy = await start(MIB);
  assert.equal(quotaBusy.status, 503);
  assert.equal(quotaBusy.body.error.code, "STORAGE_QUOTA_BUSY");
  db().faults.lockTimeout = (key) => key.startsWith("recorded-lectures:teacher");
  const rlBusy = await start(MIB);
  assert.equal(rlBusy.status, 503);
  assert.equal(rlBusy.body.error.code, "UPLOAD_BUSY");
  db().faults.lockTimeout = () => false;
  assert.equal(db().sessions.length, 0, "nothing was created by either");
});

// ==== Concurrency ==================================================================================================

test("RL start: three simultaneous starts with room for two -> exactly two sessions", async () => {
  await H.signInAs(OWNER);
  limit(OWNER, 2 * 4 * MIB + 3 * MIB);
  const results = await Promise.all([1, 2, 3].map((part) => start(4 * MIB, part)));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 201, 413]);
  assert.equal(db().sessions.length, 2);
  assert.ok((await usage()).totalUsedAndReservedBytes <= B(2 * 4 * MIB + 3 * MIB));
});

const noteKey = () => NK.noteFileKey({ teacherId: OWNER, lectureId: LECTURE, noteId: crypto.randomUUID(), storedName: NK.generateNoteStoredName("application/pdf") });
const subKey = () => SK.submissionFileKey({ teacherId: OWNER, lectureId: LECTURE, assignmentId: crypto.randomUUID(), submissionId: crypto.randomUUID(), storedName: SK.generateSubmissionStoredName() });

test("Recorded Lectures, Notes and submissions share ONE quota: of six simultaneous requests of 1 MiB with room for three, exactly three succeed", async () => {
  await H.signInAs(OWNER);
  limit(OWNER, 3 * MIB);
  const outcomes = await Promise.allSettled([
    start(MIB, 1),
    R.reserveTeacherStorage({ teacherId: OWNER, category: "NOTE", storageKey: noteKey(), bytes: B(MIB), audience: "TEACHER" }),
    start(MIB, 2),
    R.reserveTeacherStorage({ teacherId: OWNER, category: "SUBMISSION", storageKey: subKey(), bytes: B(MIB), audience: "STUDENT" }),
    start(MIB, 3, LECTURE_2),
    R.reserveTeacherStorage({ teacherId: OWNER, category: "NOTE", storageKey: noteKey(), bytes: B(MIB), audience: "TEACHER" }),
  ]);
  const ok = outcomes.filter((o) => (o.status === "fulfilled" && (o.value.status === undefined || o.value.status === 201)));
  const refused = outcomes.filter((o) => (o.status === "rejected" && o.reason.code === "STORAGE_QUOTA_EXCEEDED") || (o.status === "fulfilled" && o.value.status === 413));
  assert.equal(ok.length, 3, JSON.stringify(outcomes.map((o) => o.status === "fulfilled" ? o.value.status ?? "reserved" : o.reason.code)));
  assert.equal(refused.length, 3);
  const u = await usage();
  assert.equal(u.totalUsedAndReservedBytes, B(3 * MIB), "exactly the limit, never more");
  assert.equal(u.reserved.recordedLectures + u.reserved.notes + u.reserved.submissions, B(3 * MIB));
});

test("two teachers are independent: one at its limit, the other starts a recording at the same time", async () => {
  limit(OWNER, 0);
  await H.signInAs(OTHER); // the recording start is OTHER's; OWNER's request goes through the service (no cookie)
  const [ownerNote, otherStart] = await Promise.allSettled([
    R.reserveTeacherStorage({ teacherId: OWNER, category: "NOTE", storageKey: noteKey(), bytes: B(MIB), audience: "TEACHER" }),
    start(MIB, 1, LECTURE_OTHER),
  ]);
  assert.equal(ownerNote.status, "rejected");
  assert.equal(ownerNote.reason.code, "STORAGE_QUOTA_EXCEEDED");
  assert.equal(otherStart.value.status, 201);
  assert.equal((await usage(OTHER)).reserved.recordedLectures, B(MIB));
  assert.equal((await usage(OWNER)).totalUsedAndReservedBytes, B(0));
});

// ==== Reservation lifecycle ==========================================================================================

test("cancelling releases the reservation: the space is usable again at once", async () => {
  await H.signInAs(OWNER);
  limit(OWNER, 3 * MIB);
  const first = await start(3 * MIB, 1);
  assert.equal(first.status, 201);
  assert.equal((await start(MIB, 2)).status, 413);
  assert.equal((await H.cancel(first.body.data.uploadId)).status, 200);
  assert.equal((await usage()).reserved.recordedLectures, B(0));
  assert.equal((await start(3 * MIB, 2)).status, 201);
});

test("expiry releases the reservation (database time); an expired session with a CURRENT lease still reserves received + lease", async () => {
  await H.signInAs(OWNER);
  limit(OWNER, 3 * MIB);
  const first = await start(3 * MIB, 1);
  const session = H.sessionOf(first.body.data.uploadId);

  // Past the upload expiry while a chunk lease is current: only received + lease.
  state.clock = session.expiresAt.getTime() + 1;
  Object.assign(session, {
    leaseToken: "a".repeat(64), leaseOffset: B(0), leaseBytes: MIB, leaseGrantedAt: new Date(state.clock - 1000), leaseExpiresAt: new Date(state.clock + 60_000),
  });
  assert.equal((await usage()).reserved.recordedLectures, B(MIB));

  // The lease ends: nothing is reserved any more, and a new start is accepted (it expires the old upload first).
  Object.assign(session, { leaseToken: null, leaseOffset: null, leaseBytes: null, leaseGrantedAt: null, leaseExpiresAt: null });
  assert.equal((await usage()).reserved.recordedLectures, B(0));
  assert.equal((await start(3 * MIB, 2)).status, 201);
  assert.equal(H.sessionOf(first.body.data.uploadId).state, "EXPIRED");
});

test("COMPLETING keeps reserving the declared size; READY converts it into committed storage exactly once (never both)", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4();
  limit(OWNER, file.length);
  const uploadId = await H.uploadFile(file);
  assert.deepEqual([(await usage()).reserved.recordedLectures, (await usage()).committed.recordedLectures], [B(file.length), B(0)]);

  const hold = H.gate();
  state.storagePatches.promote = async (original, ...args) => {
    await hold.promise;
    return original(...args);
  };
  assert.equal((await H.complete(uploadId)).status, 202);
  await H.until(() => state.storageCalls.some((c) => c.name === "promote"), "the job reaches promote");
  assert.equal(H.sessionOf(uploadId).state, "COMPLETING");
  let u = await usage();
  assert.deepEqual([u.reserved.recordedLectures, u.committed.recordedLectures], [B(file.length), B(0)], "COMPLETING: still reserved");
  assert.equal((await start(1, 2)).status, 413, "the full quota is still taken while verifying");

  hold.open();
  await completion.waitForCompletionJobs();
  assert.equal(H.recordingOf(uploadId).state, "READY");
  u = await usage();
  assert.deepEqual([u.reserved.recordedLectures, u.committed.recordedLectures], [B(0), B(file.length)], "READY: committed, no longer reserved");
  assert.equal(u.totalUsedAndReservedBytes, B(file.length), "counted once");
});

test("a failed completion releases the reservation; nothing is committed", async () => {
  await H.signInAs(OWNER);
  const notMp4 = Buffer.alloc(2 * MIB, 0x41);
  limit(OWNER, notMp4.length);
  const uploadId = await H.uploadFile(notMp4);
  assert.equal((await H.complete(uploadId)).status, 202);
  await completion.waitForCompletionJobs();
  assert.equal(H.recordingOf(uploadId).state, "FAILED");
  const u = await usage();
  assert.equal(u.totalUsedAndReservedBytes, B(0));
  assert.equal((await start(notMp4.length, 2)).status, 201, "the whole quota is available again");
});

test("no duplicate accounting: one recording is only ever its session's reservation OR its READY size", async () => {
  await H.signInAs(OWNER);
  const file = H.validMp4();
  const uploadId = await H.uploadFile(file);
  const sizes = [];
  const sample = async () => {
    const u = await usage();
    sizes.push(u.totalUsedAndReservedBytes);
  };
  await sample(); // ACTIVE
  await H.complete(uploadId);
  await sample(); // COMPLETING (or later)
  await completion.waitForCompletionJobs();
  await sample(); // READY
  assert.deepEqual(sizes, [B(file.length), B(file.length), B(file.length)]);
  assert.equal(db().reservations.length, 0);
});

// ==== Source guard ==================================================================================================

test("source: startRecordingUpload checks the quota after the active-upload cap and before the capacity lock; nothing else changed", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(root, "services", "recorded-lecture-upload-service.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const fn = src.slice(src.indexOf("export async function startRecordingUpload"), src.indexOf("export async function getRecordingUploadStatus"));
  const at = (needle) => {
    const i = fn.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };
  assert.ok(at("await lockTeacherUploads(tx, teacherId);") < at('uploadError("TOO_MANY_ACTIVE_UPLOADS")'));
  assert.ok(at('uploadError("TOO_MANY_ACTIVE_UPLOADS")') < at("await lockTeacherStorageQuota(tx, teacherId);"));
  assert.ok(at("await lockTeacherStorageQuota(tx, teacherId);") < at("await getTeacherStorageUsage(teacherId, { db: tx, now });"));
  assert.ok(at("fitsWithinStorageLimit(usage, sizeBytes)") < at("await lockUploadCapacity(tx);"));
  assert.ok(at("await lockUploadCapacity(tx);") < at("tx.recordedLecture.create("));
  assert.doesNotMatch(fn, /storageReservation/, "recordings never create StorageReservation rows");
  for (const file of ["recorded-lecture-chunk-service.ts", "recorded-lecture-completion-service.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, "services", file), "utf8"), /storage-quota|StorageQuota|teacher-storage-usage/, `${file} is unchanged by the quota`);
  }
});
