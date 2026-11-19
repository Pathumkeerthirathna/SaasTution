/*
 * Student email delivery outbox: the migration
 * 20261119120000_add_email_delivery_tracking and the schema. STATIC checks
 * only (the SQL is read as text). The PostgreSQL behaviour is covered by
 * tests/students/email-delivery.db.test.cjs (needs a disposable local DB).
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
const MIGRATION = "20261119120000_add_email_delivery_tracking";

const statements = () =>
  fs
    .readFileSync(path.join(migrationsDir, MIGRATION, "migration.sql"), "utf8")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

test("placement: right after the student first-login one; only the approved Free Card migration follows; no committed migration changed (git)", () => {
  const all = fs.readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
  assert.deepEqual(all.slice(all.indexOf(MIGRATION) - 1), [
    "20261118120000_add_student_password_setup_pending",
    MIGRATION,
    "20261120120000_add_class_student_fee_free_card", // Free Cards (tests/fee-waiver/free-card-migration-guard.test.cjs)
    "20261121120000_add_class_payment_access_control", // payment access control (tests/class-access/class-access-migration-guard.test.cjs)
    "20261122120000_add_class_payment_source_and_reversal", // partial payments Stage 1 (tests/fee-waiver/partial-payment-migration-guard.test.cjs)
    "20261123120000_add_class_student_free_card_eligible", // Free Card eligibility Stage 1 (tests/fee-waiver/free-card-eligibility-migration-guard.test.cjs)
    "20261124120000_add_recorded_lecture_publication", // Recorded lecture public profile (tests/recorded-lectures/publication-migration-guard.test.cjs)
  ]);
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "prisma/migrations"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(diff, "", "committed migrations are untouched");
});

test("additive only: two enums, one table, indexes, two cascading foreign keys, two CHECKs; lock timeout first and last", () => {
  const s = statements();
  assert.equal(s[0], "SET lock_timeout = '5s'");
  assert.equal(s[s.length - 1], "RESET lock_timeout");
  const all = s.join(";\n");
  assert.doesNotMatch(all, /DROP |DELETE FROM|UPDATE "|TRUNCATE|RENAME|ALTER TABLE "(Student|Teacher)"/i, "no existing table or row is changed");
  assert.match(all, /CREATE TYPE "EmailDeliveryType" AS ENUM \('STUDENT_WELCOME', 'STUDENT_CREDENTIAL_RESEND'\)/);
  assert.match(all, /CREATE TYPE "EmailDeliveryStatus" AS ENUM \('PENDING', 'PROCESSING', 'SENT', 'FAILED'\)/);
  assert.equal((all.match(/CREATE TABLE/g) || []).length, 1);
  assert.match(all, /CREATE UNIQUE INDEX "EmailDelivery_idempotencyKey_key" ON "EmailDelivery"\("idempotencyKey"\)/);
  assert.match(all, /CREATE UNIQUE INDEX "EmailDelivery_activeOperationKey_key" ON "EmailDelivery"\("activeOperationKey"\)/);
  assert.match(all, /CREATE INDEX "EmailDelivery_status_nextRetryAt_idx"/);
  assert.match(all, /CREATE INDEX "EmailDelivery_status_processingLeaseExpiresAt_idx"/);
  assert.match(all, /CREATE INDEX "EmailDelivery_teacherId_createdAt_idx"/);
  assert.match(all, /FOREIGN KEY \("studentId"\) REFERENCES "Student"\("id"\) ON DELETE CASCADE/);
  assert.match(all, /FOREIGN KEY \("teacherId"\) REFERENCES "Teacher"\("id"\) ON DELETE CASCADE/);
  assert.match(all, /CHECK \("attemptCount" >= 0 AND "maxAttempts" >= 1\)/);
  assert.match(all, /CHECK \("status" <> 'SENT' OR "sentAt" IS NOT NULL\)/);
});

test("no column can hold a plaintext password or an email body (only the encrypted payload and bcrypt / SHA-256 values)", () => {
  const table = statements().find((s) => s.startsWith('CREATE TABLE "EmailDelivery"'));
  const columns = [...table.matchAll(/"([A-Za-z]+)" [A-Z]/g)].map((m) => m[1]);
  for (const column of columns) {
    assert.doesNotMatch(column, /^(password|temporaryPassword|body|html|text|content)$/i, column);
  }
  assert.ok(columns.includes("encryptedPayload"));
  assert.ok(columns.includes("pendingPasswordHash"));
});

test("schema: EmailDelivery model with the requested fields, relations to Student and Teacher", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const model = schema.slice(schema.indexOf("model EmailDelivery {"), schema.indexOf("\n}", schema.indexOf("model EmailDelivery {")));
  for (const field of [
    "studentId", "teacherId", "initiatedBy", "recipientEmail", "emailType", "status", "attemptCount", "maxAttempts",
    "nextRetryAt", "lastAttemptAt", "createdAt", "updatedAt", "sentAt", "providerMessageId", "lastErrorCode",
    "lastErrorMessage", "idempotencyKey", "processingStartedAt", "processingLeaseExpiresAt",
  ]) {
    assert.match(model, new RegExp(`\\n\\s+${field}\\s`), field);
  }
  assert.match(model, /idempotencyKey String\s+@unique/);
  assert.match(model, /activeOperationKey\s+String\?\s+@unique/);
  assert.match(model, /student Student @relation\(fields: \[studentId\], references: \[id\], onDelete: Cascade/);
});
