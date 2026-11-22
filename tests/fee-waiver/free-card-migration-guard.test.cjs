/*
 * Static guard for the Free Card migration (no database needed).
 *
 *   npm run test:fee-waiver
 *
 * The migration only adds three columns, an index, a foreign key and two
 * hand-written CHECKs that Prisma cannot express. This test fails if the
 * CHECKs are lost or altered, if any statement becomes destructive, or if the
 * schema and the migration drift apart.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261120120000_add_class_student_fee_free_card";

const normalize = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
const sql = normalize(fs.readFileSync(path.join(migrationsDir, MIGRATION, "migration.sql"), "utf8"));

test("placement: after every earlier migration; only the approved payment access control, partial payment and Free Card eligibility migrations follow", () => {
  const names = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  assert.deepEqual(names.slice(names.indexOf(MIGRATION)), [MIGRATION, "20261121120000_add_class_payment_access_control", "20261122120000_add_class_payment_source_and_reversal", "20261123120000_add_class_student_free_card_eligible", "20261124120000_add_recorded_lecture_publication", "20261125120000_add_teacher_payment_accounts", "20261126120000_add_teacher_title_eng", "20261127120000_add_grade_zero"]);
});

test("the three columns, with a false default for existing rows", () => {
  assert.ok(sql.includes(`ALTER TABLE "ClassStudentFee" ADD COLUMN "freeCard" BOOLEAN NOT NULL DEFAULT false,`));
  assert.ok(sql.includes(`ADD COLUMN "freeCardIssuedAt" TIMESTAMP(3),`));
  assert.ok(sql.includes(`ADD COLUMN "freeCardIssuedByTeacherId" TEXT;`));
  assert.ok(
    sql.includes(
      `ADD CONSTRAINT "ClassStudentFee_freeCardIssuedByTeacherId_fkey" FOREIGN KEY ("freeCardIssuedByTeacherId") REFERENCES "Teacher"("id") ON DELETE SET NULL ON UPDATE CASCADE;`
    )
  );
  assert.ok(sql.includes(`CREATE INDEX "ClassStudentFee_freeCardIssuedByTeacherId_idx"`));
});

test("CHECKs: a card is never payable; issue details only while active", () => {
  assert.ok(
    sql.includes(`ADD CONSTRAINT "ClassStudentFee_freeCard_finalAmount_check" CHECK ("freeCard" = false OR "finalAmount" = 0);`)
  );
  assert.ok(
    sql.includes(
      `ADD CONSTRAINT "ClassStudentFee_freeCard_issued_check" CHECK ("freeCard" = true OR ("freeCardIssuedAt" IS NULL AND "freeCardIssuedByTeacherId" IS NULL));`
    )
  );
});

test("the migration is additive only: no data change, no drop, no rewrite", () => {
  const statements = sql.replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL|RESTRICT|NO ACTION)/g, " ");
  assert.doesNotMatch(statements, /\bDROP\b/i);
  assert.doesNotMatch(statements, /\bDELETE\b/i);
  assert.doesNotMatch(sql, /\bUPDATE "/);
  assert.doesNotMatch(sql, /\bINSERT\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /ALTER COLUMN/i);
  assert.doesNotMatch(sql, /RENAME/i);
  for (const statement of sql.split(";").filter((s) => /ALTER TABLE/.test(s))) {
    assert.match(statement, /ADD (COLUMN|CONSTRAINT)/, statement);
  }
  assert.match(sql, /^SET lock_timeout = '5s';/);
});

test("lock timeout: session-level SET as the very first statement, RESET as the very last", () => {
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  assert.equal(statements[0], "SET lock_timeout = '5s'");
  assert.equal(statements[statements.length - 1], "RESET lock_timeout");
  assert.equal(statements.filter((s) => /lock_timeout/.test(s)).length, 2, "set once, reset once");
  // SET LOCAL would silently do nothing if Prisma ran the script statement by statement.
  assert.doesNotMatch(sql, /SET LOCAL/i);
});

test("schema.prisma declares the columns and the relation (not the CHECKs)", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  assert.match(schema, /freeCard\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /freeCardIssuedAt\s+DateTime\?/);
  assert.match(schema, /freeCardIssuedByTeacherId\s+String\?/);
  assert.match(schema, /@relation\("ClassStudentFeeFreeCardIssuedBy", fields: \[freeCardIssuedByTeacherId\], references: \[id\], onDelete: SetNull\)/);
  assert.match(schema, /issuedFreeCards\s+ClassStudentFee\[\]\s+@relation\("ClassStudentFeeFreeCardIssuedBy"\)/);
});
