/*
 * Static guard for the lecture end time migration (no database needed).
 *
 *   npm run test:lectures
 *
 * The migration holds a hand-written CHECK constraint Prisma cannot express
 * (and ignores, so it is never reported as drift or recreated by
 * `prisma db push`). This test fails if it is lost or altered, if the
 * migration ever becomes destructive or backfills data, or if a database
 * timestamp default sneaks in.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261110120000_add_lecture_end_date";
const CONSTRAINT = "Lecture_endDate_after_date";

const normalize = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();

const read = (name) => normalize(fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8"));
const sql = read(MIGRATION);
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");

test("adds a nullable TIMESTAMP(3) endDate column, without a default", () => {
  assert.ok(sql.includes(`ALTER TABLE "Lecture" ADD COLUMN "endDate" TIMESTAMP(3);`));
  assert.doesNotMatch(sql, /NOT NULL/i);
  assert.doesNotMatch(sql, /DEFAULT/i);
});

test("the CHECK constraint is created exactly once, with the exact definition", () => {
  assert.ok(
    sql.includes(`ALTER TABLE "Lecture" ADD CONSTRAINT "${CONSTRAINT}" CHECK ("endDate" IS NULL OR "endDate" > "date");`)
  );
  assert.equal(sql.split(CONSTRAINT).length - 1, 1);

  const others = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== MIGRATION)
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(migrationsDir, name, "migration.sql")))
    .filter((name) => read(name).includes(CONSTRAINT));
  assert.deepEqual(others, [], "no other migration may drop, alter or recreate it");
});

test("the migration is additive only: no data change, no backfill", () => {
  assert.doesNotMatch(sql, /\bDROP\b/i);
  assert.doesNotMatch(sql, /\bDELETE\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\b/i);
  assert.doesNotMatch(sql, /\bINSERT\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /ALTER COLUMN/i);
  assert.doesNotMatch(sql, /RENAME/i);
  assert.doesNotMatch(sql, /ClassSchedule/, "no backfill from the weekly schedule");
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 2, "exactly the column and the constraint");
});

test("schema.prisma declares endDate as an optional DateTime with no default", () => {
  const model = schema.slice(schema.indexOf("model Lecture {"), schema.indexOf("}", schema.indexOf("model Lecture {")));
  assert.match(model, /^\s*endDate\s+DateTime\?\s*$/m);
  assert.doesNotMatch(model, /endDate\s+DateTime\?\s+@default/);
});
