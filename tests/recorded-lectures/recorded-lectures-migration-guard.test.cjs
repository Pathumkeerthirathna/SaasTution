/*
 * Static guard for the Recorded Lectures database migration (RL-2). No
 * database is needed or touched.
 *
 *   node --test tests/recorded-lectures/recorded-lectures-migration-guard.test.cjs
 *
 * The migration holds hand-written CHECK constraints and a partial unique
 * index that Prisma 5.22 cannot express (it ignores CHECKs, and a later
 * `prisma migrate dev` may report the partial index as drift; `prisma db push`
 * would create neither). This test fails if any of them is lost or altered,
 * if another migration mentions them, if the migration ever becomes
 * destructive or touches existing tables beyond the one additive "Class"
 * unique index, if an ownership foreign key or its delete / update rule
 * changes, or if the database limits drift away from the RL-1 code
 * (configuration maximums, key formats, MP4 codec strings).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("tsx/cjs/api").register();

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261114120000_add_recorded_lectures";
const NEW_TABLES = ["RecordedLecture", "RecordingUploadSession", "RecordingUploadChunk"];

// Comments removed, whitespace collapsed, no space just inside parentheses.
const normalize = (sql) =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();

const migrationPath = (name) => path.join(migrationsDir, name, "migration.sql");
const read = (name) => normalize(fs.readFileSync(migrationPath(name), "utf8"));
const sql = read(MIGRATION);
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const block = (kind, name) => (schema.match(new RegExp(`\\n${kind} ${name} \\{[\\s\\S]*?\\n\\}`)) ?? [""])[0];

const otherMigrations = () =>
  fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== MIGRATION && fs.existsSync(migrationPath(d.name)))
    .map((d) => d.name);

const UUID = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

// Every hand-written CHECK constraint, with its exact definition.
const CHECKS = {
  RecordedLecture_key_ids_format_check: `"RecordedLecture" CHECK ("id" ~ ${UUID} AND "lectureId" ~ ${UUID} AND "teacherId" ~ ${UUID})`,
  RecordedLecture_title_check: `"RecordedLecture" CHECK (btrim("title") <> '')`,
  RecordedLecture_partNumber_check: `"RecordedLecture" CHECK ("partNumber" >= 1)`,
  RecordedLecture_displayFileName_check: `"RecordedLecture" CHECK (char_length("displayFileName") >= 5 AND right("displayFileName", 4) = '.mp4')`,
  RecordedLecture_mimeType_check: `"RecordedLecture" CHECK ("mimeType" = 'video/mp4')`,
  RecordedLecture_sizeBytes_check: `"RecordedLecture" CHECK ("sizeBytes" BETWEEN 1 AND 64000000000)`,
  RecordedLecture_storedFileName_check: `"RecordedLecture" CHECK ("storedFileName" IS NULL OR "storedFileName" ~ '^[0-9a-f]{32}\\.mp4$')`,
  RecordedLecture_durationSeconds_check: `"RecordedLecture" CHECK ("durationSeconds" IS NULL OR "durationSeconds" BETWEEN 1 AND 172800)`,
  RecordedLecture_width_check: `"RecordedLecture" CHECK ("width" IS NULL OR "width" BETWEEN 1 AND 65535)`,
  RecordedLecture_height_check: `"RecordedLecture" CHECK ("height" IS NULL OR "height" BETWEEN 1 AND 65535)`,
  RecordedLecture_videoCodec_check: `"RecordedLecture" CHECK ("videoCodec" IS NULL OR "videoCodec" ~ '^avc[13]\\.[0-9A-F]{6}$')`,
  RecordedLecture_audioCodec_check: `"RecordedLecture" CHECK ("audioCodec" IS NULL OR "audioCodec" IN ('mp4a.40.2', 'mp4a.40.5', 'mp4a.40.29'))`,
  RecordedLecture_failureCode_check: `"RecordedLecture" CHECK (("state" = 'FAILED') = ("failureCode" IS NOT NULL) AND ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'))`,
  RecordedLecture_readyAt_check: `"RecordedLecture" CHECK (("state" = 'READY') = ("readyAt" IS NOT NULL))`,
  RecordedLecture_failedAt_check: `"RecordedLecture" CHECK (("state" = 'FAILED') = ("failedAt" IS NOT NULL))`,
  RecordedLecture_ready_metadata_check: `"RecordedLecture" CHECK ("state" <> 'READY' OR ("storedFileName" IS NOT NULL AND "durationSeconds" IS NOT NULL AND "videoCodec" IS NOT NULL AND "audioCodec" IS NOT NULL AND "fragmented" IS NOT NULL))`,
  RecordedLecture_status_check: `"RecordedLecture" CHECK ("status" IN (0, 1, 2))`,
  RecordedLecture_deletedAt_check: `"RecordedLecture" CHECK (("status" = 0) = ("deletedAt" IS NULL))`,
  RecordedLecture_deletedBy_check: `"RecordedLecture" CHECK ("deletedByTeacherId" IS NULL OR "deletedAt" IS NOT NULL)`,
  RecordedLecture_purgeRequestedAt_check: `"RecordedLecture" CHECK (("status" = 2) = ("purgeRequestedAt" IS NOT NULL))`,
  RecordedLecture_purgedAt_check: `"RecordedLecture" CHECK (("status" = 1) = ("purgedAt" IS NOT NULL))`,

  RecordingUploadSession_id_format_check: `"RecordingUploadSession" CHECK ("id" ~ ${UUID})`,
  RecordingUploadSession_expectedBytes_check: `"RecordingUploadSession" CHECK ("expectedBytes" BETWEEN 1 AND 64000000000)`,
  RecordingUploadSession_receivedBytes_check: `"RecordingUploadSession" CHECK ("receivedBytes" >= 0 AND "receivedBytes" <= "expectedBytes")`,
  RecordingUploadSession_chunkCount_check: `"RecordingUploadSession" CHECK ("chunkCount" >= 0 AND "chunkCount" <= "receivedBytes" AND ("chunkCount" = 0) = ("receivedBytes" = 0))`,
  RecordingUploadSession_lease_all_or_none_check: `"RecordingUploadSession" CHECK (("leaseToken" IS NULL AND "leaseOffset" IS NULL AND "leaseBytes" IS NULL AND "leaseGrantedAt" IS NULL AND "leaseExpiresAt" IS NULL) OR ("leaseToken" IS NOT NULL AND "leaseOffset" IS NOT NULL AND "leaseBytes" IS NOT NULL AND "leaseGrantedAt" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL))`,
  RecordingUploadSession_leaseToken_check: `"RecordingUploadSession" CHECK ("leaseToken" IS NULL OR "leaseToken" ~ '^[0-9a-f]{64}$')`,
  RecordingUploadSession_leaseOffset_check: `"RecordingUploadSession" CHECK ("leaseOffset" IS NULL OR "leaseOffset" = "receivedBytes")`,
  RecordingUploadSession_leaseBytes_check: `"RecordingUploadSession" CHECK ("leaseBytes" IS NULL OR ("leaseBytes" BETWEEN 1 AND 67108864 AND "leaseBytes" <= "expectedBytes" - "receivedBytes"))`,
  RecordingUploadSession_leaseExpiresAt_check: `"RecordingUploadSession" CHECK ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" > "leaseGrantedAt")`,
  RecordingUploadSession_lease_only_active_check: `"RecordingUploadSession" CHECK ("leaseToken" IS NULL OR "state" = 'ACTIVE')`,
  RecordingUploadSession_complete_bytes_check: `"RecordingUploadSession" CHECK ("state" NOT IN ('COMPLETING', 'COMPLETED') OR "receivedBytes" = "expectedBytes")`,
  RecordingUploadSession_endedAt_check: `"RecordingUploadSession" CHECK (("state" IN ('COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED')) = ("endedAt" IS NOT NULL))`,
  RecordingUploadSession_failureCode_check: `"RecordingUploadSession" CHECK (("state" = 'FAILED') = ("failureCode" IS NOT NULL) AND ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'))`,
  RecordingUploadSession_expiresAt_check: `"RecordingUploadSession" CHECK ("expiresAt" > "createdAt")`,
  RecordingUploadSession_version_check: `"RecordingUploadSession" CHECK ("version" >= 0)`,

  RecordingUploadChunk_position_check: `"RecordingUploadChunk" CHECK ("chunkIndex" >= 0 AND "startOffset" >= 0 AND ("chunkIndex" = 0) = ("startOffset" = 0))`,
  RecordingUploadChunk_byteLength_check: `"RecordingUploadChunk" CHECK ("byteLength" BETWEEN 1 AND 67108864)`,
  RecordingUploadChunk_end_check: `"RecordingUploadChunk" CHECK ("startOffset" + "byteLength" <= 64000000000)`,
  RecordingUploadChunk_leaseToken_check: `"RecordingUploadChunk" CHECK ("leaseToken" ~ '^[0-9a-f]{64}$')`,
  RecordingUploadChunk_sha256_check: `"RecordingUploadChunk" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')`,
};

const PARTIAL_INDEX = "RecordedLecture_active_part_number_key";
const PARTIAL_INDEX_SQL = `CREATE UNIQUE INDEX "${PARTIAL_INDEX}" ON "RecordedLecture" ("lectureId", "partNumber") WHERE "status" = 0 AND "state" <> 'FAILED'`;

const FOREIGN_KEYS = [
  `ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_lectureId_classId_fkey" FOREIGN KEY ("lectureId", "classId") REFERENCES "Lecture"("id", "classId") ON DELETE CASCADE ON UPDATE RESTRICT`,
  `ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_classId_teacherId_fkey" FOREIGN KEY ("classId", "teacherId") REFERENCES "Class"("id", "teacherId") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  `ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  `ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_deletedByTeacherId_fkey" FOREIGN KEY ("deletedByTeacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
  `ALTER TABLE "RecordingUploadSession" ADD CONSTRAINT "RecordingUploadSession_recordedLectureId_teacherId_fkey" FOREIGN KEY ("recordedLectureId", "teacherId") REFERENCES "RecordedLecture"("id", "teacherId") ON DELETE CASCADE ON UPDATE RESTRICT`,
  `ALTER TABLE "RecordingUploadChunk" ADD CONSTRAINT "RecordingUploadChunk_uploadSessionId_fkey" FOREIGN KEY ("uploadSessionId") REFERENCES "RecordingUploadSession"("id") ON DELETE CASCADE ON UPDATE RESTRICT`,
];

const UNIQUE_INDEXES = [
  `CREATE UNIQUE INDEX "Class_id_teacherId_key" ON "Class"("id", "teacherId")`,
  `CREATE UNIQUE INDEX "RecordedLecture_id_teacherId_key" ON "RecordedLecture"("id", "teacherId")`,
  `CREATE UNIQUE INDEX "RecordingUploadSession_recordedLectureId_teacherId_key" ON "RecordingUploadSession"("recordedLectureId", "teacherId")`,
  `CREATE UNIQUE INDEX "RecordingUploadSession_leaseToken_key" ON "RecordingUploadSession"("leaseToken")`,
  `CREATE UNIQUE INDEX "RecordingUploadChunk_uploadSessionId_chunkIndex_key" ON "RecordingUploadChunk"("uploadSessionId", "chunkIndex")`,
  `CREATE UNIQUE INDEX "RecordingUploadChunk_uploadSessionId_startOffset_key" ON "RecordingUploadChunk"("uploadSessionId", "startOffset")`,
  `CREATE UNIQUE INDEX "RecordingUploadChunk_leaseToken_key" ON "RecordingUploadChunk"("leaseToken")`,
];

// The Prisma-generated part, pinned statement by statement (as in the attendance guard).
// Every column: [name, exact SQL type and NULL / NOT NULL / DEFAULT definition].
const COLUMNS = {
  RecordedLecture: [
    ["id", "TEXT NOT NULL"],
    ["lectureId", "TEXT NOT NULL"],
    ["classId", "TEXT NOT NULL"],
    ["teacherId", "TEXT NOT NULL"],
    ["title", "VARCHAR(200) NOT NULL"],
    ["partNumber", "INTEGER NOT NULL"],
    ["displayFileName", "VARCHAR(200) NOT NULL"],
    ["mimeType", "VARCHAR(32) NOT NULL"],
    ["sizeBytes", "BIGINT NOT NULL"],
    ["storedFileName", "VARCHAR(36)"],
    ["durationSeconds", "INTEGER"],
    ["width", "INTEGER"],
    ["height", "INTEGER"],
    ["videoCodec", "VARCHAR(32)"],
    ["audioCodec", "VARCHAR(32)"],
    ["fragmented", "BOOLEAN"],
    ["state", `"RecordedLectureState" NOT NULL`],
    ["failureCode", "VARCHAR(64)"],
    ["status", "INTEGER NOT NULL DEFAULT 0"],
    ["deletedAt", "TIMESTAMP(3)"],
    ["deletedByTeacherId", "TEXT"],
    ["purgeRequestedAt", "TIMESTAMP(3)"],
    ["purgedAt", "TIMESTAMP(3)"],
    ["createdAt", "TIMESTAMP(3) NOT NULL"],
    ["updatedAt", "TIMESTAMP(3) NOT NULL"],
    ["readyAt", "TIMESTAMP(3)"],
    ["failedAt", "TIMESTAMP(3)"],
  ],
  RecordingUploadSession: [
    ["id", "TEXT NOT NULL"],
    ["recordedLectureId", "TEXT NOT NULL"],
    ["teacherId", "TEXT NOT NULL"],
    ["expectedBytes", "BIGINT NOT NULL"],
    ["receivedBytes", "BIGINT NOT NULL DEFAULT 0"],
    ["chunkCount", "INTEGER NOT NULL DEFAULT 0"],
    ["state", `"RecordingUploadState" NOT NULL`],
    ["failureCode", "VARCHAR(64)"],
    ["leaseToken", "CHAR(64)"],
    ["leaseOffset", "BIGINT"],
    ["leaseBytes", "INTEGER"],
    ["leaseGrantedAt", "TIMESTAMP(3)"],
    ["leaseExpiresAt", "TIMESTAMP(3)"],
    ["expiresAt", "TIMESTAMP(3) NOT NULL"],
    ["lastActivityAt", "TIMESTAMP(3) NOT NULL"],
    ["createdAt", "TIMESTAMP(3) NOT NULL"],
    ["updatedAt", "TIMESTAMP(3) NOT NULL"],
    ["endedAt", "TIMESTAMP(3)"],
    ["version", "INTEGER NOT NULL DEFAULT 0"],
  ],
  RecordingUploadChunk: [
    ["id", "TEXT NOT NULL"],
    ["uploadSessionId", "TEXT NOT NULL"],
    ["chunkIndex", "INTEGER NOT NULL"],
    ["startOffset", "BIGINT NOT NULL"],
    ["byteLength", "INTEGER NOT NULL"],
    ["leaseToken", "CHAR(64) NOT NULL"],
    ["sha256", "CHAR(64)"],
    ["receivedAt", "TIMESTAMP(3) NOT NULL"],
  ],
};

const createTableSql = (table) =>
  normalize(
    `CREATE TABLE "${table}" (${COLUMNS[table].map(([name, type]) => `"${name}" ${type}`).join(", ")}, ` +
      `CONSTRAINT "${table}_pkey" PRIMARY KEY ("id"))`
  );

const ENUM_SQL = [
  `CREATE TYPE "RecordedLectureState" AS ENUM ('UPLOADING', 'VERIFYING', 'READY', 'FAILED')`,
  `CREATE TYPE "RecordingUploadState" AS ENUM ('ACTIVE', 'COMPLETING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED')`,
];

const REGULAR_INDEXES = [
  `CREATE INDEX "RecordedLecture_lectureId_status_state_partNumber_idx" ON "RecordedLecture"("lectureId", "status", "state", "partNumber")`,
  `CREATE INDEX "RecordedLecture_teacherId_createdAt_idx" ON "RecordedLecture"("teacherId", "createdAt")`,
  `CREATE INDEX "RecordedLecture_classId_idx" ON "RecordedLecture"("classId")`,
  `CREATE INDEX "RecordingUploadSession_teacherId_state_idx" ON "RecordingUploadSession"("teacherId", "state")`,
  `CREATE INDEX "RecordingUploadSession_state_expiresAt_idx" ON "RecordingUploadSession"("state", "expiresAt")`,
  `CREATE INDEX "RecordingUploadSession_state_idx" ON "RecordingUploadSession"("state")`,
];

// The Prisma-generated statements, in the order Prisma emits them (identical to an offline
// `prisma migrate diff` from the previous schema to this one).
const GENERATED_SQL = [
  ...ENUM_SQL,
  createTableSql("RecordedLecture"),
  createTableSql("RecordingUploadSession"),
  createTableSql("RecordingUploadChunk"),
  REGULAR_INDEXES[0],
  REGULAR_INDEXES[1],
  REGULAR_INDEXES[2],
  `CREATE UNIQUE INDEX "RecordedLecture_id_teacherId_key" ON "RecordedLecture"("id", "teacherId")`,
  `CREATE UNIQUE INDEX "RecordingUploadSession_leaseToken_key" ON "RecordingUploadSession"("leaseToken")`,
  REGULAR_INDEXES[3],
  REGULAR_INDEXES[4],
  REGULAR_INDEXES[5],
  `CREATE UNIQUE INDEX "RecordingUploadSession_recordedLectureId_teacherId_key" ON "RecordingUploadSession"("recordedLectureId", "teacherId")`,
  `CREATE UNIQUE INDEX "RecordingUploadChunk_leaseToken_key" ON "RecordingUploadChunk"("leaseToken")`,
  `CREATE UNIQUE INDEX "RecordingUploadChunk_uploadSessionId_chunkIndex_key" ON "RecordingUploadChunk"("uploadSessionId", "chunkIndex")`,
  `CREATE UNIQUE INDEX "RecordingUploadChunk_uploadSessionId_startOffset_key" ON "RecordingUploadChunk"("uploadSessionId", "startOffset")`,
  `CREATE UNIQUE INDEX "Class_id_teacherId_key" ON "Class"("id", "teacherId")`,
  ...FOREIGN_KEYS,
].map(normalize);

// ---- Migration placement and shape ---------------------------------------------------------------

// Migrations approved to follow this one (each has its own guard test).
const LATER_MIGRATIONS = [
  "20261115120000_add_unified_file_storage_keys", // unified storage Stage 2: tests/storage-migration/migration-guard.test.cjs
  "20261116120000_add_teacher_storage_accounting", // storage accounting Stage 3.1: tests/storage-quota/migration-guard.test.cjs
  "20261117120000_add_profile_image_reservation_category", // profile photos: tests/storage-quota/profile-image-migration-guard.test.cjs
  "20261117120100_add_teacher_profile_image_storage", // profile photos: tests/storage-quota/profile-image-migration-guard.test.cjs
  "20261118120000_add_student_password_setup_pending", // student first login: tests/students/first-login-migration-guard.test.cjs
  "20261119120000_add_email_delivery_tracking", // student email outbox: tests/students/email-delivery-migration-guard.test.cjs
  "20261120120000_add_class_student_fee_free_card", // Free Cards: tests/fee-waiver/free-card-migration-guard.test.cjs
  "20261121120000_add_class_payment_access_control", // payment access control (tests/class-access/class-access-migration-guard.test.cjs)
  "20261122120000_add_class_payment_source_and_reversal", // partial payments Stage 1 (tests/fee-waiver/partial-payment-migration-guard.test.cjs)
  "20261123120000_add_class_student_free_card_eligible", // Free Card eligibility Stage 1 (tests/fee-waiver/free-card-eligibility-migration-guard.test.cjs)
  "20261124120000_add_recorded_lecture_publication", // Recorded lecture public profile (tests/recorded-lectures/publication-migration-guard.test.cjs)
];

test("the migration exists, and only approved migrations follow it", () => {
  assert.ok(fs.existsSync(migrationPath(MIGRATION)));
  const all = [...otherMigrations(), MIGRATION].sort();
  assert.deepEqual(all.slice(all.indexOf(MIGRATION) + 1), LATER_MIGRATIONS);
});

test("lock_timeout is set first and reset last", () => {
  assert.equal(statements[0], "SET lock_timeout = '5s'");
  assert.equal(statements[statements.length - 1], "RESET lock_timeout");
});

const checkSql = (name) => {
  const definition = CHECKS[name];
  const split = definition.indexOf(" ");
  return normalize(`ALTER TABLE ${definition.slice(0, split)} ADD CONSTRAINT "${name}" ${definition.slice(split + 1)}`);
};

test("every column of the three tables: exact name, SQL type, NULL / NOT NULL and default; nothing added or removed", () => {
  for (const table of NEW_TABLES) {
    const statement = statements.find((s) => s.startsWith(`CREATE TABLE "${table}" (`));
    assert.ok(statement, `CREATE TABLE ${table}`);
    const body = statement.slice(statement.indexOf("(") + 1, -1);
    const parts = body.split(/, (?=")|, (?=CONSTRAINT )/);
    const pk = parts.pop();
    assert.equal(pk, `CONSTRAINT "${table}_pkey" PRIMARY KEY ("id")`, `${table} primary key`);
    const actual = parts.map((part) => {
      const match = part.match(/^"([^"]+)" (.+)$/);
      assert.ok(match, `${table}: unexpected definition ${part}`);
      return [match[1], match[2]];
    });
    const names = (list) => list.map(([name]) => name);
    assert.deepEqual(names(actual), names(COLUMNS[table]), `${table}: columns added, removed or reordered`);
    for (const [name, type] of COLUMNS[table]) {
      assert.equal(actual.find(([n]) => n === name)[1], type, `${table}.${name}`);
    }
  }
});

test("the three CREATE TABLE statements are exact (columns, types, nullability, defaults, primary keys)", () => {
  for (const table of NEW_TABLES) assert.ok(statements.includes(createTableSql(table)), table);
});

test("every regular index is exact, and there are no others", () => {
  for (const index of REGULAR_INDEXES) assert.ok(statements.includes(normalize(index)), index);
  assert.equal(statements.filter((s) => /^CREATE INDEX/.test(s)).length, REGULAR_INDEXES.length);
});

test("the whole migration is exactly: lock timeout, the Prisma-generated statements, the partial index, the 41 CHECKs, reset", () => {
  const expected = [
    "SET lock_timeout = '5s'",
    ...GENERATED_SQL,
    normalize(PARTIAL_INDEX_SQL),
    ...Object.keys(CHECKS).map(checkSql),
    "RESET lock_timeout",
  ];
  assert.equal(Object.keys(CHECKS).length, 41);
  assert.deepEqual(statements, expected);
});

test("additive only: no data change, no drop, no change to an existing column", () => {
  const withoutRules = sql.replace(/ON (DELETE|UPDATE) (CASCADE|RESTRICT|SET NULL|NO ACTION)/g, " ");
  for (const word of [/\bDROP\b/i, /\bDELETE\b/i, /\bUPDATE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i, /ALTER COLUMN/i, /RENAME/i, /ADD COLUMN/i, /\bTRIGGER\b/i, /\bFUNCTION\b/i]) {
    assert.doesNotMatch(withoutRules, word);
  }
});

test("existing tables: only the additive Class (id, teacherId) unique index; everything else targets the new tables", () => {
  for (const statement of statements) {
    const alter = statement.match(/^ALTER TABLE "([^"]+)"/);
    if (alter) assert.ok(NEW_TABLES.includes(alter[1]), `ALTER TABLE on ${alter[1]}`);
    const create = statement.match(/^CREATE TABLE "([^"]+)"/);
    if (create) assert.ok(NEW_TABLES.includes(create[1]), `CREATE TABLE ${create[1]}`);
    const index = statement.match(/^CREATE (?:UNIQUE )?INDEX "([^"]+)" ON "([^"]+)"/);
    if (index && !NEW_TABLES.includes(index[2])) {
      assert.equal(index[1], "Class_id_teacherId_key", `index on existing table ${index[2]}`);
    }
  }
  assert.equal(statements.filter((s) => /^CREATE TABLE/.test(s)).length, 3);
});

test("the two enums have exactly the approved values", () => {
  assert.ok(sql.includes(`CREATE TYPE "RecordedLectureState" AS ENUM ('UPLOADING', 'VERIFYING', 'READY', 'FAILED')`));
  assert.ok(sql.includes(`CREATE TYPE "RecordingUploadState" AS ENUM ('ACTIVE', 'COMPLETING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED')`));
  assert.equal(statements.filter((s) => /^CREATE TYPE/.test(s)).length, 2);
});

test("sizes, offsets and counters that may exceed 32 bits are BIGINT", () => {
  for (const column of ["sizeBytes", "expectedBytes", "receivedBytes", "leaseOffset", "startOffset"]) {
    assert.match(sql, new RegExp(`"${column}" BIGINT`), column);
  }
  // Values bounded well below 2^31 stay INTEGER.
  for (const column of ["leaseBytes", "byteLength", "chunkIndex", "chunkCount", "durationSeconds", "partNumber"]) {
    assert.match(sql, new RegExp(`"${column}" INTEGER`), column);
  }
});

test("timestamps have no database default (the application writes UTC instants)", () => {
  assert.doesNotMatch(sql, /CURRENT_TIMESTAMP/i);
  assert.doesNotMatch(sql, /now\(\)/i);
  assert.doesNotMatch(sql, /TIMESTAMP\(3\)( NOT NULL)? DEFAULT/i);
});

test("every identifier fits PostgreSQL's 63-byte limit", () => {
  for (const [, name] of sql.matchAll(/"([^"]+)"/g)) assert.ok(Buffer.byteLength(name) <= 63, name);
});

// ---- Ownership integrity -------------------------------------------------------------------------

test("foreign keys: composite ownership keys with the approved delete / update rules", () => {
  for (const fk of FOREIGN_KEYS) assert.ok(sql.includes(fk), fk);
  assert.equal(statements.filter((s) => /FOREIGN KEY/.test(s)).length, FOREIGN_KEYS.length);
});

test("unique indexes: ownership targets and duplicate-chunk prevention", () => {
  for (const index of UNIQUE_INDEXES) assert.ok(sql.includes(index), index);
  assert.equal(statements.filter((s) => /^CREATE UNIQUE INDEX/.test(s)).length, UNIQUE_INDEXES.length + 1, "plus the partial index only");
});

test("one session per recording comes from the composite unique alone (no redundant single-column unique)", () => {
  assert.ok(!sql.includes(`"RecordingUploadSession_recordedLectureId_key"`));
  const session = block("model", "RecordingUploadSession");
  assert.match(session, /^\s*recordedLectureId\s+String\s*$/m);
  assert.match(session, /@@unique\(\[recordedLectureId, teacherId\]\)/);
});

// ---- Manual parts ---------------------------------------------------------------------------------

test("every CHECK constraint is created exactly once, with the exact definition", () => {
  for (const [name, definition] of Object.entries(CHECKS)) {
    const [table, check] = [definition.slice(0, definition.indexOf(" ")), definition.slice(definition.indexOf(" ") + 1)];
    const statement = normalize(`ALTER TABLE ${table} ADD CONSTRAINT "${name}" ${check}`);
    assert.ok(statements.includes(statement), `missing or altered: ${name}`);
    assert.equal(sql.split(`"${name}"`).length - 1, 1, `${name} mentioned once`);
  }
  assert.equal((sql.match(/\bCHECK \(/g) ?? []).length, Object.keys(CHECKS).length, "no unlisted CHECK");
});

test("purgedAt: nullable column, set exactly for status 1; purgeRequestedAt stays set exactly for status 2", () => {
  assert.ok(sql.includes(`"purgeRequestedAt" TIMESTAMP(3), "purgedAt" TIMESTAMP(3),`), "nullable TIMESTAMP(3) column");
  assert.doesNotMatch(sql, /"purgedAt" TIMESTAMP\(3\) (NOT NULL|DEFAULT)/);

  const purged = normalize(`ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_purgedAt_check" CHECK (("status" = 1) = ("purgedAt" IS NOT NULL))`);
  const requested = normalize(`ALTER TABLE "RecordedLecture" ADD CONSTRAINT "RecordedLecture_purgeRequestedAt_check" CHECK (("status" = 2) = ("purgeRequestedAt" IS NOT NULL))`);
  assert.ok(statements.includes(purged));
  assert.ok(statements.includes(requested));

  // What the two equivalences allow, status by status (status is CHECKed to 0, 1 or 2):
  // the expressions as JavaScript, evaluated for every combination.
  const allowed = (status, purgeRequestedAt, purgedAt) =>
    (status === 2) === (purgeRequestedAt !== null) && (status === 1) === (purgedAt !== null);
  const T = "2026-11-14T00:00:00.000Z";
  assert.deepEqual(
    [0, 1, 2].map((s) => [null, T].flatMap((r) => [null, T].filter((p) => allowed(s, r, p)).map((p) => [s, r, p]))),
    [[[0, null, null]], [[1, null, T]], [[2, T, null]]],
    "active: both NULL; removed: purgedAt only; purge pending: purgeRequestedAt only"
  );

  const field = block("model", "RecordedLecture").match(/^\s*purgedAt\s+(\S+)\s+(.*)$/m);
  assert.ok(field, "schema field");
  assert.equal(field[1], "DateTime?", "nullable");
  assert.equal(field[2].trim(), "@db.Timestamp(3)");
});

test("the partial unique index for active part numbers is created exactly once, with the exact definition", () => {
  assert.ok(statements.includes(normalize(PARTIAL_INDEX_SQL)));
  assert.equal(sql.split(PARTIAL_INDEX).length - 1, 1);
});

test("no other migration drops, alters or recreates a manual constraint or index", () => {
  const names = [...Object.keys(CHECKS), PARTIAL_INDEX];
  for (const other of otherMigrations()) {
    const text = read(other);
    for (const name of names) assert.ok(!text.includes(name), `${other} mentions ${name}`);
  }
});

// ---- The limits match the RL-1 code ------------------------------------------------------------

const { RECORDED_LECTURE_SETTINGS, RECORDED_LECTURE_DEFAULTS } = require(path.join(root, "lib", "recorded-lectures", "config.ts"));
const keys = require(path.join(root, "lib", "recorded-lectures", "keys.ts"));
const { inspectMp4, bytesByteSource } = require(path.join(root, "lib", "recorded-lectures", "mp4-inspect.ts"));
const F = require("./helpers/mp4-fixtures.cjs");

const setting = (key) => RECORDED_LECTURE_SETTINGS.find((s) => s.key === key);
const sqlRegex = (name, column) => {
  const match = CHECKS[name].match(new RegExp(`"${column}" ~ '([^']+)'`));
  assert.ok(match, `${name} has a pattern for ${column}`);
  return new RegExp(match[1]);
};

test("byte limits are the highest values the configuration allows (not the defaults)", () => {
  assert.equal(setting("maxPartBytes").max, 64_000_000_000);
  assert.equal(setting("chunkBytes").max, 67_108_864);
  assert.equal(RECORDED_LECTURE_DEFAULTS.maxPartBytes, 4_000_000_000);
  assert.equal(RECORDED_LECTURE_DEFAULTS.chunkBytes, 8_388_608);
  assert.ok(Number.isSafeInteger(64_000_000_000));
  assert.ok(64_000_000_000 > 2_147_483_647, "hence BIGINT");
});

test("the id, lease token and stored file name patterns accept exactly what the RL-1 key code accepts", () => {
  const uuid = sqlRegex("RecordingUploadSession_id_format_check", "id");
  const lease = sqlRegex("RecordingUploadSession_leaseToken_check", "leaseToken");
  const stored = sqlRegex("RecordedLecture_storedFileName_check", "storedFileName");

  const id = "0f8b4c2e-1d3a-4b5c-8d9e-0a1b2c3d4e5f";
  for (const value of [id, id.toUpperCase(), `${id}x`, id.slice(1), "not-a-uuid", ""]) {
    assert.equal(uuid.test(value), keys.isRecordedLectureId(value), value);
  }
  for (let i = 0; i < 20; i++) {
    const token = keys.generateLeaseToken();
    assert.ok(lease.test(token) && keys.isLeaseToken(token));
    assert.ok(stored.test(keys.generateRecordingFileName()));
  }
  for (const value of ["a".repeat(63), "A".repeat(64), "g".repeat(64), "a".repeat(65)]) {
    assert.equal(lease.test(value), keys.isLeaseToken(value), value);
  }
  assert.ok(!stored.test("0123456789abcdef0123456789ABCDEF.mp4"));
  assert.ok(!stored.test("0123456789abcdef0123456789abcdef.MP4"));
});

test("the codec patterns accept every codec string the MP4 inspector can return", async () => {
  const video = sqlRegex("RecordedLecture_videoCodec_check", "videoCodec");
  const audioAllowed = CHECKS.RecordedLecture_audioCodec_check.match(/IN \(([^)]*)\)/)[1].split(", ").map((s) => s.slice(1, -1));
  const seen = [];
  for (const type of ["avc1", "avc3"]) {
    for (const profile of [66, 77, 100]) {
      for (const audioObjectType of [2, 5, 29]) {
        const vide = F.track("vide", [F.videoEntry({ type, children: [F.avcC({ profile, level: 42, spsNal: F.sps({ profile, level: 42 }) })] })]);
        const soun = F.track("soun", [F.audioEntry({ children: [F.esds({ audioObjectType })] })]);
        const bytes = F.mp4({ moovBox: F.moov({ tracks: [vide, soun] }) });
        const result = await inspectMp4(bytesByteSource(new Uint8Array(bytes)), { maxMoovBytes: 64 * 1024 * 1024 });
        assert.ok(result.ok, JSON.stringify(result));
        assert.match(result.info.videoCodec, video);
        assert.ok(audioAllowed.includes(result.info.audioCodec), result.info.audioCodec);
        seen.push(result.info.videoCodec);
      }
    }
  }
  assert.ok(seen.includes("avc1.42002A") && seen.includes("avc3.64002A"), seen.join(","));
  assert.deepEqual(audioAllowed, ["mp4a.40.2", "mp4a.40.5", "mp4a.40.29"]);
});

// ---- schema.prisma ---------------------------------------------------------------------------------

test("schema.prisma: enums with exactly the approved values", () => {
  const values = (name) => block("enum", name).split("\n").slice(1, -1).map((l) => l.trim()).filter((l) => l && !l.startsWith("//") && !l.endsWith("{"));
  assert.deepEqual(values("RecordedLectureState"), ["UPLOADING", "VERIFYING", "READY", "FAILED"]);
  assert.deepEqual(values("RecordingUploadState"), ["ACTIVE", "COMPLETING", "COMPLETED", "FAILED", "EXPIRED", "CANCELLED"]);
});

test("schema.prisma: BigInt fields, no timestamp defaults, approved relations", () => {
  const recording = block("model", "RecordedLecture");
  const session = block("model", "RecordingUploadSession");
  const chunk = block("model", "RecordingUploadChunk");
  assert.ok(recording && session && chunk);

  assert.match(recording, /^\s*sizeBytes\s+BigInt\s*$/m);
  assert.match(session, /^\s*expectedBytes\s+BigInt\s*$/m);
  assert.match(session, /^\s*receivedBytes\s+BigInt\s+@default\(0\)\s*$/m);
  assert.match(session, /^\s*leaseOffset\s+BigInt\?\s*$/m);
  assert.match(chunk, /^\s*startOffset\s+BigInt\s*$/m);

  for (const model of [recording, session, chunk]) {
    assert.doesNotMatch(model, /@default\(now\(\)\)/);
    assert.doesNotMatch(model, /@updatedAt/);
  }

  assert.match(recording, /@relation\(fields: \[lectureId, classId\], references: \[id, classId\], onDelete: Cascade, onUpdate: Restrict\)/);
  assert.match(recording, /@relation\(fields: \[classId, teacherId\], references: \[id, teacherId\], onDelete: Restrict, onUpdate: Restrict\)/);
  assert.match(recording, /@relation\("RecordedLectureTeacher", fields: \[teacherId\], references: \[id\], onDelete: Restrict, onUpdate: Restrict\)/);
  assert.match(recording, /@relation\("RecordedLectureDeletedBy", fields: \[deletedByTeacherId\], references: \[id\], onDelete: Restrict, onUpdate: Restrict\)/);
  assert.match(session, /@relation\(fields: \[recordedLectureId, teacherId\], references: \[id, teacherId\], onDelete: Cascade, onUpdate: Restrict\)/);
  assert.match(chunk, /@relation\(fields: \[uploadSessionId\], references: \[id\], onDelete: Cascade, onUpdate: Restrict\)/);

  assert.match(chunk, /@@unique\(\[uploadSessionId, chunkIndex\]\)/);
  assert.match(chunk, /@@unique\(\[uploadSessionId, startOffset\]\)/);
  assert.match(chunk, /^\s*leaseToken\s+String\s+@unique @db\.Char\(64\)\s*$/m);
  assert.match(chunk, /^\s*sha256\s+String\?\s+@db\.Char\(64\)\s*$/m);
});

test("schema.prisma: existing models only gain back-relations and the Class (id, teacherId) unique", () => {
  assert.match(block("model", "Class"), /@@unique\(\[id, teacherId\]\)/);
  assert.match(block("model", "Class"), /^\s*recordedLectures RecordedLecture\[\]\s*$/m);
  const lecture = block("model", "Lecture");
  assert.match(lecture, /@@unique\(\[id, classId\]\)/, "the existing Lecture (id, classId) unique is preserved");
  assert.match(lecture, /^\s*recordedLectures RecordedLecture\[\]\s*$/m);
  const teacher = block("model", "Teacher");
  assert.match(teacher, /recordedLectures\s+RecordedLecture\[\] @relation\("RecordedLectureTeacher"\)/);
  assert.match(teacher, /deletedRecordedLectures RecordedLecture\[\] @relation\("RecordedLectureDeletedBy"\)/);
});
