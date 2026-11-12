/*
 * Static guard for the student confirmation history migration (no database).
 *
 *   npm run test:confirmation
 *
 * The migration holds hand-written CHECK constraints and an append-only
 * trigger that Prisma cannot express (and ignores, so they are never reported
 * as drift and `prisma db push` would not create them). This test fails if
 * they are lost or altered, if the migration ever changes existing tables or
 * data, or if a database timestamp default sneaks in.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261110130000_add_student_confirmation_history";
const TABLE = "StudentConfirmationHistory";

const normalize = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();

const read = (name) => normalize(fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8"));
const sql = read(MIGRATION);
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");

const CHECKS = {
  [`${TABLE}_status_change_check`]: `CHECK ("fromStatus" <> "toStatus")`,
  [`${TABLE}_toStatus_check`]: `CHECK ("toStatus" <> 'PENDING')`,
  [`${TABLE}_batch_check`]: `CHECK (("source" = 'BULK') = ("batchId" IS NOT NULL))`,
  [`${TABLE}_bulk_transition_check`]: `CHECK ("source" <> 'BULK' OR ("fromStatus" = 'PENDING' AND "toStatus" = 'APPROVED'))`,
  [`${TABLE}_order_check`]: `CHECK ("previousConfirmedAt" IS NULL OR "previousConfirmedAt" < "decidedAt")`,
};

test("migration order: directly after the lecture end date migration", () => {
  const names = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const endDate = names.indexOf("20261110120000_add_lecture_end_date");
  assert.ok(endDate >= 0);
  assert.equal(names[endDate + 1], MIGRATION);
});

test("creates the enum and the table with exactly the schema's columns, no defaults on timestamps", () => {
  assert.ok(sql.includes(`CREATE TYPE "StudentConfirmationSource" AS ENUM ('INDIVIDUAL', 'BULK');`));
  const table = sql.slice(sql.indexOf(`CREATE TABLE "${TABLE}"`), sql.indexOf(`CONSTRAINT "${TABLE}_pkey" PRIMARY KEY ("id") );`));
  for (const column of [
    `"id" TEXT NOT NULL`,
    `"studentId" TEXT NOT NULL`,
    `"fromStatus" "StudentConfirmationStatus" NOT NULL`,
    `"toStatus" "StudentConfirmationStatus" NOT NULL`,
    `"decidedAt" TIMESTAMP(3) NOT NULL,`,
    `"previousConfirmedAt" TIMESTAMP(3),`,
    `"decidedByTeacherId" TEXT NOT NULL`,
    `"source" "StudentConfirmationSource" NOT NULL`,
    `"batchId" TEXT,`,
  ]) {
    assert.ok(table.includes(column), column);
  }
  assert.doesNotMatch(sql, /DEFAULT/i);
  assert.ok(
    sql.includes(`CREATE INDEX "${TABLE}_studentId_decidedAt_idx" ON "${TABLE}"("studentId", "decidedAt");`)
  );
});

test("foreign keys to Student and Teacher are RESTRICT", () => {
  assert.ok(
    sql.includes(
      `ALTER TABLE "${TABLE}" ADD CONSTRAINT "${TABLE}_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;`
    )
  );
  assert.ok(
    sql.includes(
      `ALTER TABLE "${TABLE}" ADD CONSTRAINT "${TABLE}_decidedByTeacherId_fkey" FOREIGN KEY ("decidedByTeacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;`
    )
  );
});

test("every CHECK constraint exists exactly once with its exact definition, and in no other migration", () => {
  for (const [name, definition] of Object.entries(CHECKS)) {
    assert.ok(sql.includes(`ALTER TABLE "${TABLE}" ADD CONSTRAINT "${name}" ${definition};`), name);
    assert.equal(sql.split(`"${name}"`).length - 1, 1, name);
  }
  assert.equal(sql.match(/\bCHECK\b/g).length, Object.keys(CHECKS).length, "no other CHECK");
});

test("append-only trigger refuses UPDATE, DELETE and TRUNCATE", () => {
  assert.ok(sql.includes(`CREATE FUNCTION "${TABLE}_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$`));
  assert.match(sql, /BEGIN RAISE EXCEPTION 'StudentConfirmationHistory is append-only \(% refused\)', TG_OP; END; \$\$;/);
  assert.ok(
    sql.includes(
      `CREATE TRIGGER "${TABLE}_no_update_delete" BEFORE UPDATE OR DELETE ON "${TABLE}" FOR EACH ROW EXECUTE FUNCTION "${TABLE}_append_only"();`
    )
  );
  assert.ok(
    sql.includes(
      `CREATE TRIGGER "${TABLE}_no_truncate" BEFORE TRUNCATE ON "${TABLE}" FOR EACH STATEMENT EXECUTE FUNCTION "${TABLE}_append_only"();`
    )
  );
});

test("no other migration touches the table, its trigger or its constraints", () => {
  const others = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== MIGRATION)
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(migrationsDir, name, "migration.sql")))
    .filter((name) => read(name).includes(TABLE));
  assert.deepEqual(others, []);
});

test("additive only: no existing table, column or row is changed; nothing is backfilled", () => {
  const withoutFunction = sql.replace(/\$\$[\s\S]*?\$\$/g, "$$ $$");
  assert.doesNotMatch(withoutFunction, /\bDROP\b/i);
  assert.doesNotMatch(withoutFunction, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(withoutFunction, /\bUPDATE\s+"/i);
  assert.doesNotMatch(withoutFunction, /\bINSERT\b/i);
  assert.doesNotMatch(withoutFunction, /\bTRUNCATE\s+"/i);
  assert.doesNotMatch(withoutFunction, /ALTER COLUMN|RENAME|ADD COLUMN/i);
  const altered = [...withoutFunction.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(altered)], [TABLE], "only the new table is altered");
  assert.doesNotMatch(withoutFunction, /now\(\)|CURRENT_TIMESTAMP/i);
});

test("schema.prisma matches: enum, model fields, RESTRICT relations, index; Student columns unchanged", () => {
  assert.match(schema, /enum StudentConfirmationSource \{[^}]*\bINDIVIDUAL\b[^}]*\bBULK\b[^}]*\}/);
  const start = schema.indexOf(`model ${TABLE} {`);
  const model = schema.slice(start, schema.indexOf("\n}", start));
  for (const field of [
    /^\s*id\s+String\s+@id @default\(uuid\(\)\)\s*$/m,
    /^\s*studentId\s+String\s*$/m,
    /^\s*fromStatus\s+StudentConfirmationStatus\s*$/m,
    /^\s*toStatus\s+StudentConfirmationStatus\s*$/m,
    /^\s*decidedAt\s+DateTime\s*$/m,
    /^\s*previousConfirmedAt\s+DateTime\?\s*$/m,
    /^\s*decidedByTeacherId\s+String\s*$/m,
    /^\s*source\s+StudentConfirmationSource\s*$/m,
    /^\s*batchId\s+String\?\s*$/m,
    /^\s*student Student @relation\(fields: \[studentId\], references: \[id\], onDelete: Restrict\)\s*$/m,
    /^\s*teacher Teacher @relation\(fields: \[decidedByTeacherId\], references: \[id\], onDelete: Restrict\)\s*$/m,
    /^\s*@@index\(\[studentId, decidedAt\]\)\s*$/m,
  ]) {
    assert.match(model, field);
  }
  assert.doesNotMatch(model, /@default\(now\(\)\)|@updatedAt/);

  const studentModel = schema.slice(schema.indexOf("model Student {"), schema.indexOf("\n}", schema.indexOf("model Student {")));
  for (const column of [
    /^\s*confirmationStatus StudentConfirmationStatus @default\(PENDING\)\s*$/m,
    /^\s*confirmedAt\s+DateTime\?\s*$/m,
    /^\s*confirmedById String\?\s*$/m,
    /^\s*approvedAt DateTime\?\s*$/m,
    /^\s*registeredAt DateTime @default\(now\(\)\)\s*$/m,
  ]) {
    assert.match(studentModel, column);
  }
});
