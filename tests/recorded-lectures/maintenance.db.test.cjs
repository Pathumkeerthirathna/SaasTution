/*
 * Recorded Lectures RL-3.5 against a REAL, THROWAWAY PostgreSQL: the
 * conditions and constraints the in-memory fake can only imitate (OR
 * conditions, the RL-2 CHECKs on the expiry / FAILED transitions, row locks
 * between two concurrent recovery workers, READ COMMITTED visibility).
 *
 *   RECORDED_LECTURES_TEST_DATABASE_URL=postgresql://user@127.0.0.1:5432/rl_test npm run test:recorded-lectures-db
 *
 * The database must already contain the schema including migration
 * 20261114120000_add_recorded_lectures. Safety: the whole file is SKIPPED
 * unless RECORDED_LECTURES_TEST_DATABASE_URL is set, and it refuses any host
 * other than localhost / 127.0.0.1 and any database whose name does not
 * contain "test". DATABASE_URL is overwritten before Prisma loads, so the
 * project's .env database is never used. NEVER point it at Neon or production.
 * Every row it creates uses ids from this run and is deleted afterwards.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const url = process.env.RECORDED_LECTURES_TEST_DATABASE_URL;
let skip = "set RECORDED_LECTURES_TEST_DATABASE_URL to a throwaway LOCAL database to run these tests";
if (url) {
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("Refusing to run: RECORDED_LECTURES_TEST_DATABASE_URL must point at localhost.");
  }
  if (!/test/i.test(dbName)) throw new Error('Refusing to run: the database name must contain "test".');
  skip = false;
  process.env.DATABASE_URL = url;
}

const root = path.resolve(__dirname, "..", "..");
let prisma;
let upload;
let maintenance;
let completion;
let storageRoot;

const uuid = () => crypto.randomUUID();
const created = { teachers: [], classes: [], lectures: [] };

async function fixture() {
  const teacherId = uuid();
  const classId = uuid();
  const lectureId = uuid();
  await prisma.teacher.create({
    data: { id: teacherId, name: "RL test", email: `${teacherId}@example.test`, password: "x", isConfirmed: true, emailConfirmed: true },
  });
  await prisma.class.create({ data: { id: classId, name: "RL test", teacherId } });
  await prisma.lecture.create({ data: { id: lectureId, title: "RL test", date: new Date(), classId } });
  created.teachers.push(teacherId);
  created.classes.push(classId);
  created.lectures.push(lectureId);
  return { teacherId, classId, lectureId };
}

async function session(f, overrides = {}, recordingOverrides = {}) {
  const now = new Date();
  const recordingId = uuid();
  await prisma.recordedLecture.create({
    data: {
      id: recordingId, lectureId: f.lectureId, classId: f.classId, teacherId: f.teacherId, title: "t", partNumber: Math.floor(Math.random() * 1e6) + 1,
      displayFileName: "x.mp4", mimeType: "video/mp4", sizeBytes: BigInt(2 * 1024 * 1024), state: "UPLOADING", createdAt: now, updatedAt: now, ...recordingOverrides,
    },
  });
  const id = uuid();
  await prisma.recordingUploadSession.create({
    data: {
      id, recordedLectureId: recordingId, teacherId: f.teacherId, expectedBytes: BigInt(2 * 1024 * 1024), state: "ACTIVE",
      expiresAt: new Date(now.getTime() + 60_000), lastActivityAt: now, createdAt: new Date(now.getTime() - 1000), updatedAt: now, ...overrides,
    },
  });
  return { id, recordingId };
}

test.before(async () => {
  if (skip) return;
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rl35-db-"));
  process.env.FILE_STORAGE_ROOT = storageRoot;
  require("../helpers/server-only.cjs");
  require("tsx/cjs/api").register();
  ({ prisma } = require(path.join(root, "lib", "prisma.ts")));
  upload = require(path.join(root, "services", "recorded-lecture-upload-service.ts"));
  maintenance = require(path.join(root, "services", "recorded-lecture-maintenance-service.ts"));
  completion = require(path.join(root, "services", "recorded-lecture-completion-service.ts"));
});

test.after(async () => {
  if (skip) return;
  await completion.waitForCompletionJobs();
  await prisma.recordedLecture.deleteMany({ where: { lectureId: { in: created.lectures } } });
  await prisma.lecture.deleteMany({ where: { id: { in: created.lectures } } });
  await prisma.class.deleteMany({ where: { id: { in: created.classes } } });
  await prisma.teacher.deleteMany({ where: { id: { in: created.teachers } } });
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

test("expiry waits for a current lease (real OR condition), then expires (real CHECKs accept the transition)", { skip }, async () => {
  const f = await fixture();
  const now = new Date();
  const leased = await session(f, {
    expiresAt: new Date(now.getTime() - 1000),
    leaseToken: "a".repeat(64), leaseOffset: BigInt(0), leaseBytes: 1024 * 1024,
    leaseGrantedAt: new Date(now.getTime() - 10_000), leaseExpiresAt: new Date(now.getTime() + 120_000),
  });
  await maintenance.expireAbandonedUploads(now, 100);
  assert.equal((await prisma.recordingUploadSession.findUnique({ where: { id: leased.id } })).state, "ACTIVE");

  // Its lease still counts in the capacity aggregate although the upload expired.
  const rows = await prisma.$transaction((tx) => upload.reservationRows(tx, now));
  assert.ok(rows.some((r) => r.leaseBytes === 1024 * 1024 && r.expectedBytes === r.receivedBytes + 1024 * 1024));

  await maintenance.expireAbandonedUploads(new Date(now.getTime() + 121_000), 100);
  const after = await prisma.recordingUploadSession.findUnique({ where: { id: leased.id } });
  assert.equal(after.state, "EXPIRED");
  assert.equal(after.leaseToken, null);
});

test("two concurrent recovery workers on one stale claim: real row locks let exactly one take it", { skip }, async () => {
  const f = await fixture();
  const stale = new Date(Date.now() - 11 * 60_000);
  const claim = `${crypto.randomBytes(16).toString("hex")}.mp4`;
  const s = await session(
    f,
    // All bytes received, one chunk counted but no chunk rows: the recovered job fails its plan check.
    { state: "COMPLETING", receivedBytes: BigInt(2 * 1024 * 1024), chunkCount: 1, lastActivityAt: stale },
    { state: "VERIFYING", storedFileName: claim }
  );
  globalThis.slRecordedLectureUploadMutex = undefined;
  const a = completion.recoverStaleCompletion(s.id);
  globalThis.slRecordedLectureUploadMutex = undefined; // "another process"
  const b = completion.recoverStaleCompletion(s.id);
  const outcomes = (await Promise.all([a, b])).sort();
  assert.ok(
    JSON.stringify(outcomes) === JSON.stringify(["lost-race", "recovered"]) || JSON.stringify(outcomes) === JSON.stringify(["not-stale", "recovered"]),
    JSON.stringify(outcomes)
  );
  await completion.waitForCompletionJobs();
  const final = await prisma.recordingUploadSession.findUnique({ where: { id: s.id } });
  assert.equal(final.state, "FAILED", "the recovered job found no chunk records (CHUNK_PLAN_INVALID), FAILED under the real CHECKs");
  assert.equal(final.failureCode, "CHUNK_PLAN_INVALID");
});

test("a stale claim of a blocked teacher is FAILED (real CHECKs on failureCode / failedAt / endedAt)", { skip }, async () => {
  const f = await fixture();
  await prisma.teacher.update({ where: { id: f.teacherId }, data: { isBlocked: true } });
  const claim = `${crypto.randomBytes(16).toString("hex")}.mp4`;
  const s = await session(
    f,
    { state: "COMPLETING", receivedBytes: BigInt(2 * 1024 * 1024), chunkCount: 1, lastActivityAt: new Date(Date.now() - 11 * 60_000) },
    { state: "VERIFYING", storedFileName: claim }
  );
  assert.equal(await completion.recoverStaleCompletion(s.id), "failed-ineligible");
  const row = await prisma.recordingUploadSession.findUnique({ where: { id: s.id } });
  assert.equal(row.state, "FAILED");
  assert.equal(row.failureCode, "TEACHER_ACCOUNT_INACTIVE");
  const recording = await prisma.recordedLecture.findUnique({ where: { id: s.recordingId } });
  assert.equal(recording.state, "FAILED");
});
