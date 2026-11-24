/*
 * Static guard for the payment-due access control migration (no database).
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
const MIGRATION = "20261121120000_add_class_payment_access_control";

const normalize = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
const sql = normalize(fs.readFileSync(path.join(migrationsDir, MIGRATION, "migration.sql"), "utf8"));
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);

test("placement: right after the Free Card one; only the approved partial payment and Free Card eligibility migrations follow; no committed migration changed (git)", () => {
  const all = fs.readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
  assert.deepEqual(all.slice(all.indexOf(MIGRATION) - 1), ["20261120120000_add_class_student_fee_free_card", MIGRATION, "20261122120000_add_class_payment_source_and_reversal", "20261123120000_add_class_student_free_card_eligible", "20261124120000_add_recorded_lecture_publication", "20261125120000_add_teacher_payment_accounts", "20261126120000_add_teacher_title_eng", "20261127120000_add_grade_zero", "20261128120000_add_resource_month_access", "20261129120000_add_lecture_is_default"]);
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "prisma/migrations"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(diff, "", "committed migrations are untouched");
});

test("exactly: lock timeout, the two columns with safe defaults (restriction OFF), the CHECK, reset", () => {
  assert.deepEqual(statements, [
    "SET lock_timeout = '5s'",
    'ALTER TABLE "Class" ADD COLUMN "paymentGracePeriodDays" INTEGER NOT NULL DEFAULT 5, ADD COLUMN "restrictUnpaidStudentAccess" BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE "Class" ADD CONSTRAINT "Class_paymentGracePeriodDays_check" CHECK ("paymentGracePeriodDays" BETWEEN 0 AND 30)',
    "RESET lock_timeout",
  ]);
  assert.doesNotMatch(sql, /\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|RENAME)\b|ALTER COLUMN|SET LOCAL/i);
});

test("schema.prisma declares both settings (the restriction's default is true for NEW classes since 20261128120000; this migration's DEFAULT false kept every existing class off)", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  assert.match(schema, /restrictUnpaidStudentAccess\s+Boolean\s+@default\(true\)/);
  assert.match(schema, /paymentGracePeriodDays\s+Int\s+@default\(5\)/);
});
