/*
 * Static guard for the Recorded Lecture publication migration (public
 * teacher profile integration). No database needed.
 *
 *   npm run test:recorded-lectures
 *
 * The migration adds exactly two columns to "RecordedLecture", reusing the
 * existing enums: "visibility" RecordingVisibility NOT NULL DEFAULT 'PRIVATE'
 * and "access" RecordingAccess NOT NULL DEFAULT 'LOCKED'. Every historical
 * recording therefore reads PRIVATE + LOCKED (nothing becomes public), and a
 * new upload gets the same defaults because the upload never sets them.
 * This test fails if a column changes type, nullability or default, if any
 * statement could publish an existing recording or touch another table, if
 * the migration moves in the order, if the upload starts setting the columns,
 * or if the student access filter starts reading them (enrolled students
 * must keep their access).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261124120000_add_recorded_lecture_publication";
const PREVIOUS = "20261123120000_add_class_student_free_card_eligible";

const normalize = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
const sql = normalize(fs.readFileSync(path.join(migrationsDir, MIGRATION, "migration.sql"), "utf8"));
const statements = sql
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("placement: the latest migration, directly after the Free Card eligibility one", () => {
  const all = fs.readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
  assert.deepEqual(all.slice(all.indexOf(PREVIOUS)), [PREVIOUS, MIGRATION, "20261125120000_add_teacher_payment_accounts", "20261126120000_add_teacher_title_eng", "20261127120000_add_grade_zero"]); // Teacher payment accounts (tests/teacher-profile/role-aware-profile.test.cjs)
  assert.equal(all[all.length - 1], "20261127120000_add_grade_zero");
});

test("exactly two columns on RecordedLecture: PRIVATE / LOCKED defaults, NOT NULL, existing enums", () => {
  assert.deepEqual(statements, [
    "SET lock_timeout = '5s'",
    `ALTER TABLE "RecordedLecture" ADD COLUMN "access" "RecordingAccess" NOT NULL DEFAULT 'LOCKED', ADD COLUMN "visibility" "RecordingVisibility" NOT NULL DEFAULT 'PRIVATE'`,
    "RESET lock_timeout",
  ]);
});

test("historical recordings are never published: no data statement, no PUBLIC / FREE default, nothing else touched", () => {
  assert.doesNotMatch(sql, /\b(UPDATE|INSERT|DELETE|DROP|TRUNCATE|RENAME)\b/i);
  assert.doesNotMatch(sql, /DEFAULT 'PUBLIC'|DEFAULT 'FREE'/);
  assert.doesNotMatch(sql, /ALTER COLUMN|SET LOCAL|CREATE TYPE|ALTER TYPE|CONSTRAINT|INDEX|TRIGGER|FUNCTION/i);
  assert.doesNotMatch(sql, /YouTubeRecording|"Note"|RecordingUploadSession|RecordingUploadChunk/);
});

test("schema.prisma: the two fields on RecordedLecture with the same defaults; the enums are unchanged", () => {
  const schema = read("prisma", "schema.prisma");
  const model = schema.match(/model RecordedLecture \{[\s\S]*?\n\}/);
  assert.ok(model, "RecordedLecture model found");
  assert.match(model[0], /\n\s*visibility\s+RecordingVisibility\s+@default\(PRIVATE\)\s*\n/);
  assert.match(model[0], /\n\s*access\s+RecordingAccess\s+@default\(LOCKED\)\s*\n/);
  const values = (name) => schema.match(new RegExp(`enum ${name} \\{([^}]*)\\}`))[1].split(/\s+/).filter(Boolean);
  assert.deepEqual(values("RecordingVisibility"), ["PUBLIC", "PRIVATE"]);
  assert.deepEqual(values("RecordingAccess"), ["FREE", "LOCKED"]);
});

test("new uploads take the database defaults: the upload lifecycle never sets visibility or access", () => {
  for (const file of [
    "services/recorded-lecture-upload-service.ts",
    "services/recorded-lecture-chunk-service.ts",
    "services/recorded-lecture-completion-service.ts",
    "services/recorded-lecture-maintenance-service.ts",
  ]) {
    assert.doesNotMatch(code(read(file)), /\bvisibility\b|\baccess\s*:/, file);
  }
});

test("enrolled students keep their access: the student filter does not read visibility or access", () => {
  const src = code(read("services", "recorded-lecture-student-service.ts"));
  const start = src.indexOf("export function studentRecordedLectureAccessWhere");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.ok(start > 0 && body.length > 0);
  assert.doesNotMatch(body, /visibility|access\s*:/);
});

test("committed migrations are untouched (git)", () => {
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "prisma/migrations"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(diff, "", "no committed migration changed");
});
