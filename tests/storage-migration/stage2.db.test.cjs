/*
 * Unified storage Stage 2.1: the migration's consistency trigger and CHECKs
 * against a REAL, DISPOSABLE, LOCAL PostgreSQL that already has migration
 * 20261115120000_add_unified_file_storage_keys applied.
 *
 *   STORAGE_INVENTORY_TEST_DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:5432/slc_inventory_test \
 *     npm run test:storage-migration-db
 *
 * SKIPPED unless STORAGE_INVENTORY_TEST_DATABASE_URL is set; the URL must pass
 * the inventory's own loopback / test-name check. DATABASE_URL and .env are
 * never used. Every row is written inside ONE transaction that is always
 * rolled back, so the database is left exactly as it was.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const DB = require(path.join(root, "lib", "storage-migration", "inventory-database.ts"));

const raw = process.env.STORAGE_INVENTORY_TEST_DATABASE_URL;
let skip = "set STORAGE_INVENTORY_TEST_DATABASE_URL to a disposable LOCAL database to run these tests";
let target = null;
if (raw) {
  target = DB.checkInventoryDatabaseUrl(raw);
  if (!target.ok) throw new Error(`Refusing to run: ${DB.DATABASE_URL_PROBLEM_MESSAGES[target.problem]}`);
  skip = false;
}

let prisma;
test.before(() => {
  if (skip) return;
  const { PrismaClient } = require("@prisma/client");
  prisma = DB.createIsolatedPrismaClient(PrismaClient, target.url).client;
});
test.after(async () => {
  if (prisma) await prisma.$disconnect();
});

class Rollback extends Error {}

/** Runs fn inside a transaction that is always rolled back. */
async function inRolledBackTransaction(fn) {
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback("rollback");
    }),
    Rollback
  );
}

async function seedNote(tx, over = {}) {
  const teacherId = crypto.randomUUID();
  const classId = crypto.randomUUID();
  const lectureId = crypto.randomUUID();
  await tx.teacher.create({ data: { id: teacherId, name: "S2.1", email: `${teacherId}@example.test`, password: "x", isConfirmed: true, emailConfirmed: true } });
  await tx.class.create({ data: { id: classId, name: "S2.1", teacherId } });
  await tx.lecture.create({ data: { id: lectureId, title: "S2.1", date: new Date(), classId } });
  const noteId = crypto.randomUUID();
  const key = `Teachers/${teacherId}/Lectures/${lectureId}/Notes/${noteId}/${"a".repeat(32)}.pdf`;
  await tx.note.create({
    data: { id: noteId, title: "n", lectureId, mimeType: "application/pdf", sizeBytes: 1, fileUrl: `lectures/${lectureId}/${"a".repeat(32)}.pdf`, storageKey: key, sha256: "1".repeat(64), ...over },
  });
  return { noteId, key, lectureId, teacherId };
}

test("the trigger clears storageKey / sha256 when fileUrl changes alone, and keeps them when both change", { skip }, async () => {
  await inRolledBackTransaction(async (tx) => {
    const { noteId, lectureId, teacherId } = await seedNote(tx);
    // An older version's write: fileUrl only.
    await tx.note.update({ where: { id: noteId }, data: { fileUrl: `lectures/${lectureId}/1700000000000-abc123-x.pdf` } });
    let row = await tx.note.findUnique({ where: { id: noteId }, select: { storageKey: true, sha256: true } });
    assert.deepEqual(row, { storageKey: null, sha256: null });
    // This version's write: both together.
    const key2 = `Teachers/${teacherId}/Lectures/${lectureId}/Notes/${noteId}/${"b".repeat(32)}.pdf`;
    await tx.note.update({ where: { id: noteId }, data: { fileUrl: `lectures/${lectureId}/${"b".repeat(32)}.pdf`, storageKey: key2, sha256: "2".repeat(64) } });
    row = await tx.note.findUnique({ where: { id: noteId }, select: { storageKey: true, sha256: true } });
    assert.deepEqual(row, { storageKey: key2, sha256: "2".repeat(64) });
    // Other columns never fire it.
    await tx.note.update({ where: { id: noteId }, data: { title: "renamed" } });
    row = await tx.note.findUnique({ where: { id: noteId }, select: { storageKey: true } });
    assert.equal(row.storageKey, key2);
  });
});

test("the CHECKs reject a bad digest, a malformed key and a key without a digest", { skip }, async () => {
  // A failing statement aborts the transaction, which PostgreSQL rolls back: nothing is left behind.
  for (const over of [{ sha256: "Z".repeat(64) }, { storageKey: "../../etc/passwd" }, { sha256: null }]) {
    await assert.rejects(
      prisma.$transaction((tx) => seedNote(tx, over)),
      (error) => /check constraint|violates/i.test(String(error?.message)),
      JSON.stringify(over)
    );
  }
});

test("both tables carry the trigger", { skip }, async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT tgname FROM pg_trigger WHERE tgname IN ('Note_clear_stale_storage_key', 'AssignmentSubmission_clear_stale_storage_key') ORDER BY tgname`
  );
  assert.deepEqual(rows.map((r) => r.tgname), ["AssignmentSubmission_clear_stale_storage_key", "Note_clear_stale_storage_key"]);
});
