/*
 * Migration guard: 20261126120000_add_teacher_title_eng adds the ENG value to
 * the TeacherTitle enum, and nothing else.
 *
 *   node --test tests/teacher-profile/teacher-title-eng-migration-guard.test.cjs
 *
 * Created with `prisma migrate diff` (schema without ENG -> with ENG), never
 * `migrate dev`: the history cannot be replayed on a shadow database
 * (20260831035259 adds MaterialBundle.status before the rename that frees the
 * name; real databases ran it after the rename). No existing migration is
 * touched.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261126120000_add_teacher_title_eng";
const PREVIOUS = "20261125120000_add_teacher_payment_accounts";

test("exactly one statement: ALTER TYPE \"TeacherTitle\" ADD VALUE 'ENG' (additive; nothing else in the migration)", () => {
  const sql = fs.readFileSync(path.join(migrationsDir, MIGRATION, "migration.sql"), "utf8");
  assert.equal(sql.replace(/\r\n/g, "\n"), "ALTER TYPE \"TeacherTitle\" ADD VALUE 'ENG';\n");
});

test("placement: right after the teacher payment accounts one; only the approved Grade 0 migration follows; no committed migration changed (git)", () => {
  const all = fs.readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
  assert.deepEqual(all.slice(all.indexOf(PREVIOUS)), [PREVIOUS, MIGRATION, "20261127120000_add_grade_zero", "20261128120000_add_resource_month_access", "20261129120000_add_lecture_is_default", "20261130120000_add_quiz_answer_snapshots"]);
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "prisma/migrations"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(changed, "", "committed migrations are untouched");
});

test("schema.prisma: TeacherTitle has ENG after the existing values", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
  assert.match(schema, /enum TeacherTitle \{\s*MR\s+MRS\s+MS\s+DR\s+PROF\s+ENG\s*\}/);
});

test("lib/teacher-title: ENG is labelled 'Eng.' and offered last; the existing titles are unchanged", () => {
  const titles = require(path.join(root, "lib", "teacher-title.ts"));
  assert.deepEqual(titles.TEACHER_TITLE_LABELS, { MR: "Mr.", MRS: "Mrs.", MS: "Ms.", DR: "Dr.", PROF: "Prof.", ENG: "Eng." });
  assert.deepEqual(titles.TEACHER_TITLE_OPTIONS, ["MR", "MRS", "MS", "DR", "PROF", "ENG"]);
  assert.equal(titles.formatTeacherTitle("ENG"), "Eng.");
  assert.equal(titles.formatTeacherFullName({ name: "Nimal Perera", profile: { title: "ENG", displayName: null } }), "Eng. Nimal Perera");
});
