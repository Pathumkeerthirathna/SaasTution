/*
 * Unified storage, Stage 2: guard for migration
 * 20261115120000_add_unified_file_storage_keys (static checks; no database).
 *
 *   npm run test:storage-migration
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const MIGRATION = "20261115120000_add_unified_file_storage_keys";
const migrationsDir = path.join(root, "prisma", "migrations");
const sql = fs.readFileSync(path.join(migrationsDir, MIGRATION, "migration.sql"), "utf8").replace(/\r\n/g, "\n");
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");

// The trigger function's plpgsql body contains ";": it is taken out (and checked on its own) before splitting.
const withoutComments = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const functionBodies = [...withoutComments.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
const statements = withoutComments
  .replace(/\$\$[\s\S]*?\$\$/g, () => "$$BODY$$")
  .split(";")
  .map((s) => s.replace(/\s+/g, " ").trim())
  .filter(Boolean);

// Migrations approved to follow this one (each has its own guard test).
const LATER_MIGRATIONS = [
  "20261116120000_add_teacher_storage_accounting", // Stage 3.1: tests/storage-quota/migration-guard.test.cjs
  "20261117120000_add_profile_image_reservation_category", // profile photos: tests/storage-quota/profile-image-migration-guard.test.cjs
  "20261117120100_add_teacher_profile_image_storage", // profile photos: tests/storage-quota/profile-image-migration-guard.test.cjs
  "20261118120000_add_student_password_setup_pending", // student first login: tests/students/first-login-migration-guard.test.cjs
  "20261119120000_add_email_delivery_tracking", // student email outbox: tests/students/email-delivery-migration-guard.test.cjs
  "20261120120000_add_class_student_fee_free_card", // Free Cards: tests/fee-waiver/free-card-migration-guard.test.cjs
  "20261121120000_add_class_payment_access_control", // payment access control (tests/class-access/class-access-migration-guard.test.cjs)
  "20261122120000_add_class_payment_source_and_reversal", // partial payments Stage 1 (tests/fee-waiver/partial-payment-migration-guard.test.cjs)
  "20261123120000_add_class_student_free_card_eligible", // Free Card eligibility Stage 1 (tests/fee-waiver/free-card-eligibility-migration-guard.test.cjs)
  "20261124120000_add_recorded_lecture_publication", // Recorded lecture public profile (tests/recorded-lectures/publication-migration-guard.test.cjs)
  "20261125120000_add_teacher_payment_accounts", // Teacher payment accounts (tests/teacher-profile/role-aware-profile.test.cjs)
  "20261126120000_add_teacher_title_eng", // Teacher title ENG (tests/teacher-profile/teacher-title-eng-migration-guard.test.cjs)
  "20261127120000_add_grade_zero", // Grade 0 (tests/students/grade-zero-migration-guard.test.cjs)
  "20261128120000_add_resource_month_access", // Monthly resource access (tests/class-access/resource-access-migration-guard.test.cjs)
  "20261129120000_add_lecture_is_default", // Default lecture (tests/lectures/default-lecture-migration-guard.test.cjs)
];

test("only approved migrations follow this one, and no earlier migration was changed (git)", () => {
  const all = fs.readdirSync(migrationsDir).filter((name) => /^\d{14}_/.test(name)).sort();
  assert.deepEqual(all.slice(all.indexOf(MIGRATION) + 1), LATER_MIGRATIONS);
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "prisma/migrations"], { cwd: root, encoding: "utf8" });
  assert.equal(diff.trim(), "", "historical migrations are untouched");
});

test("exactly the expected statements: lock timeout, Prisma's generated columns + unique indexes, hand-written CHECKs", () => {
  assert.deepEqual(statements, [
    "SET lock_timeout = '5s'",
    'ALTER TABLE "Note" ADD COLUMN "sha256" CHAR(64), ADD COLUMN "storageKey" VARCHAR(512)',
    'ALTER TABLE "AssignmentSubmission" ADD COLUMN "sha256" CHAR(64), ADD COLUMN "storageKey" VARCHAR(512)',
    'CREATE UNIQUE INDEX "Note_storageKey_key" ON "Note"("storageKey")',
    'CREATE UNIQUE INDEX "AssignmentSubmission_storageKey_key" ON "AssignmentSubmission"("storageKey")',
    statements[5],
    statements[6],
    'CREATE FUNCTION "unified_storage_clear_stale_storage_key"() RETURNS trigger LANGUAGE plpgsql AS $$BODY$$',
    'CREATE TRIGGER "Note_clear_stale_storage_key" BEFORE UPDATE OF "fileUrl" ON "Note" FOR EACH ROW EXECUTE PROCEDURE "unified_storage_clear_stale_storage_key"()',
    'CREATE TRIGGER "AssignmentSubmission_clear_stale_storage_key" BEFORE UPDATE OF "fileUrl" ON "AssignmentSubmission" FOR EACH ROW EXECUTE PROCEDURE "unified_storage_clear_stale_storage_key"()',
    "RESET lock_timeout",
  ]);
  assert.match(statements[5], /^ALTER TABLE "Note" ADD CONSTRAINT "Note_sha256_format" CHECK .* ADD CONSTRAINT "Note_storageKey_format" CHECK .* ADD CONSTRAINT "Note_storageKey_requires_sha256" CHECK \("storageKey" IS NULL OR "sha256" IS NOT NULL\)$/);
  assert.match(statements[6], /^ALTER TABLE "AssignmentSubmission" ADD CONSTRAINT "AssignmentSubmission_sha256_format" CHECK .* ADD CONSTRAINT "AssignmentSubmission_storageKey_format" CHECK .* ADD CONSTRAINT "AssignmentSubmission_storageKey_requires_sha256" CHECK \("storageKey" IS NULL OR "sha256" IS NOT NULL\)$/);
});

test("trigger: clears storageKey and sha256 ONLY when fileUrl changes while storageKey does not; changes nothing else", () => {
  assert.deepEqual(functionBodies, [
    'BEGIN IF NEW."fileUrl" IS DISTINCT FROM OLD."fileUrl" AND NEW."storageKey" IS NOT DISTINCT FROM OLD."storageKey" THEN NEW."storageKey" := NULL; NEW."sha256" := NULL; END IF; RETURN NEW; END;',
  ]);
  // The same rule in JS, over the situations the rollback window can produce.
  const trigger = (oldRow, newRow) =>
    newRow.fileUrl !== oldRow.fileUrl && newRow.storageKey === oldRow.storageKey ? { ...newRow, storageKey: null, sha256: null } : newRow;
  const stage2 = { fileUrl: "assignments/a/k1.pdf", storageKey: "Teachers/t/.../k1.pdf", sha256: "1".repeat(64) };
  // The previous version's resubmission: new fileUrl, storageKey untouched -> cleared.
  assert.deepEqual(trigger(stage2, { ...stage2, fileUrl: "assignments/a/1700-abc-x.pdf" }), { fileUrl: "assignments/a/1700-abc-x.pdf", storageKey: null, sha256: null });
  // This version's resubmission: both change -> kept.
  const next = { fileUrl: "assignments/a/k2.pdf", storageKey: "Teachers/t/.../k2.pdf", sha256: "2".repeat(64) };
  assert.deepEqual(trigger(stage2, next), next);
  // A later copy into the new storage (Stage 3): storageKey set, fileUrl unchanged -> kept.
  const legacy = { fileUrl: "lectures/l/1700-abc-n.pdf", storageKey: null, sha256: null };
  const copied = { ...legacy, storageKey: "Teachers/t/.../n.pdf", sha256: "3".repeat(64) };
  assert.deepEqual(trigger(legacy, copied), copied);
  // Other updates (title, marks...) do not fire it at all: BEFORE UPDATE OF "fileUrl".
});

test("additive only: nothing dropped, renamed, retyped, made NOT NULL, defaulted or rewritten; no data changes", () => {
  // The two CREATE TRIGGER statements say "BEFORE UPDATE OF": they define, not run, an update.
  const code = statements.filter((s) => !s.startsWith("CREATE TRIGGER ")).join(";\n");
  assert.equal(statements.filter((s) => s.startsWith("CREATE TRIGGER ")).length, 2);
  assert.doesNotMatch(code, /\bDROP\b|\bRENAME\b|ALTER COLUMN|SET NOT NULL|NOT NULL DEFAULT|\bDEFAULT\b|\bUPDATE\b|\bDELETE\b|\bINSERT\b|\bTRUNCATE\b/i);
  assert.doesNotMatch(code, /"fileUrl"/, "fileUrl is untouched");
});

test("the SHA-256 CHECK accepts exactly 64 lowercase hex characters", () => {
  const pattern = new RegExp(sql.match(/"Note_sha256_format"\s+CHECK \("sha256" ~ '([^']+)'\)/)[1]);
  assert.match("a".repeat(64), pattern);
  assert.match("0123456789abcdef".repeat(4), pattern);
  for (const bad of ["A".repeat(64), "a".repeat(63), "a".repeat(65), `${"a".repeat(63)}g`, ""]) assert.doesNotMatch(bad, pattern);
  assert.equal(sql.match(/"AssignmentSubmission_sha256_format"\s+CHECK \("sha256" ~ '([^']+)'\)/)[1], "^[0-9a-f]{64}$");
});

test("schema: the two optional fields on Note and AssignmentSubmission, unique keys, fileUrl still required", () => {
  for (const model of ["Note", "AssignmentSubmission"]) {
    const body = schema.slice(schema.indexOf(`model ${model} {`), schema.indexOf("\n}\n", schema.indexOf(`model ${model} {`)));
    assert.match(body, /\n\s+storageKey\s+String\?\s+@unique @db\.VarChar\(512\)\n/, model);
    assert.match(body, /\n\s+sha256\s+String\?\s+@db\.Char\(64\)\n/, model);
    assert.match(body, /\n\s+fileUrl\s+String\n/, `${model}.fileUrl unchanged`);
  }
});
