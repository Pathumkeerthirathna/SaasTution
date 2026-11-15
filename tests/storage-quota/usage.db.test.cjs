/*
 * Teacher storage accounting, Stage 3.1, against a REAL, DISPOSABLE, LOCAL
 * PostgreSQL that already has every migration up to
 * 20261116120000_add_teacher_storage_accounting applied.
 *
 *   STORAGE_QUOTA_TEST_DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:5432/slc_quota_test \
 *     npm run test:storage-quota-db
 *
 * SKIPPED unless STORAGE_QUOTA_TEST_DATABASE_URL is set. The URL must pass the
 * inventory's loopback / test-name check (lib/storage-migration/inventory-database.ts);
 * DATABASE_URL and .env are never used. Every row is written inside a
 * transaction that is ALWAYS rolled back: the database is left as it was.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

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
let usageService;
let locks;
let NK;
let SK;
test.before(() => {
  if (skip) return;
  const { PrismaClient } = require("@prisma/client");
  prisma = DB.createIsolatedPrismaClient(PrismaClient, target.url).client;
  // lib/prisma.ts would build its own client from the project .env (the testing database):
  // the service gets THIS local test client instead, installed before it is first required.
  const Module = require("node:module");
  const prismaModule = path.join(root, "lib", "prisma.ts");
  const mod = new Module(prismaModule);
  mod.filename = prismaModule;
  mod.loaded = true;
  mod.exports = { prisma };
  require.cache[prismaModule] = mod;
  usageService = require(path.join(root, "services", "teacher-storage-usage-service.ts"));
  locks = require(path.join(root, "lib", "storage-quota", "locks.ts"));
  NK = require(path.join(root, "lib", "notes", "storage-keys.ts"));
  SK = require(path.join(root, "lib", "assignments", "submission-keys.ts"));
});
test.after(async () => {
  if (prisma) await prisma.$disconnect();
});

class Rollback extends Error {}
async function rolledBack(fn) {
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback("rollback");
    }, { timeout: 60_000 }),
    Rollback
  );
}

const uuid = () => crypto.randomUUID();
const NOW = () => new Date();

async function teacherWithLecture(tx) {
  const teacherId = uuid();
  const classId = uuid();
  const lectureId = uuid();
  await tx.teacher.create({ data: { id: teacherId, name: "Q", email: `${teacherId}@example.test`, password: "x", isConfirmed: true, emailConfirmed: true } });
  await tx.class.create({ data: { id: classId, name: "Q", teacherId } });
  await tx.lecture.create({ data: { id: lectureId, title: "Q", date: NOW(), classId } });
  return { teacherId, classId, lectureId };
}

async function readyRecording(tx, t, sizeBytes, over = {}) {
  const now = NOW();
  await tx.recordedLecture.create({
    data: {
      id: uuid(), lectureId: t.lectureId, classId: t.classId, teacherId: t.teacherId, title: "r", partNumber: Math.floor(Math.random() * 1e6) + 1,
      displayFileName: "r.mp4", mimeType: "video/mp4", sizeBytes: BigInt(sizeBytes), state: "READY", storedFileName: `${crypto.randomBytes(16).toString("hex")}.mp4`,
      durationSeconds: 10, videoCodec: "avc1.64001F", audioCodec: "mp4a.40.2", fragmented: false, readyAt: now, createdAt: now, updatedAt: now, ...over,
    },
  });
}

test("real PostgreSQL: every category, soft deletes, legacy rows, sessions, reservations and the effective limit", { skip }, async () => {
  await rolledBack(async (tx) => {
    const t = await teacherWithLecture(tx);
    const other = await teacherWithLecture(tx);
    const now = NOW();

    // Recordings: READY (counts), deleted-by-teacher status 2 (counts until purged), UPLOADING with an ACTIVE session (reserved).
    await readyRecording(tx, t, 5_000_000_000);
    await readyRecording(tx, t, 7, { status: 2, deletedAt: now, purgeRequestedAt: now });
    await readyRecording(tx, other, 999); // another teacher
    const uploadingId = uuid();
    await tx.recordedLecture.create({
      data: { id: uploadingId, lectureId: t.lectureId, classId: t.classId, teacherId: t.teacherId, title: "u", partNumber: 999_999, displayFileName: "u.mp4", mimeType: "video/mp4", sizeBytes: BigInt(300), state: "UPLOADING", createdAt: now, updatedAt: now },
    });
    await tx.recordingUploadSession.create({
      data: { id: uuid(), recordedLectureId: uploadingId, teacherId: t.teacherId, expectedBytes: BigInt(300), state: "ACTIVE", expiresAt: new Date(now.getTime() + 3_600_000), lastActivityAt: now, createdAt: now, updatedAt: now },
    });

    // Notes: stored (counts), stored + soft-deleted (counts), legacy (excluded), another teacher's (excluded).
    const noteRow = async (tt, size, over = {}) => {
      const id = uuid();
      const storageKey = NK.noteFileKey({ teacherId: tt.teacherId, lectureId: tt.lectureId, noteId: id, storedName: NK.generateNoteStoredName("application/pdf") });
      await tx.note.create({ data: { id, title: "n", lectureId: tt.lectureId, mimeType: "application/pdf", sizeBytes: size, fileUrl: storageKey, storageKey, sha256: "a".repeat(64), ...over } });
    };
    await noteRow(t, 1000);
    await noteRow(t, 2000, { status: 1 });
    await noteRow(t, 3000, { storageKey: null, sha256: null, fileUrl: `lectures/${t.lectureId}/legacy.pdf` });
    await noteRow(other, 4000);

    // Submissions: stored (counts) and legacy (excluded).
    const assignmentId = uuid();
    await tx.assignment.create({ data: { id: assignmentId, title: "a", description: "d", dueDate: now, lectureId: t.lectureId } });
    for (const [size, stored] of [[300, true], [400, false]]) {
      const studentId = uuid();
      await tx.student.create({ data: { id: studentId, name: "s", teacherId: t.teacherId, contact: "0" } });
      const id = uuid();
      const storageKey = stored ? SK.submissionFileKey({ teacherId: t.teacherId, lectureId: t.lectureId, assignmentId, submissionId: id, storedName: SK.generateSubmissionStoredName() }) : null;
      await tx.assignmentSubmission.create({
        data: { id, assignmentId, studentId, fileName: "s.pdf", fileUrl: storageKey ?? `assignments/${assignmentId}/legacy.pdf`, storageKey, sha256: stored ? "b".repeat(64) : null, mimeType: "application/pdf", sizeBytes: size },
      });
    }

    // Reservations: one live NOTE, one expired SUBMISSION.
    const resKey = (category) =>
      category === "NOTE"
        ? NK.noteFileKey({ teacherId: t.teacherId, lectureId: t.lectureId, noteId: uuid(), storedName: NK.generateNoteStoredName("application/pdf") })
        : SK.submissionFileKey({ teacherId: t.teacherId, lectureId: t.lectureId, assignmentId, submissionId: uuid(), storedName: SK.generateSubmissionStoredName() });
    await tx.storageReservation.create({ data: { teacherId: t.teacherId, category: "NOTE", bytes: BigInt(55), storageKey: resKey("NOTE"), createdAt: now, expiresAt: new Date(now.getTime() + 60_000) } });
    await tx.storageReservation.create({ data: { teacherId: t.teacherId, category: "SUBMISSION", bytes: BigInt(66), storageKey: resKey("SUBMISSION"), createdAt: new Date(now.getTime() - 120_000), expiresAt: new Date(now.getTime() - 60_000) } });

    // Limit: plan 3 GB, then an individual override.
    const plan = await tx.subscriptionPlan.create({ data: { name: `q-${uuid()}`, price: 0, maxLiveParticipants: 1, storageGB: 3 } });
    await tx.teacherSubscription.create({ data: { teacherId: t.teacherId, planId: plan.id, startDate: now, price: 0 } });

    let usage = await usageService.getTeacherStorageUsage(t.teacherId, { db: tx, now });
    assert.deepEqual(usage.committed, { recordedLectures: BigInt(5_000_000_007), notes: BigInt(3000), submissions: BigInt(300), total: BigInt(5_000_003_307) });
    assert.deepEqual(usage.reserved, { recordedLectures: BigInt(300), notes: BigInt(55), submissions: BigInt(0), total: BigInt(355) });
    assert.deepEqual([usage.limit.source, usage.limit.limitBytes], ["PLAN", BigInt(3_000_000_000)]);
    assert.equal(usage.isOverQuota, true);

    await tx.teacherStorageLimit.create({ data: { teacherId: t.teacherId, limitBytes: BigInt(10_000_000_000), updatedAt: now, updatedByAdminId: "admin", updatedByAdminEmail: "admin@example.test" } });
    usage = await usageService.getTeacherStorageUsage(t.teacherId, { db: tx, now });
    assert.deepEqual([usage.limit.source, usage.isOverQuota], ["OVERRIDE", false]);
  });
});

test("real PostgreSQL: the reservation CHECKs reject bad sizes, foreign-teacher keys and wrong-category keys", { skip }, async () => {
  for (const make of [
    (t, now) => ({ teacherId: t.teacherId, category: "NOTE", bytes: BigInt(0), storageKey: NK.noteFileKey({ teacherId: t.teacherId, lectureId: t.lectureId, noteId: uuid(), storedName: NK.generateNoteStoredName("application/pdf") }), createdAt: now, expiresAt: new Date(now.getTime() + 1000) }),
    (t, now) => ({ teacherId: t.teacherId, category: "NOTE", bytes: BigInt(1), storageKey: NK.noteFileKey({ teacherId: uuid(), lectureId: t.lectureId, noteId: uuid(), storedName: NK.generateNoteStoredName("application/pdf") }), createdAt: now, expiresAt: new Date(now.getTime() + 1000) }),
    (t, now) => ({ teacherId: t.teacherId, category: "SUBMISSION", bytes: BigInt(1), storageKey: NK.noteFileKey({ teacherId: t.teacherId, lectureId: t.lectureId, noteId: uuid(), storedName: NK.generateNoteStoredName("application/pdf") }), createdAt: now, expiresAt: new Date(now.getTime() + 1000) }),
    (t, now) => ({ teacherId: t.teacherId, category: "NOTE", bytes: BigInt(1), storageKey: NK.noteFileKey({ teacherId: t.teacherId, lectureId: t.lectureId, noteId: uuid(), storedName: NK.generateNoteStoredName("application/pdf") }), createdAt: now, expiresAt: now }),
  ]) {
    // A failing statement aborts (and rolls back) its transaction.
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        const t = await teacherWithLecture(tx);
        await tx.storageReservation.create({ data: make(t, NOW()) });
      }),
      (error) => /check constraint|violates/i.test(String(error?.message))
    );
  }
});

test("real PostgreSQL: the quota lock blocks a second transaction for the same teacher, not for another teacher", { skip }, async () => {
  const teacher = uuid();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let acquired;
  const acquiredPromise = new Promise((resolve) => (acquired = resolve));
  const holder = prisma.$transaction(async (tx) => {
    await locks.lockTeacherStorageQuota(tx, teacher);
    acquired();
    await held;
  }, { timeout: 30_000 });
  await acquiredPromise;
  try {
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '300ms'");
        await locks.lockTeacherStorageQuota(tx, teacher);
      }),
      (error) => /lock timeout|55P03|canceling statement/i.test(String(error?.message) + String(error?.meta?.code ?? ""))
    );
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '300ms'");
      await locks.lockTeacherStorageQuota(tx, uuid()); // another teacher: not blocked
    });
  } finally {
    release();
    await holder;
  }
});
