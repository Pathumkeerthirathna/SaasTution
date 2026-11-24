/*
 * Static guard for the default lecture migration (no database):
 * prisma/migrations/20261129120000_add_lecture_is_default.
 *
 *   npm run test:lectures
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261129120000_add_lecture_is_default";

const normalize = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
const raw = fs.readFileSync(path.join(migrationsDir, MIGRATION, "migration.sql"), "utf8");
const sql = normalize(raw);
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");

test("placement: right after monthly resource access; only the approved quiz answer snapshot migration follows; no committed migration changed (git)", () => {
  const all = fs.readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
  assert.deepEqual(all.slice(all.indexOf(MIGRATION) - 1), ["20261128120000_add_resource_month_access", MIGRATION, "20261130120000_add_quiz_answer_snapshots"]);
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "prisma/migrations"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(diff, "", "committed migrations are untouched");
});

test("exactly: lock timeout, the NOT NULL DEFAULT false column, the partial unique index, reset", () => {
  assert.deepEqual(statements, [
    "SET lock_timeout = '5s'",
    'ALTER TABLE "Lecture" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false',
    'CREATE UNIQUE INDEX "Lecture_one_default_per_class" ON "Lecture" ("classId") WHERE "isDefault" = true',
    "RESET lock_timeout",
  ]);
});

test("additive only and NO backfill: no row is inserted or updated, nothing dropped or renamed", () => {
  assert.doesNotMatch(sql, /\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|RENAME)\b|SET LOCAL/i);
  assert.doesNotMatch(sql, /General Notes/, "no default lecture is created by the migration");
});

test("schema.prisma matches: Lecture.isDefault Boolean @default(false), documented with the index; every other Lecture field kept", () => {
  const lecture = schema.slice(schema.indexOf("model Lecture {"), schema.indexOf("\n}", schema.indexOf("model Lecture {")));
  assert.match(lecture, /\n\s+isDefault Boolean @default\(false\)\n/);
  assert.match(lecture, /"Lecture_one_default_per_class"/, "the hand-written partial index is named in the model's comment");
  for (const field of [/id\s+String\s+@id @default\(uuid\(\)\)/, /title\s+String/, /date\s+DateTime/, /endDate\s+DateTime\?/, /classId\s+String/, /classStatus ClassStatus @default\(SCHEDULED\)/, /createdAt\s+DateTime\s+@default\(now\(\)\)/, /status Int @default\(0\)/, /@@index\(\[classId, status, date\]\)/, /@@unique\(\[id, classId\]\)/, /class\s+Class\s+@relation\(fields: \[classId\], references: \[id\]\)/]) {
    assert.match(lecture, field, String(field));
  }
});

test("the manual backfill script is separate from the migration (docs), idempotent and inserts default lectures only", () => {
  const backfill = normalize(fs.readFileSync(path.join(root, "docs", "sql", "default-lecture-backfill.sql"), "utf8"));
  assert.match(backfill, /INSERT INTO "Lecture"/);
  assert.match(backfill, /WHERE NOT EXISTS \( SELECT 1 FROM "Lecture" l WHERE l\."classId" = c\."id" AND l\."isDefault" = true \)/);
  assert.match(backfill, /ON CONFLICT \("classId"\) WHERE "isDefault" = true DO NOTHING/);
  assert.doesNotMatch(backfill, /\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(sql, /\bINSERT\b/, "the migration itself inserts nothing");
});
