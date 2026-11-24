/*
 * Teacher profile photos on unified storage: the two migrations
 *   20261117120000_add_profile_image_reservation_category
 *   20261117120100_add_teacher_profile_image_storage
 * and the Prisma schema. STATIC checks only (no database): the SQL is
 * read as text. Nothing here proves how PostgreSQL applies it.
 *
 *   npm run test:storage-quota
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const ENUM_MIGRATION = "20261117120000_add_profile_image_reservation_category";
const MIGRATION = "20261117120100_add_teacher_profile_image_storage";

const statementsOf = (name) =>
  fs
    .readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

test("placement: the two migrations follow the storage accounting one, in this order (only approved migrations after them); no committed migration changed (git)", () => {
  const all = fs.readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
  const at = all.indexOf("20261116120000_add_teacher_storage_accounting");
  assert.deepEqual(all.slice(at, at + 3), ["20261116120000_add_teacher_storage_accounting", ENUM_MIGRATION, MIGRATION]);
  // Approved later migrations (each with its own guard test).
  assert.deepEqual(all.slice(at + 3), [
    "20261118120000_add_student_password_setup_pending",
    "20261119120000_add_email_delivery_tracking",
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
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "prisma/migrations"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(diff, "", "committed migrations are untouched");
});

test("1 of 2: ONLY the enum value (ALTER TYPE ... ADD VALUE cannot share a transaction with its first use)", () => {
  assert.deepEqual(statementsOf(ENUM_MIGRATION), [`ALTER TYPE "StorageReservationCategory" ADD VALUE 'PROFILE_IMAGE'`]);
});

test("2 of 2: additive only - nullable columns, unique index, CHECKs, the reservation key CHECK replaced; lock timeout first and last", () => {
  const s = statementsOf(MIGRATION);
  assert.equal(s[0], "SET lock_timeout = '5s'");
  assert.equal(s[s.length - 1], "RESET lock_timeout");
  assert.equal(
    s[1],
    'ALTER TABLE "TeacherProfile" ADD COLUMN "profileImageMimeType" VARCHAR(32), ADD COLUMN "profileImageSha256" CHAR(64), ADD COLUMN "profileImageSizeBytes" INTEGER, ADD COLUMN "profileImageStorageKey" VARCHAR(512)'
  );
  assert.equal(s[2], 'CREATE UNIQUE INDEX "TeacherProfile_profileImageStorageKey_key" ON "TeacherProfile"("profileImageStorageKey")');
  const all = s.join(";\n");
  assert.doesNotMatch(all, /\bNOT NULL\b(?![^(]*IS)/, "no NOT NULL column");
  assert.doesNotMatch(all, /DROP (TABLE|COLUMN|INDEX)|DELETE FROM|UPDATE "|TRUNCATE|RENAME/i, "nothing dropped, deleted, rewritten or renamed");
  assert.equal((all.match(/DROP CONSTRAINT/g) || []).length, 1, "only the reservation key CHECK is replaced");
  assert.match(all, /ALTER TABLE "StorageReservation" DROP CONSTRAINT "StorageReservation_storageKey_format"/);
  assert.doesNotMatch(all, /profileImageUrl/, "the display URL column is not touched");
});

test("CHECKs: all-or-none, exact key format, owner prefix, digest, size 1..2 MB, allowed types, extension matches type", () => {
  const all = statementsOf(MIGRATION).join(";\n");
  for (const name of [
    "TeacherProfile_profileImage_all_or_none",
    "TeacherProfile_profileImageStorageKey_format",
    "TeacherProfile_profileImageStorageKey_owner",
    "TeacherProfile_profileImageSha256_format",
    "TeacherProfile_profileImageSizeBytes_range",
    "TeacherProfile_profileImageMimeType_allowed",
    "TeacherProfile_profileImage_extension_matches",
  ]) {
    assert.match(all, new RegExp(`ADD CONSTRAINT "${name}"`), name);
  }
  assert.match(all, /CHECK \("profileImageSizeBytes" BETWEEN 1 AND 2097152\)/);
  assert.match(all, /CHECK \("profileImageMimeType" IN \('image\/jpeg', 'image\/png', 'image\/webp'\)\)/);
  assert.match(all, /left\("profileImageStorageKey", length\('Teachers\/' \|\| "teacherId" \|\| '\/'\)\) = 'Teachers\/' \|\| "teacherId" \|\| '\/'/);

  // The SQL key pattern is the key module's pattern (same accepted and refused keys).
  const sqlPattern = new RegExp(all.match(/"TeacherProfile_profileImageStorageKey_format" CHECK \("profileImageStorageKey" ~ '([^']+)'\)/)[1]);
  require("tsx/cjs/api").register();
  const K = require(path.join(root, "lib", "profile-images", "storage-keys.ts"));
  const good = K.profilePhotoKey({ teacherId: "teacher-1", storedName: K.generateProfilePhotoStoredName("image/webp") });
  assert.ok(sqlPattern.test(good));
  for (const bad of ["Teachers/t/Profile/Photo/../x.jpg", "/Teachers/t/Profile/Photo/" + "a".repeat(32) + ".jpg", "Teachers/t/Profile/Photo/" + "a".repeat(32) + ".svg", "Teachers/t/Profile/" + "a".repeat(32) + ".jpg"]) {
    assert.equal(sqlPattern.test(bad), false, bad);
    assert.equal(K.parseProfilePhotoKey(bad), null, bad);
  }
});

test("reservation key CHECK: NOTE and SUBMISSION patterns unchanged; PROFILE_IMAGE added (category compared as text)", () => {
  const all = statementsOf(MIGRATION).join(";\n");
  const accounting = statementsOf("20261116120000_add_teacher_storage_accounting").join(";\n");
  const pattern = (sql, category) => sql.match(new RegExp(`"category"(?:::text)? = '${category}' AND "storageKey" ~ '([^']+)'`))[1];
  assert.equal(pattern(all, "NOTE"), pattern(accounting, "NOTE"));
  assert.equal(pattern(all, "SUBMISSION"), pattern(accounting, "SUBMISSION"));
  assert.equal(pattern(all, "PROFILE_IMAGE"), "^Teachers/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Profile/Photo/[0-9a-f]{32}\\.(jpg|png|webp)$");
});

test("schema: the four nullable TeacherProfile columns, unique key, PROFILE_IMAGE; profileImageUrl kept", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const model = schema.slice(schema.indexOf("model TeacherProfile {"), schema.indexOf("\n}", schema.indexOf("model TeacherProfile {")));
  assert.match(model, /profileImageUrl String\?/);
  assert.match(model, /profileImageStorageKey String\? @unique @db\.VarChar\(512\)/);
  assert.match(model, /profileImageSha256\s+String\? @db\.Char\(64\)/);
  assert.match(model, /profileImageSizeBytes\s+Int\?/);
  assert.match(model, /profileImageMimeType\s+String\? @db\.VarChar\(32\)/);
  assert.match(schema, /enum StorageReservationCategory \{\n\s+NOTE\n\s+SUBMISSION\n\s+PROFILE_IMAGE\n\}/);
});
