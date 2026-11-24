/*
 * Migration guard: 20261127120000_add_grade_zero inserts Grade 0 with the
 * fixed id 0 (lib/grade.ts) and nothing else.
 *
 *   node --test tests/students/grade-zero-migration-guard.test.cjs
 *
 * Data only: no table / column / default / constraint / sequence change, no
 * UPDATE or DELETE of any existing Grade or Student row. Safe to run again
 * (id 0 already "Grade 0" is a no-op); an id 0 with another name, or a
 * "Grade 0" under another id, stops the migration (RAISE EXCEPTION) instead
 * of changing or duplicating a grade. No database is contacted here.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261127120000_add_grade_zero";
const PREVIOUS = "20261126120000_add_teacher_title_eng";

const sql = fs.readFileSync(path.join(migrationsDir, MIGRATION, "migration.sql"), "utf8").replace(/\r\n/g, "\n");
const code = sql.replace(/--.*$/gm, "");

test("placement: the latest migration, right after the ENG one; no committed migration changed (git)", () => {
  const all = fs.readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
  // Followed only by the approved monthly resource access migration (tests/class-access/resource-access-migration-guard.test.cjs).
  assert.deepEqual(all.slice(-3), [PREVIOUS, MIGRATION, "20261128120000_add_resource_month_access"]);
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "prisma/migrations"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(changed, "", "committed migrations are untouched");
});

test("one DO block whose only write is INSERT (0, 'Grade 0', 1) into Grade", () => {
  assert.equal((code.match(/\bDO \$\$/g) || []).length, 1);
  assert.equal((code.match(/\bINSERT\b/gi) || []).length, 1);
  assert.match(code, /INSERT INTO "Grade" \("id", "GradeDesc", "Status"\) VALUES \(0, 'Grade 0', 1\);/);
});

test("additive only: no DDL, no UPDATE / DELETE / TRUNCATE, no sequence or Student change", () => {
  for (const forbidden of [/\bALTER\b/i, /\bCREATE\b/i, /\bDROP\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bTRUNCATE\b/i, /setval|nextval|SEQUENCE/i, /"Student"/]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
});

test("safe on any database: re-run is a no-op; an id 0 with another name or a \"Grade 0\" under another id stops it", () => {
  assert.match(code, /SELECT "GradeDesc" INTO existing_desc FROM "Grade" WHERE "id" = 0;/);
  assert.match(code, /IF lower\(btrim\(existing_desc\)\) = 'grade 0' THEN\s*RAISE NOTICE '[^']*';\s*RETURN;/);
  assert.match(code, /RAISE EXCEPTION 'Grade id 0 already exists as/);
  assert.match(code, /WHERE lower\(btrim\("GradeDesc"\)\) = 'grade 0'/);
  assert.match(code, /RAISE EXCEPTION 'A "Grade 0" grade already exists with id/);
  // The INSERT is reached only after both checks.
  assert.ok(code.indexOf("INSERT INTO") > code.lastIndexOf("RAISE EXCEPTION"));
});

test("schema.prisma is unchanged for Grade / Student.gradeId (no schema change goes with this migration)", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
  const head = execFileSync("git", ["show", "HEAD:prisma/schema.prisma"], { cwd: root, encoding: "utf8" }).replace(/\r\n/g, "\n");
  const gradeModel = (text) => text.match(/model Grade \{[\s\S]*?\n\}/)[0];
  const gradeLines = (text) => text.split("\n").filter((line) => /^\s*grade(Id)?\s/.test(line)).join("\n");
  assert.equal(gradeModel(schema), gradeModel(head));
  assert.equal(gradeLines(schema), gradeLines(head));
  assert.match(gradeLines(schema), /gradeId Int\?\s+@default\(6\)/);
});
