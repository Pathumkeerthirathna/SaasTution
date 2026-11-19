/*
 * Static guard for the partial payments Stage 1 migration (no database).
 *
 *   npm run test:fee-waiver
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261122120000_add_class_payment_source_and_reversal";

const normalize = (sql) => sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
const sql = normalize(fs.readFileSync(path.join(migrationsDir, MIGRATION, "migration.sql"), "utf8"));
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);

test("placement: right after the payment access one; only the approved Free Card eligibility migration follows; no committed migration changed (git)", () => {
  const all = fs.readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
  assert.deepEqual(all.slice(all.indexOf(MIGRATION) - 1), [
    "20261121120000_add_class_payment_access_control",
    MIGRATION,
    "20261123120000_add_class_student_free_card_eligible",
    "20261124120000_add_recorded_lecture_publication", // Recorded lecture public profile (tests/recorded-lectures/publication-migration-guard.test.cjs)
  ]);
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "prisma/migrations"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(diff, "", "committed migrations are untouched");
});

test("additive only: no existing row or column changed, nothing dropped", () => {
  const withoutFkActions = sql.replace(/ON (DELETE|UPDATE) (CASCADE|SET NULL|RESTRICT|NO ACTION)/g, " ");
  assert.doesNotMatch(withoutFkActions, /\b(DROP|DELETE|TRUNCATE|RENAME)\b/i);
  assert.doesNotMatch(sql, /\bUPDATE "|\bINSERT\b|ALTER COLUMN|SET LOCAL/i);
  for (const statement of statements.filter((s) => /^ALTER TABLE/.test(s))) {
    assert.match(statement, /ADD (COLUMN|CONSTRAINT)/, statement);
  }
  assert.equal(statements[0], "SET lock_timeout = '5s'");
  assert.equal(statements[statements.length - 1], "RESET lock_timeout");
});

test("existing payments: source defaults to STUDENT_SLIP; the new columns are nullable", () => {
  assert.ok(sql.includes(`ADD COLUMN "source" "ClassPaymentSource" NOT NULL DEFAULT 'STUDENT_SLIP'`));
  for (const column of ['"paymentMethod" "ClassPaymentMethod",', '"receivedAt" TIMESTAMP(3),', '"recordedByTeacherId" TEXT,', '"requestKey" TEXT,']) {
    assert.ok(sql.includes(`ADD COLUMN ${column}`), column);
  }
  assert.ok(sql.includes(`CREATE UNIQUE INDEX "ClassPayment_requestKey_key" ON "ClassPayment"("requestKey")`), "idempotency key");
});

test("reversals are their own append-only rows; CHECKs keep the audit data consistent", () => {
  assert.ok(sql.includes(`CREATE TABLE "ClassPaymentReversal" (`));
  assert.ok(sql.includes(`CREATE UNIQUE INDEX "ClassPaymentReversal_paymentId_key"`), "one reversal per payment");
  assert.ok(
    sql.includes(
      `CHECK ( ("source" = 'STUDENT_SLIP' AND "paymentMethod" IS NULL AND "receivedAt" IS NULL AND "recordedByTeacherId" IS NULL) OR ("source" = 'TEACHER_RECORDED' AND "paymentMethod" IS NOT NULL AND "receivedAt" IS NOT NULL AND "status" = 'CONFIRMED' AND "amount" > 0) )`
    )
  );
  assert.ok(sql.includes(`CHECK ("amount" > 0)`));
  assert.ok(sql.includes(`CHECK (length(btrim("reason")) BETWEEN 3 AND 500)`));
  assert.ok(sql.includes(`CHECK ("requestKey" IS NULL OR length("requestKey") BETWEEN 8 AND 100)`));
});

test("schema.prisma declares the same model", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  assert.match(schema, /source\s+ClassPaymentSource\s+@default\(STUDENT_SLIP\)/);
  assert.match(schema, /requestKey\s+String\?\s+@unique/);
  assert.match(schema, /model ClassPaymentReversal \{[\s\S]*paymentId\s+String\s+@unique/);
});
