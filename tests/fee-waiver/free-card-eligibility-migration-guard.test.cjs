/*
 * Static guard for the class-level Free Card eligibility migration, Stage 1
 * (no database needed).
 *
 *   npm run test:fee-waiver
 *
 * The migration adds exactly one column, "ClassStudent"."freeCardEligible"
 * BOOLEAN NOT NULL DEFAULT false. This test fails if the column changes type,
 * nullability or default, if any statement could make an existing enrolment
 * eligible or touch another table, if the migration moves in the order, or if
 * the Free Card / partial payment migrations it depends on are edited.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261123120000_add_class_student_free_card_eligible";
const FREE_CARD_MIGRATION = "20261120120000_add_class_student_fee_free_card";
const PAYMENT_ACCESS_MIGRATION = "20261121120000_add_class_payment_access_control";
const PARTIAL_PAYMENT_MIGRATION = "20261122120000_add_class_payment_source_and_reversal";

const normalize = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
const sql = normalize(fs.readFileSync(path.join(migrationsDir, MIGRATION, "migration.sql"), "utf8"));
const statements = sql
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

test("placement: after the Free Card, payment access and partial payment migrations; only approved migrations follow", () => {
  const all = fs.readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
  assert.deepEqual(all.slice(all.indexOf(FREE_CARD_MIGRATION)), [
    FREE_CARD_MIGRATION,
    PAYMENT_ACCESS_MIGRATION,
    PARTIAL_PAYMENT_MIGRATION,
    MIGRATION,
    // Approved later migrations (each with its own guard test).
    "20261124120000_add_recorded_lecture_publication", // Recorded lecture public profile (tests/recorded-lectures/publication-migration-guard.test.cjs)
    "20261125120000_add_teacher_payment_accounts", // Teacher payment accounts (tests/teacher-profile/role-aware-profile.test.cjs)
    "20261126120000_add_teacher_title_eng", // Teacher title ENG (tests/teacher-profile/teacher-title-eng-migration-guard.test.cjs)
    "20261127120000_add_grade_zero", // Grade 0 (tests/students/grade-zero-migration-guard.test.cjs)
    "20261128120000_add_resource_month_access", // Monthly resource access (tests/class-access/resource-access-migration-guard.test.cjs)
    "20261129120000_add_lecture_is_default", // Default lecture (tests/lectures/default-lecture-migration-guard.test.cjs)
    "20261130120000_add_quiz_answer_snapshots", // Quiz answer snapshots (tests/quizzes/quiz-answer-snapshots.test.cjs)
  ]);
});

test("exactly one column: BOOLEAN NOT NULL DEFAULT false on ClassStudent", () => {
  assert.deepEqual(statements, [
    "SET lock_timeout = '5s'",
    `ALTER TABLE "ClassStudent" ADD COLUMN "freeCardEligible" BOOLEAN NOT NULL DEFAULT false`,
    "RESET lock_timeout",
  ]);
});

test("existing enrolments are never made eligible: no data statement, no other default", () => {
  assert.doesNotMatch(sql, /\bUPDATE\b/i);
  assert.doesNotMatch(sql, /\bINSERT\b/i);
  assert.doesNotMatch(sql, /DEFAULT true/i);
  assert.doesNotMatch(sql, /\b(DROP|DELETE|TRUNCATE|RENAME)\b/i);
  assert.doesNotMatch(sql, /ALTER COLUMN|SET LOCAL/i);
  // Nothing else is touched: no fee row, Free Card column, constraint or index.
  assert.doesNotMatch(sql, /ClassStudentFee|freeCardIssued|CONSTRAINT|INDEX/i);
});

test("schema.prisma declares the field on ClassStudent with a false default", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const model = schema.match(/model ClassStudent \{[\s\S]*?\n\}/);
  assert.ok(model, "ClassStudent model found");
  assert.match(model[0], /\n\s*freeCardEligible\s+Boolean\s+@default\(false\)\s*\n/);
  assert.equal(schema.match(/freeCardEligible/g).length, 1, "declared once, on ClassStudent only");
  // Not added: a student-level fee type or a fee-level automatic marker.
  assert.doesNotMatch(schema, /freeCardAutomatic/);
  assert.doesNotMatch(schema, /StudentFeeType/);
});

test("the Free Card and partial payment migrations are committed and untouched (git)", () => {
  const tracked = execFileSync(
    "git",
    ["ls-files", "--", `prisma/migrations/${FREE_CARD_MIGRATION}`, `prisma/migrations/${PARTIAL_PAYMENT_MIGRATION}`],
    { cwd: root, encoding: "utf8" }
  );
  assert.match(tracked, new RegExp(`${FREE_CARD_MIGRATION}/migration\\.sql`));
  assert.match(tracked, new RegExp(`${PARTIAL_PAYMENT_MIGRATION}/migration\\.sql`));
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "prisma/migrations"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert.equal(diff, "", "no committed migration changed");
});
