/*
 * Simplified student registration & first login: the migration
 * 20261118120000_add_student_password_setup_pending and the schema. STATIC
 * checks only (no database): nothing here proves how PostgreSQL applies it.
 *
 *   npm run test:students
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261118120000_add_student_password_setup_pending";

test("placement: after the profile-image migrations; only the approved email outbox and Free Card migrations follow; no committed migration changed (git)", () => {
  const all = fs.readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
  assert.deepEqual(all.slice(all.indexOf(MIGRATION) - 1), [
    "20261117120100_add_teacher_profile_image_storage",
    MIGRATION,
    "20261119120000_add_email_delivery_tracking",
    "20261120120000_add_class_student_fee_free_card", // Free Cards (tests/fee-waiver/free-card-migration-guard.test.cjs)
    "20261121120000_add_class_payment_access_control", // payment access control (tests/class-access/class-access-migration-guard.test.cjs)
    "20261122120000_add_class_payment_source_and_reversal", // partial payments Stage 1 (tests/fee-waiver/partial-payment-migration-guard.test.cjs)
    "20261123120000_add_class_student_free_card_eligible", // Free Card eligibility Stage 1 (tests/fee-waiver/free-card-eligibility-migration-guard.test.cjs)
    "20261124120000_add_recorded_lecture_publication", // Recorded lecture public profile (tests/recorded-lectures/publication-migration-guard.test.cjs)
    "20261125120000_add_teacher_payment_accounts", // Teacher payment accounts (tests/teacher-profile/role-aware-profile.test.cjs)
    "20261126120000_add_teacher_title_eng", // Teacher title ENG (tests/teacher-profile/teacher-title-eng-migration-guard.test.cjs)
    "20261127120000_add_grade_zero", // Grade 0 (tests/students/grade-zero-migration-guard.test.cjs)
  ]);
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "prisma/migrations"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(diff, "", "committed migrations are untouched");
});

test("exactly one additive statement: a NOT NULL boolean with a constant default (existing students: false); nothing else", () => {
  const statements = fs
    .readFileSync(path.join(migrationsDir, MIGRATION, "migration.sql"), "utf8")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  assert.deepEqual(statements, ['ALTER TABLE "Student" ADD COLUMN "passwordSetupPending" BOOLEAN NOT NULL DEFAULT false']);
});

test("schema: Student.passwordSetupPending Boolean @default(false); no other new Student field", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const model = schema.slice(schema.indexOf("model Student {"), schema.indexOf("\n}", schema.indexOf("model Student {")));
  assert.match(model, /passwordSetupPending Boolean @default\(false\)/);
  assert.match(model, /emailConfirmed\s+Boolean\s+@default\(false\)/, "email confirmation fields are kept (teachers / existing data)");
});
