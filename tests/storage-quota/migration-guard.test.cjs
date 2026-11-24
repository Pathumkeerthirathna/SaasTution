/*
 * Teacher storage quota, Stage 3.1: guard for migration
 * 20261116120000_add_teacher_storage_accounting (static checks; no database).
 *
 *   npm run test:storage-quota
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const MIGRATION = "20261116120000_add_teacher_storage_accounting";
const migrationsDir = path.join(root, "prisma", "migrations");
const sql = fs.readFileSync(path.join(migrationsDir, MIGRATION, "migration.sql"), "utf8").replace(/\r\n/g, "\n");
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
const statements = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.replace(/\s+/g, " ").trim())
  .filter(Boolean);

test("only approved migrations follow this one; no earlier migration file changed (git)", () => {
  const all = fs.readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
  // Teacher profile photos (tests/storage-quota/profile-image-migration-guard.test.cjs).
  assert.deepEqual(all.slice(all.indexOf(MIGRATION) + 1), [
    "20261117120000_add_profile_image_reservation_category",
    "20261117120100_add_teacher_profile_image_storage",
    "20261118120000_add_student_password_setup_pending", // student first login (tests/students/first-login-migration-guard.test.cjs)
    "20261119120000_add_email_delivery_tracking", // student email outbox (tests/students/email-delivery-migration-guard.test.cjs)
    "20261120120000_add_class_student_fee_free_card", // Free Cards (tests/fee-waiver/free-card-migration-guard.test.cjs)
    "20261121120000_add_class_payment_access_control", // payment access control (tests/class-access/class-access-migration-guard.test.cjs)
    "20261122120000_add_class_payment_source_and_reversal", // partial payments Stage 1 (tests/fee-waiver/partial-payment-migration-guard.test.cjs)
    "20261123120000_add_class_student_free_card_eligible", // Free Card eligibility Stage 1 (tests/fee-waiver/free-card-eligibility-migration-guard.test.cjs)
    "20261124120000_add_recorded_lecture_publication", // Recorded lecture public profile (tests/recorded-lectures/publication-migration-guard.test.cjs)
    "20261125120000_add_teacher_payment_accounts", // Teacher payment accounts (tests/teacher-profile/role-aware-profile.test.cjs)
    "20261126120000_add_teacher_title_eng", // Teacher title ENG (tests/teacher-profile/teacher-title-eng-migration-guard.test.cjs)
    "20261127120000_add_grade_zero", // Grade 0 (tests/students/grade-zero-migration-guard.test.cjs)
    "20261128120000_add_resource_month_access", // Monthly resource access (tests/class-access/resource-access-migration-guard.test.cjs)
    "20261129120000_add_lecture_is_default", // Default lecture (tests/lectures/default-lecture-migration-guard.test.cjs)
    "20261130120000_add_quiz_answer_snapshots", // Quiz answer snapshots (tests/quizzes/quiz-answer-snapshots.test.cjs)
  ]);
  // The earlier, still uncommitted Stage 2 migration may differ from HEAD; every COMMITTED one must not.
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "prisma/migrations"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(diff, "", "committed migrations are untouched");
});

test("exactly the expected statements, in order", () => {
  const head = (s) => s.split(" (")[0].slice(0, 120);
  assert.deepEqual(statements.map(head), [
    "SET lock_timeout = '5s'",
    'CREATE TYPE "StorageReservationCategory" AS ENUM',
    'CREATE TABLE "TeacherStorageLimit"',
    'CREATE TABLE "TeacherStorageLimitChange"',
    'CREATE TABLE "StorageReservation"',
    'CREATE INDEX "TeacherStorageLimitChange_teacherId_changedAt_idx" ON "TeacherStorageLimitChange"("teacherId", "changedAt")',
    'CREATE UNIQUE INDEX "StorageReservation_storageKey_key" ON "StorageReservation"("storageKey")',
    'CREATE INDEX "StorageReservation_teacherId_expiresAt_idx" ON "StorageReservation"("teacherId", "expiresAt")',
    'CREATE INDEX "StorageReservation_expiresAt_idx" ON "StorageReservation"("expiresAt")',
    'ALTER TABLE "TeacherStorageLimit" ADD CONSTRAINT "TeacherStorageLimit_teacherId_fkey" FOREIGN KEY',
    'ALTER TABLE "TeacherStorageLimitChange" ADD CONSTRAINT "TeacherStorageLimitChange_teacherId_fkey" FOREIGN KEY',
    'ALTER TABLE "StorageReservation" ADD CONSTRAINT "StorageReservation_teacherId_fkey" FOREIGN KEY',
    'ALTER TABLE "TeacherStorageLimit" ADD CONSTRAINT "TeacherStorageLimit_limitBytes_range" CHECK',
    'ALTER TABLE "TeacherStorageLimitChange" ADD CONSTRAINT "TeacherStorageLimitChange_bytes_range" CHECK',
    'ALTER TABLE "StorageReservation" ADD CONSTRAINT "StorageReservation_bytes_range" CHECK',
    "RESET lock_timeout",
  ].map(head));
  assert.match(statements[1], /AS ENUM \('NOTE', 'SUBMISSION'\)$/);
  assert.match(statements[9], /ON DELETE CASCADE ON UPDATE RESTRICT$/);
  assert.match(statements[10], /ON DELETE RESTRICT ON UPDATE RESTRICT$/, "the audit history is never cascaded away");
  assert.match(statements[11], /ON DELETE CASCADE ON UPDATE RESTRICT$/);
});

test("additive only: only CREATE statements and constraints on the NEW tables; no data, column or file changes", () => {
  const code = statements.join(";\n");
  assert.doesNotMatch(code, /\bDROP\b|\bRENAME\b|ALTER COLUMN|\bUPDATE\b(?! RESTRICT)|\bDELETE\b(?! (CASCADE|RESTRICT))|\bINSERT\b|\bTRUNCATE\b|\bDEFAULT\b/i);
  for (const s of statements.filter((x) => x.startsWith("ALTER TABLE"))) {
    assert.match(s, /^ALTER TABLE "(TeacherStorageLimit|TeacherStorageLimitChange|StorageReservation)" /, s.slice(0, 60));
  }
});

// ---- CHECK semantics, evaluated in JS with SQL's three-valued logic --------------------------------------

const MAX = BigInt("1000000000000000");
const inRange = (v) => (v === null ? null : v >= BigInt(0) && v <= MAX);
const and = (...xs) => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const passes = (result) => result !== false; // a CHECK passes unless FALSE

test("CHECKs: limit 0 .. 1 PB (0 is valid); audit columns accept NULL, reject any non-NULL value out of range", () => {
  assert.match(statements[12], /CHECK \("limitBytes" >= 0 AND "limitBytes" <= 1000000000000000\)$/);
  assert.match(statements[13], /\("previousLimitBytes" >= 0 AND "previousLimitBytes" <= 1000000000000000\) AND \("newLimitBytes" >= 0 AND "newLimitBytes" <= 1000000000000000\) AND \("planLimitBytes" >= 0 AND "planLimitBytes" <= 1000000000000000\)/);
  const audit = (p, n, pl) => passes(and(inRange(p), inRange(n), inRange(pl)));
  assert.equal(audit(null, null, null), true);
  assert.equal(audit(null, BigInt(5), null), true);
  assert.equal(audit(BigInt(0), BigInt(0), BigInt(0)), true);
  assert.equal(audit(null, BigInt(-1), null), false, "NULL AND FALSE is FALSE");
  assert.equal(audit(MAX + BigInt(1), null, null), false);
});

test("CHECKs: reservation size 1 .. 2^31-1, expiry after creation, key layout by category, key below the teacher's own folder", () => {
  const s = statements[14];
  assert.match(s, /ADD CONSTRAINT "StorageReservation_bytes_range" CHECK \("bytes" >= 1 AND "bytes" <= 2147483647\)/);
  assert.match(s, /ADD CONSTRAINT "StorageReservation_expiry_after_creation" CHECK \("expiresAt" > "createdAt"\)/);
  assert.match(s, /ADD CONSTRAINT "StorageReservation_storageKey_owner" CHECK \(left\("storageKey", length\('Teachers\/' \|\| "teacherId" \|\| '\/'\)\) = 'Teachers\/' \|\| "teacherId" \|\| '\/'\)$/);

  // The key patterns are the Stage 2 key layouts, so every generated key is accepted.
  const NK = require(path.join(root, "lib", "notes", "storage-keys.ts"));
  const SK = require(path.join(root, "lib", "assignments", "submission-keys.ts"));
  const note = new RegExp(s.match(/"category" = 'NOTE' AND "storageKey" ~ '([^']+)'/)[1]);
  const sub = new RegExp(s.match(/"category" = 'SUBMISSION' AND "storageKey" ~ '([^']+)'/)[1]);
  const t = crypto.randomUUID();
  const nk = NK.noteFileKey({ teacherId: t, lectureId: crypto.randomUUID(), noteId: crypto.randomUUID(), storedName: NK.generateNoteStoredName("image/png") });
  const sk = SK.submissionFileKey({ teacherId: t, lectureId: "l", assignmentId: "a", submissionId: crypto.randomUUID(), storedName: SK.generateSubmissionStoredName() });
  assert.match(nk, note);
  assert.match(sk, sub);
  assert.doesNotMatch(sk, note, "a submission key is not a NOTE reservation");
  assert.doesNotMatch(nk, sub);
  assert.doesNotMatch(`Teachers/${t}/Lectures/l/RecordedLectures/${crypto.randomUUID()}/${"a".repeat(32)}.mp4`, note, "recordings never reserve here");

  // Owner rule as PostgreSQL evaluates it.
  const owner = (teacherId, key) => key.slice(0, `Teachers/${teacherId}/`.length) === `Teachers/${teacherId}/`;
  assert.equal(owner(t, nk), true);
  assert.equal(owner(crypto.randomUUID(), nk), false, "another teacher's key");
  assert.equal(owner("ab", "Teachers/abc/x"), false, "a teacher id that is a prefix of another");
});

test("schema: the three models and the enum, BigInt bytes, no database defaults on timestamps, Teacher relations", () => {
  const body = (name) => schema.slice(schema.indexOf(`model ${name} {`), schema.indexOf("\n}\n", schema.indexOf(`model ${name} {`)));
  assert.match(body("TeacherStorageLimit"), /\n\s+teacherId\s+String\s+@id\n/);
  assert.match(body("TeacherStorageLimit"), /\n\s+limitBytes\s+BigInt\n/);
  assert.match(body("TeacherStorageLimitChange"), /\n\s+newLimitBytes\s+BigInt\?\n/);
  assert.match(body("StorageReservation"), /\n\s+bytes\s+BigInt\n/);
  assert.match(body("StorageReservation"), /\n\s+storageKey String\s+@unique @db\.VarChar\(512\)\n/);
  for (const name of ["TeacherStorageLimit", "TeacherStorageLimitChange", "StorageReservation"]) {
    assert.doesNotMatch(body(name), /DateTime\s+@default\(now\(\)\)|@updatedAt/, `${name}: timestamps come from serverNow()`);
  }
  assert.match(schema, /enum StorageReservationCategory \{\n\s+NOTE\n\s+SUBMISSION\n\s+PROFILE_IMAGE\n\}/, 'PROFILE_IMAGE added later (migration 20261117120000)');
  const teacher = body("Teacher");
  assert.match(teacher, /storageLimit\s+TeacherStorageLimit\?/);
  assert.match(teacher, /storageLimitChanges TeacherStorageLimitChange\[\]/);
  assert.match(teacher, /storageReservations StorageReservation\[\]/);
});
