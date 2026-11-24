/*
 * Static guard for the monthly resource access migration (no database).
 *
 *   npm run test:class-access
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261128120000_add_resource_month_access";

const normalize = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
const sql = normalize(fs.readFileSync(path.join(migrationsDir, MIGRATION, "migration.sql"), "utf8"));
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");

test("placement: right after Grade 0; only the approved default lecture migration follows; no committed migration changed (git)", () => {
  const all = fs.readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
  assert.deepEqual(all.slice(all.indexOf(MIGRATION) - 1), [
    "20261127120000_add_grade_zero",
    MIGRATION,
    "20261129120000_add_lecture_is_default", // Default lecture (tests/lectures/default-lecture-migration-guard.test.cjs)
  ]);
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "prisma/migrations"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(diff, "", "committed migrations are untouched");
});

test("exactly: lock timeout, the enum, the new default, the nullable Note column, the override table, its unique index, FK and CHECK, reset", () => {
  assert.deepEqual(statements, [
    "SET lock_timeout = '5s'",
    `CREATE TYPE "ResourceAccessOverride" AS ENUM ('GRANTED', 'REVOKED')`,
    'ALTER TABLE "Class" ALTER COLUMN "restrictUnpaidStudentAccess" SET DEFAULT true',
    'ALTER TABLE "Note" ADD COLUMN "uploadedAt" TIMESTAMP(3)',
    'CREATE TABLE "ClassStudentResourceAccess" ( "id" TEXT NOT NULL, "classStudentId" TEXT NOT NULL, "year" INTEGER NOT NULL, "month" INTEGER NOT NULL, "access" "ResourceAccessOverride" NOT NULL, "setByTeacherId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ClassStudentResourceAccess_pkey" PRIMARY KEY ("id") )',
    'CREATE UNIQUE INDEX "ClassStudentResourceAccess_classStudentId_year_month_key" ON "ClassStudentResourceAccess"("classStudentId", "year", "month")',
    'ALTER TABLE "ClassStudentResourceAccess" ADD CONSTRAINT "ClassStudentResourceAccess_classStudentId_fkey" FOREIGN KEY ("classStudentId") REFERENCES "ClassStudent"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    'ALTER TABLE "ClassStudentResourceAccess" ADD CONSTRAINT "ClassStudentResourceAccess_month_check" CHECK ("month" BETWEEN 1 AND 12 AND "year" BETWEEN 2000 AND 2100)',
    "RESET lock_timeout",
  ]);
});

test("additive only: no existing row is updated (existing classes keep their setting), nothing dropped or renamed, no backfill", () => {
  // (The foreign key's referential actions are not statements.)
  const withoutFkActions = sql.replace(/ON (DELETE|UPDATE) (CASCADE|RESTRICT|SET NULL|NO ACTION)/g, "");
  assert.doesNotMatch(withoutFkActions, /\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|RENAME)\b|SET LOCAL/i);
  assert.doesNotMatch(sql, /"Note" ADD COLUMN "uploadedAt" TIMESTAMP\(3\) (NOT NULL|DEFAULT)/, "nullable, no default: old notes use their lecture's date");
});

test("schema.prisma matches: default true for new classes, nullable Note.uploadedAt, the override model and enum", () => {
  assert.match(schema, /restrictUnpaidStudentAccess\s+Boolean\s+@default\(true\)/);
  assert.match(schema, /paymentGracePeriodDays\s+Int\s+@default\(5\)/);
  assert.match(schema, /\n\s+uploadedAt DateTime\?\n/);
  assert.match(schema, /model ClassStudentResourceAccess \{[\s\S]*?@@unique\(\[classStudentId, year, month\]\)/);
  assert.match(schema, /enum ResourceAccessOverride \{\s+GRANTED\s+REVOKED\s+\}/);
  assert.match(schema, /classStudent\s+ClassStudent\s+@relation\(fields: \[classStudentId\], references: \[id\], onDelete: Cascade\)/);
});

test("new uploads set Note.uploadedAt explicitly; nothing ever updates it", () => {
  const lectureService = fs.readFileSync(path.join(root, "services", "lecture-service.ts"), "utf8");
  assert.match(lectureService, /client\.note\.create\(\{[\s\S]*?uploadedAt: new Date\(\),[\s\S]*?\}\)/);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name) && /uploadedAt\s*:/.test(fs.readFileSync(path.join(root, rel), "utf8"))) offenders.push(rel);
    }
  };
  for (const dir of ["app", "services", "lib"]) walk(dir);
  // Readers select it (uploadedAt: true), order by it (uploadedAt: { sort: ... }), filter on it
  // (uploadedAt: { gte: ... } / { equals: ... }: not a write's syntax), pass it on or type it;
  // only the upload writes a value.
  const writers = offenders.filter((rel) =>
    /uploadedAt:\s*(?!true\b|Date\b|n\.uploadedAt\b|\{ sort: |\{ gte: |\{ equals: )[^,}\s]/.test(fs.readFileSync(path.join(root, rel), "utf8"))
  );
  assert.deepEqual(writers, ["services/lecture-service.ts"]);
});
