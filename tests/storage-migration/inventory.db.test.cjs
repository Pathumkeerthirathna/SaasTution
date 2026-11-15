/*
 * Unified storage migration, Stage 1: the inventory reader against a REAL,
 * DISPOSABLE, LOCAL PostgreSQL that already has the application schema.
 *
 *   STORAGE_INVENTORY_TEST_DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:5432/slc_inventory_test \
 *     npm run test:storage-migration-db
 *
 * SKIPPED unless STORAGE_INVENTORY_TEST_DATABASE_URL is set. The URL must pass
 * the tool's own check (loopback host, a test / dev database name, no
 * redirecting parameters). DATABASE_URL and .env are never used: the client is
 * created through createIsolatedPrismaClient. It creates NO rows: it proves
 * that the reader's transaction is READ ONLY in PostgreSQL itself (a write
 * inside it is rejected) and that reading the existing rows works.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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

test("PostgreSQL rejects a write inside the inventory's read-only transaction", { skip }, async () => {
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(DB.READ_ONLY_TRANSACTION_SQL);
      // A temporary table would vanish anyway; READ ONLY must reject it before that.
      await tx.$executeRawUnsafe("CREATE TEMP TABLE storage_inventory_probe (x int)");
    }),
    (error) => /read-only transaction|25006/i.test(String(error?.message ?? "") + String(error?.meta?.code ?? "") + String(error?.code ?? ""))
  );
});

test("readInventoryRecords reads every Note and AssignmentSubmission row without error", { skip }, async () => {
  const counts = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(DB.READ_ONLY_TRANSACTION_SQL);
    return { notes: await tx.note.count(), submissions: await tx.assignmentSubmission.count() };
  });
  const result = await DB.readInventoryRecords(prisma, { pageSize: 50 });
  assert.equal(result.notes.length, counts.notes);
  assert.equal(result.submissions.length, counts.submissions);
  for (const n of result.notes) assert.equal(typeof n.fileUrl, "string");
});
