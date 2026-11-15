/*
 * Teacher storage quota, Stages 3.2 / 3.3: the reservation service and the
 * Recorded Lecture upload start against a REAL,
 * DISPOSABLE, LOCAL PostgreSQL (all migrations up to
 * 20261116120000_add_teacher_storage_accounting applied). This is the test
 * that proves the advisory lock serialises concurrent quota decisions in the
 * database itself; the fake-database tests cannot.
 *
 *   STORAGE_QUOTA_TEST_DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:5432/slc_quota_test \
 *     npm run test:storage-quota-db
 *
 * SKIPPED unless STORAGE_QUOTA_TEST_DATABASE_URL is set (loopback host and a
 * test / dev database name are required; DATABASE_URL and .env are never
 * used). The service commits its own transactions, so this test creates a
 * throwaway teacher and DELETES every row it created afterwards.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const Module = require("node:module");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const DB = require(path.join(root, "lib", "storage-migration", "inventory-database.ts"));

const raw = process.env.STORAGE_QUOTA_TEST_DATABASE_URL;
let skip = "set STORAGE_QUOTA_TEST_DATABASE_URL to a disposable LOCAL database to run these tests";
let target = null;
if (raw) {
  target = DB.checkInventoryDatabaseUrl(raw);
  if (!target.ok) throw new Error(`Refusing to run: ${DB.DATABASE_URL_PROBLEM_MESSAGES[target.problem]}`);
  skip = false;
}

let prisma;
let R;
let NK;
test.before(() => {
  if (skip) return;
  const { PrismaClient } = require("@prisma/client");
  prisma = DB.createIsolatedPrismaClient(PrismaClient, target.url).client;
  // Never lib/prisma's own client (the project .env): the service uses this local test client.
  const file = path.join(root, "lib", "prisma.ts");
  const mod = new Module(file);
  mod.filename = file;
  mod.loaded = true;
  mod.exports = { prisma };
  require.cache[file] = mod;
  R = require(path.join(root, "services", "storage-reservation-service.ts"));
  NK = require(path.join(root, "lib", "notes", "storage-keys.ts"));
});
test.after(async () => {
  if (prisma) await prisma.$disconnect();
});

async function withTeacher(limitBytes, fn) {
  const teacherId = crypto.randomUUID();
  await prisma.teacher.create({ data: { id: teacherId, name: "Q32", email: `${teacherId}@example.test`, password: "x", isConfirmed: true, emailConfirmed: true } });
  await prisma.teacherStorageLimit.create({ data: { teacherId, limitBytes: BigInt(limitBytes), updatedAt: new Date(), updatedByAdminId: "test", updatedByAdminEmail: "test@example.test" } });
  try {
    await fn(teacherId);
  } finally {
    await prisma.storageReservation.deleteMany({ where: { teacherId } });
    await prisma.teacherStorageLimit.deleteMany({ where: { teacherId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
  }
}

const key = (teacherId) => NK.noteFileKey({ teacherId, lectureId: crypto.randomUUID(), noteId: crypto.randomUUID(), storedName: NK.generateNoteStoredName("application/pdf") });

test("real PostgreSQL: five simultaneous reservations with room for two -> exactly two (the advisory lock serialises them)", { skip }, async () => {
  await withTeacher(250, async (teacherId) => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => R.reserveTeacherStorage({ teacherId, category: "NOTE", storageKey: key(teacherId), bytes: BigInt(100), audience: "TEACHER" }))
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    for (const r of results.filter((x) => x.status === "rejected")) assert.equal(r.reason.code, "STORAGE_QUOTA_EXCEEDED");
    assert.equal(await prisma.storageReservation.count({ where: { teacherId } }), 2);
  });
});

test("real PostgreSQL (Stage 3.3): three simultaneous recording starts with room for two -> exactly two sessions", { skip }, async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const { startRecordingUpload } = require(path.join(root, "services", "recorded-lecture-upload-service.ts"));
  const files = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "q33-"));
  const saved = { root: process.env.FILE_STORAGE_ROOT, free: process.env.RECORDED_LECTURE_MIN_FREE_BYTES };
  process.env.FILE_STORAGE_ROOT = files;
  process.env.RECORDED_LECTURE_MIN_FREE_BYTES = "0";
  const MIB = 1024 * 1024;
  await withTeacher(2 * 4 * MIB + MIB, async (teacherId) => {
    const classId = crypto.randomUUID();
    const lectureId = crypto.randomUUID();
    await prisma.class.create({ data: { id: classId, name: "Q33", teacherId } });
    await prisma.lecture.create({ data: { id: lectureId, title: "Q33", date: new Date(), classId } });
    try {
      const results = await Promise.allSettled(
        [1, 2, 3].map((partNumber) =>
          startRecordingUpload({ teacherId, lectureId, body: { title: `Part ${partNumber}`, partNumber, fileName: "p.mp4", mimeType: "video/mp4", sizeBytes: 4 * MIB } })
        )
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
      assert.equal(results.find((r) => r.status === "rejected").reason.code, "STORAGE_QUOTA_EXCEEDED");
      assert.equal(await prisma.recordingUploadSession.count({ where: { teacherId } }), 2);
    } finally {
      await prisma.lecture.delete({ where: { id: lectureId } }); // cascades to its recordings and sessions
      await prisma.class.delete({ where: { id: classId } });
      process.env.FILE_STORAGE_ROOT = saved.root;
      if (saved.free === undefined) delete process.env.RECORDED_LECTURE_MIN_FREE_BYTES;
      else process.env.RECORDED_LECTURE_MIN_FREE_BYTES = saved.free;
      fs.rmSync(files, { recursive: true, force: true });
    }
  });
});

test("real PostgreSQL (Stage 3.4): admin limit set / change / remove, each with its audit row; CHECKs refuse a negative limit", { skip }, async () => {
  const admin = require(path.join(root, "services", "admin-teacher-storage-service.ts"));
  const who = { adminId: "admin-test", email: "admin@example.test" };
  await withTeacher(1000, async (teacherId) => {
    try {
      await prisma.teacherStorageLimit.deleteMany({ where: { teacherId } }); // start without an override
      assert.deepEqual(await admin.setTeacherStorageLimit({ teacherId, admin: who, request: { kind: "set", limitBytes: BigInt(5_000_000_000) } }), { changed: true });
      await admin.setTeacherStorageLimit({ teacherId, admin: who, request: { kind: "set", limitBytes: BigInt(0) } });
      await admin.setTeacherStorageLimit({ teacherId, admin: who, request: { kind: "remove" } });
      const changes = await prisma.teacherStorageLimitChange.findMany({ where: { teacherId }, orderBy: { changedAt: "asc" } });
      assert.deepEqual(changes.map((c) => [c.previousLimitBytes, c.newLimitBytes, c.changedByAdminEmail]), [
        [null, BigInt(5_000_000_000), "admin@example.test"],
        [BigInt(5_000_000_000), BigInt(0), "admin@example.test"],
        [BigInt(0), null, "admin@example.test"],
      ]);
      assert.equal(await prisma.teacherStorageLimit.count({ where: { teacherId } }), 0);
      await assert.rejects(
        prisma.teacherStorageLimit.create({ data: { teacherId, limitBytes: BigInt(-1), updatedAt: new Date(), updatedByAdminId: "a", updatedByAdminEmail: "a@example.test" } }),
        /check constraint|violates/i
      );
    } finally {
      await prisma.teacherStorageLimitChange.deleteMany({ where: { teacherId } }); // RESTRICT: before the teacher
    }
  });
});

test("real PostgreSQL: commit deletes the reservation atomically with the caller's write; a failing write rolls both back", { skip }, async () => {
  await withTeacher(1000, async (teacherId) => {
    const r = await R.reserveTeacherStorage({ teacherId, category: "NOTE", storageKey: key(teacherId), bytes: BigInt(10), audience: "TEACHER" });
    await assert.rejects(R.commitTeacherStorageReservation(r, "TEACHER", async () => {
      throw new Error("insert failed");
    }), /insert failed/);
    assert.equal(await prisma.storageReservation.count({ where: { id: r.id } }), 1, "rolled back: the reservation stays");
    assert.equal(await R.commitTeacherStorageReservation(r, "TEACHER", async () => "ok"), "ok");
    assert.equal(await prisma.storageReservation.count({ where: { id: r.id } }), 0);
  });
});
