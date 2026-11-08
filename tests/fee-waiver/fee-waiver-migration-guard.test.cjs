/*
 * Static guard for the fee-waiver migration (no database needed).
 *
 *   npm run test:fee-waiver
 *
 * The migration holds hand-written SQL Prisma cannot express (CHECK
 * constraints, a partial unique index, the launch-month row and two narrow
 * backfills). A later `prisma migrate dev` may report the index as drift and
 * generate a DROP INDEX. This test fails if any of that is lost or altered,
 * or if the migration ever becomes destructive.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261108120000_add_fee_waiver_rules";
const INDEX = "ClassFeeWaiverRule_active_sequence_key";

const normalize = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();

const read = (name) => normalize(fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8"));
const sql = read(MIGRATION);

test("the partial unique index is created exactly once, with the exact definition", () => {
  assert.ok(
    sql.includes(`CREATE UNIQUE INDEX "${INDEX}" ON "ClassFeeWaiverRule" ("classId", "sequence") WHERE "status" = 0;`)
  );
  const others = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== MIGRATION)
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(migrationsDir, name, "migration.sql")))
    .filter((name) => read(name).includes(INDEX));
  assert.deepEqual(others, [], "no other migration may drop, alter or recreate it");
});

test("CHECK constraints keep values, sequences and the launch month in range", () => {
  assert.match(sql, /CHECK \("value" > 0\)/);
  assert.match(sql, /CHECK \("sequence" BETWEEN 1 AND 20\)/);
  assert.match(sql, /CHECK \("type" <> 'PERCENTAGE' OR "value" <= 100\)/);
  assert.match(sql, /CHECK \("startMonth" BETWEEN 1 AND 12\)/);
  assert.match(sql, /CHECK \("startYear" BETWEEN 2026 AND 2100\)/);
});

test("launch month = first full Asia/Colombo month after the migration runs", () => {
  assert.ok(
    sql.includes(
      `INSERT INTO "FeeWaiverSettings" ("id", "startYear", "startMonth") SELECT 'default', EXTRACT(YEAR FROM m)::int, EXTRACT(MONTH FROM m)::int FROM (SELECT date_trunc('month', now() AT TIME ZONE 'Asia/Colombo') + interval '1 month' AS m) AS launch;`
    )
  );
});

test("backfills are exactly the agreed, narrow statements", () => {
  assert.ok(sql.includes(`UPDATE "ClassStudentFee" SET "lateJoinDeductManual" = true WHERE "lateJoinDeduct" > 0;`));
  assert.ok(
    sql.includes(
      `UPDATE "Student" SET "approvedAt" = "confirmedAt" WHERE "registrationSource" = 'PUBLIC_CLASS' AND "confirmationStatus" = 'APPROVED' AND "confirmedAt" IS NOT NULL;`
    )
  );
  assert.equal((sql.match(/\bUPDATE "/g) ?? []).length, 2, "no other UPDATE statement");
});

test("the migration is additive only", () => {
  // Foreign-key actions (ON DELETE / ON UPDATE ...) are not data changes.
  const statements = sql.replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL|RESTRICT|NO ACTION)/g, " ");
  assert.doesNotMatch(statements, /\bDROP\b/i);
  assert.doesNotMatch(statements, /\bDELETE\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /ALTER COLUMN/i);
  assert.doesNotMatch(sql, /RENAME/i);
  const alters = sql.match(/ALTER TABLE "[A-Za-z]+" (ADD COLUMN|ADD CONSTRAINT)/g) ?? [];
  assert.ok(alters.length > 0);
  for (const statement of sql.split(";").filter((s) => /ALTER TABLE/.test(s))) {
    assert.match(statement, /ADD (COLUMN|CONSTRAINT)/, statement);
  }
});

test("schema.prisma declares the models but not the partial index", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  assert.match(schema, /model ClassFeeWaiverRule \{/);
  assert.match(schema, /model FeeWaiverSettings \{/);
  assert.match(schema, /approvedAt DateTime\?/);
  assert.match(schema, /lateJoinDeductManual\s+Boolean\s+@default\(false\)/);
  assert.doesNotMatch(schema, /@@unique\(\[classId, sequence\]\)/);
});

test("the documentation of the manual SQL exists", () => {
  const doc = fs.readFileSync(path.join(root, "docs", "fee-waiver-rules.md"), "utf8");
  assert.match(doc, new RegExp(INDEX));
  assert.match(doc, /FeeWaiverSettings/);
});
