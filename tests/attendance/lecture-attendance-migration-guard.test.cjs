/*
 * Static guard for the unified lecture attendance migration and schema
 * (no database needed).
 *
 *   npm run test:attendance-schema
 *
 * The migration holds hand-written CHECK constraints and triggers Prisma
 * cannot express (and ignores, so they are never reported as drift and
 * `prisma db push` would not create them). This test fails if they are lost or
 * altered, if the migration ever changes existing data or tables beyond the
 * two approved additions (Class.attendanceGraceMinutes and the Lecture
 * (id, classId) unique index), if a timestamp default sneaks in, or if
 * schema.prisma drifts from the migration.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "prisma", "migrations");
const MIGRATION = "20261110140000_add_lecture_attendance";

const normalize = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();

const read = (name) => normalize(fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8"));
const sql = read(MIGRATION);
/** The SQL without plpgsql function bodies (their RAISE text is not DDL). */
const ddl = sql.replace(/\$\$[\s\S]*?\$\$/g, "$$ $$");
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");

const NEW_TABLES = [
  "LectureAttendanceRegister",
  "LectureAttendance",
  "AttendanceScanEvent",
  "AttendanceAuditLog",
  "LectureAttendanceRegisterAuditLog",
];

const ENUMS = {
  LectureAttendanceStatus: ["PRESENT", "LATE", "ABSENT", "EXCUSED"],
  AttendanceStatusSource: ["AUTO", "TEACHER", "FINALIZATION", "BACKFILL"],
  AttendanceScanResult: ["VALID", "INVALID_QR", "QR_UNVERIFIABLE", "WRONG_TEACHER", "NOT_ELIGIBLE", "ELIGIBILITY_UNKNOWN", "LECTURE_UNAVAILABLE"],
  AttendanceScanEffect: ["STATUS_UPDATED", "EVIDENCE_ONLY", "REVIEW_REQUIRED", "DUPLICATE", "RECORDED_ONLY", "NONE"],
  AttendanceAuditAction: [
    "CREATED_AUTO",
    "AUTO_UPDATED",
    "AUTO_RECALCULATED",
    "EVIDENCE_RECORDED",
    "TEACHER_SET",
    "EVIDENCE_ACCEPTED",
    "EVIDENCE_DISMISSED",
    "FINALIZE_ABSENT",
    "BACKFILL",
  ],
  RegisterAuditAction: ["CREATED", "GRACE_CHANGED", "SCHEDULE_SYNCED", "FINALIZED"],
};

const ELIGIBILITY_REASONS = [
  "KNOWN_APPROVED",
  "APPROVED_AT_EVIDENCE",
  "KNOWN_NOT_APPROVED",
  "BEFORE_APPROVAL_FEATURE",
  "BEFORE_RECORDED_DECISIONS",
  "APPROVED_AT_CONFLICT",
  "BROKEN_HISTORY",
];

const CHECKS = {
  Class: {
    Class_attendanceGraceMinutes_check: `CHECK ("attendanceGraceMinutes" BETWEEN 0 AND 240)`,
  },
  LectureAttendanceRegister: {
    LectureAttendanceRegister_graceMinutes_check: `CHECK ("graceMinutes" BETWEEN 0 AND 240)`,
    LectureAttendanceRegister_schedule_check: `CHECK ("scheduledEndAt" IS NULL OR "scheduledEndAt" > "scheduledStartAt")`,
    LectureAttendanceRegister_finalized_check: `CHECK (("finalizedAt" IS NULL) = ("finalizedByTeacherId" IS NULL))`,
    LectureAttendanceRegister_version_check: `CHECK ("version" >= 1)`,
  },
  LectureAttendance: {
    LectureAttendance_teacher_status_check: `CHECK ("teacherStatus" IS NULL OR "status" = "teacherStatus")`,
    LectureAttendance_auto_status_check: `CHECK ("autoStatus" IS NULL OR "autoStatus" IN ('PRESENT', 'LATE'))`,
    LectureAttendance_evidence_check: `CHECK (("autoStatus" IS NULL) = ("firstOnlineAt" IS NULL AND "firstQrAt" IS NULL))`,
    LectureAttendance_teacher_decision_check: `CHECK ( ("teacherStatus" IS NULL) = ("teacherDecidedAt" IS NULL) AND ("teacherStatus" IS NULL) = ("teacherDecidedById" IS NULL) )`,
    LectureAttendance_source_teacher_check: `CHECK (("statusSource" = 'TEACHER') = ("teacherStatus" IS NOT NULL))`,
    LectureAttendance_source_finalization_check: `CHECK ("statusSource" <> 'FINALIZATION' OR "status" = 'ABSENT')`,
    LectureAttendance_source_auto_check: `CHECK ("statusSource" <> 'AUTO' OR ("autoStatus" IS NOT NULL AND "status" IN ('PRESENT', 'LATE')))`,
    LectureAttendance_source_backfill_check: `CHECK ("statusSource" <> 'BACKFILL' OR "status" = 'PRESENT')`,
    LectureAttendance_version_check: `CHECK ("version" >= 1)`,
  },
  AttendanceScanEvent: {
    AttendanceScanEvent_record_link_check: `CHECK (("effect" IN ('STATUS_UPDATED', 'EVIDENCE_ONLY', 'REVIEW_REQUIRED', 'DUPLICATE')) = ("lectureAttendanceId" IS NOT NULL))`,
    AttendanceScanEvent_effect_check: `CHECK (("result" = 'VALID') = ("effect" <> 'NONE'))`,
    AttendanceScanEvent_identity_check: `CHECK ( "result" NOT IN ('VALID', 'NOT_ELIGIBLE', 'ELIGIBILITY_UNKNOWN') OR ("studentId" IS NOT NULL AND "qrTokenId" IS NOT NULL AND "scannedTokenHash" IS NOT NULL) )`,
    AttendanceScanEvent_wrong_teacher_check: `CHECK ("result" <> 'WRONG_TEACHER' OR ("studentId" IS NULL AND "qrTokenId" IS NULL AND "scannedTokenHash" IS NULL))`,
    AttendanceScanEvent_token_hash_check: `CHECK ("scannedTokenHash" IS NULL OR "scannedTokenHash" ~ '^[0-9a-f]{64}$')`,
    AttendanceScanEvent_valid_reason_check: `CHECK ( "result" <> 'VALID' OR ("eligibilityReason" IS NOT NULL AND "eligibilityReason" IN ('KNOWN_APPROVED', 'APPROVED_AT_EVIDENCE')) )`,
    AttendanceScanEvent_unknown_reason_check: `CHECK ( "result" <> 'ELIGIBILITY_UNKNOWN' OR ( "eligibilityReason" IS NOT NULL AND "eligibilityReason" IN ('BEFORE_APPROVAL_FEATURE', 'BEFORE_RECORDED_DECISIONS', 'APPROVED_AT_CONFLICT', 'BROKEN_HISTORY') ) )`,
    AttendanceScanEvent_reason_identity_check: `CHECK ("studentId" IS NOT NULL OR "eligibilityReason" IS NULL)`,
    AttendanceScanEvent_eligibility_reason_check: `CHECK ( "eligibilityReason" IS NULL OR "eligibilityReason" IN ( ${ELIGIBILITY_REASONS.map((r) => `'${r}'`).join(", ")} ) )`,
  },
  AttendanceAuditLog: {
    AttendanceAuditLog_actor_role_check: `CHECK ("actorRole" IN ('TEACHER', 'SYSTEM'))`,
    AttendanceAuditLog_teacher_action_check: `CHECK (("actorRole" = 'TEACHER') = ("action" IN ('TEACHER_SET', 'EVIDENCE_ACCEPTED', 'EVIDENCE_DISMISSED')))`,
    AttendanceAuditLog_actor_id_check: `CHECK (("actorRole" = 'TEACHER') = ("actorId" IS NOT NULL))`,
    AttendanceAuditLog_version_check: `CHECK ("version" >= 1)`,
    AttendanceAuditLog_creation_check: `CHECK ( ("version" = 1) = ("fromStatus" IS NULL) AND ("version" <> 1 OR ("fromTeacherStatus" IS NULL AND "fromAutoStatus" IS NULL)) )`,
    AttendanceAuditLog_creation_action_check: `CHECK ( ("action" NOT IN ('CREATED_AUTO', 'BACKFILL', 'FINALIZE_ABSENT') OR "version" = 1) AND ("version" <> 1 OR "action" IN ('CREATED_AUTO', 'BACKFILL', 'FINALIZE_ABSENT', 'TEACHER_SET')) )`,
    AttendanceAuditLog_finalize_absent_check: `CHECK ("action" <> 'FINALIZE_ABSENT' OR "toStatus" = 'ABSENT')`,
    AttendanceAuditLog_backfill_check: `CHECK ("action" <> 'BACKFILL' OR "toStatus" = 'PRESENT')`,
    AttendanceAuditLog_reason_check: `CHECK ( NOT ("action" IN ('TEACHER_SET', 'EVIDENCE_ACCEPTED') AND ("fromStatus" IS NOT NULL OR "afterFinalization")) OR "reason" IS NOT NULL )`,
  },
  LectureAttendanceRegisterAuditLog: {
    LectureAttendanceRegisterAuditLog_version_check: `CHECK ("version" >= 1)`,
    LectureAttendanceRegisterAuditLog_actor_role_check: `CHECK ("actorRole" IN ('TEACHER', 'SYSTEM'))`,
    LectureAttendanceRegisterAuditLog_actor_id_check: `CHECK (("actorRole" = 'TEACHER') = ("actorId" IS NOT NULL))`,
    LectureAttendanceRegisterAuditLog_created_check: `CHECK ( "action" <> 'CREATED' OR ("version" = 1 AND "fromGraceMinutes" IS NULL AND "fromScheduledStartAt" IS NULL AND "fromScheduledEndAt" IS NULL) )`,
    LectureAttendanceRegisterAuditLog_grace_changed_check: `CHECK ( "action" <> 'GRACE_CHANGED' OR ("fromGraceMinutes" IS NOT NULL AND "toGraceMinutes" IS NOT NULL AND "fromGraceMinutes" <> "toGraceMinutes") )`,
    LectureAttendanceRegisterAuditLog_schedule_synced_check: `CHECK ( "action" <> 'SCHEDULE_SYNCED' OR "fromScheduledStartAt" IS DISTINCT FROM "toScheduledStartAt" OR "fromScheduledEndAt" IS DISTINCT FROM "toScheduledEndAt" )`,
    LectureAttendanceRegisterAuditLog_finalized_check: `CHECK ( "action" <> 'FINALIZED' OR ( "finalizedAt" IS NOT NULL AND "eligibleCount" IS NOT NULL AND "unknownEligibilityCount" IS NOT NULL AND "absentCreatedCount" IS NOT NULL AND "actorId" IS NOT NULL ) )`,
  },
};

const FOREIGN_KEYS = [
  ["LectureAttendanceRegister", "LectureAttendanceRegister_lectureId_classId_fkey", `("lectureId", "classId") REFERENCES "Lecture"("id", "classId")`],
  ["LectureAttendanceRegister", "LectureAttendanceRegister_classId_fkey", `("classId") REFERENCES "Class"("id")`],
  ["LectureAttendanceRegister", "LectureAttendanceRegister_finalizedByTeacherId_fkey", `("finalizedByTeacherId") REFERENCES "Teacher"("id")`],
  ["LectureAttendance", "LectureAttendance_lectureId_classId_fkey", `("lectureId", "classId") REFERENCES "LectureAttendanceRegister"("lectureId", "classId")`],
  ["LectureAttendance", "LectureAttendance_classId_fkey", `("classId") REFERENCES "Class"("id")`],
  ["LectureAttendance", "LectureAttendance_studentId_fkey", `("studentId") REFERENCES "Student"("id")`],
  ["LectureAttendance", "LectureAttendance_teacherDecidedById_fkey", `("teacherDecidedById") REFERENCES "Teacher"("id")`],
  ["AttendanceScanEvent", "AttendanceScanEvent_lectureId_classId_fkey", `("lectureId", "classId") REFERENCES "Lecture"("id", "classId")`],
  ["AttendanceScanEvent", "AttendanceScanEvent_classSessionId_fkey", `("classSessionId") REFERENCES "ClassSession"("id")`],
  ["AttendanceScanEvent", "AttendanceScanEvent_scannedByTeacherId_fkey", `("scannedByTeacherId") REFERENCES "Teacher"("id")`],
  ["AttendanceScanEvent", "AttendanceScanEvent_qrTokenId_fkey", `("qrTokenId") REFERENCES "StudentQrToken"("id")`],
  ["AttendanceScanEvent", "AttendanceScanEvent_studentId_fkey", `("studentId") REFERENCES "Student"("id")`],
  ["AttendanceScanEvent", "AttendanceScanEvent_lectureAttendanceId_fkey", `("lectureAttendanceId") REFERENCES "LectureAttendance"("id")`],
  ["AttendanceAuditLog", "AttendanceAuditLog_lectureAttendanceId_fkey", `("lectureAttendanceId") REFERENCES "LectureAttendance"("id")`],
  ["AttendanceAuditLog", "AttendanceAuditLog_scanEventId_fkey", `("scanEventId") REFERENCES "AttendanceScanEvent"("id")`],
  ["AttendanceAuditLog", "AttendanceAuditLog_attendanceVisitId_fkey", `("attendanceVisitId") REFERENCES "Attendance"("id")`],
  ["AttendanceAuditLog", "AttendanceAuditLog_registerAuditId_fkey", `("registerAuditId") REFERENCES "LectureAttendanceRegisterAuditLog"("id")`],
  ["LectureAttendanceRegisterAuditLog", "LectureAttendanceRegisterAuditLog_lectureId_fkey", `("lectureId") REFERENCES "LectureAttendanceRegister"("lectureId")`],
];

const UNIQUE_INDEXES = [
  `CREATE UNIQUE INDEX "LectureAttendanceRegister_lectureId_classId_key" ON "LectureAttendanceRegister"("lectureId", "classId");`,
  `CREATE UNIQUE INDEX "LectureAttendance_lectureId_studentId_key" ON "LectureAttendance"("lectureId", "studentId");`,
  `CREATE UNIQUE INDEX "AttendanceScanEvent_scannedByTeacherId_clientScanId_key" ON "AttendanceScanEvent"("scannedByTeacherId", "clientScanId");`,
  `CREATE UNIQUE INDEX "AttendanceAuditLog_lectureAttendanceId_version_key" ON "AttendanceAuditLog"("lectureAttendanceId", "version");`,
  `CREATE UNIQUE INDEX "LectureAttendanceRegisterAuditLog_lectureId_version_key" ON "LectureAttendanceRegisterAuditLog"("lectureId", "version");`,
  `CREATE UNIQUE INDEX "Lecture_id_classId_key" ON "Lecture"("id", "classId");`,
];

const INDEXES = [
  `CREATE INDEX "LectureAttendanceRegister_classId_finalizedAt_idx" ON "LectureAttendanceRegister"("classId", "finalizedAt");`,
  `CREATE INDEX "LectureAttendance_classId_studentId_idx" ON "LectureAttendance"("classId", "studentId");`,
  `CREATE INDEX "LectureAttendance_studentId_lectureId_idx" ON "LectureAttendance"("studentId", "lectureId");`,
  `CREATE INDEX "LectureAttendance_lectureId_status_idx" ON "LectureAttendance"("lectureId", "status");`,
  `CREATE INDEX "LectureAttendance_lectureId_pendingReviewSince_idx" ON "LectureAttendance"("lectureId", "pendingReviewSince");`,
  `CREATE INDEX "AttendanceScanEvent_lectureId_receivedAt_idx" ON "AttendanceScanEvent"("lectureId", "receivedAt");`,
  `CREATE INDEX "AttendanceScanEvent_studentId_lectureId_receivedAt_idx" ON "AttendanceScanEvent"("studentId", "lectureId", "receivedAt");`,
  `CREATE INDEX "AttendanceAuditLog_lectureId_createdAt_idx" ON "AttendanceAuditLog"("lectureId", "createdAt");`,
  `CREATE INDEX "AttendanceAuditLog_studentId_createdAt_idx" ON "AttendanceAuditLog"("studentId", "createdAt");`,
  `CREATE INDEX "LectureAttendanceRegisterAuditLog_lectureId_createdAt_idx" ON "LectureAttendanceRegisterAuditLog"("lectureId", "createdAt");`,
];

const TRIGGERS = [
  `CREATE TRIGGER "LectureAttendanceRegister_freeze" BEFORE UPDATE OR DELETE ON "LectureAttendanceRegister" FOR EACH ROW EXECUTE FUNCTION "LectureAttendanceRegister_freeze"();`,
  `CREATE TRIGGER "LectureAttendanceRegister_no_truncate" BEFORE TRUNCATE ON "LectureAttendanceRegister" FOR EACH STATEMENT EXECUTE FUNCTION "LectureAttendanceRegister_freeze"();`,
  ...["AttendanceScanEvent", "AttendanceAuditLog", "LectureAttendanceRegisterAuditLog"].flatMap((t) => [
    `CREATE TRIGGER "${t}_no_update_delete" BEFORE UPDATE OR DELETE ON "${t}" FOR EACH ROW EXECUTE FUNCTION "AttendanceAppendOnly_guard"();`,
    `CREATE TRIGGER "${t}_no_truncate" BEFORE TRUNCATE ON "${t}" FOR EACH STATEMENT EXECUTE FUNCTION "AttendanceAppendOnly_guard"();`,
  ]),
];

const modelBlock = (kind, name) => {
  const start = schema.indexOf(`${kind} ${name} {`);
  assert.notEqual(start, -1, `${kind} ${name} exists in schema.prisma`);
  return schema.slice(start, schema.indexOf("\n}", start) + 2);
};
const fieldLines = (block) =>
  block
    .split("\n")
    .slice(1, -1)
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line && !line.startsWith("@@"));

// ---- Placement ---------------------------------------------------------------------

// Approved later migrations that build on this one (each has its own guard).
const QR_CLOSURE_MIGRATION = "20261110150000_add_lecture_qr_attendance_closure";
// Student Profile SP-5.2 (additive Student column; guarded by tests/students/session-version-migration-guard.test.cjs).
const STUDENT_SESSION_VERSION_MIGRATION = "20261112120000_add_student_session_version";
// Recorded Lectures RL-2 (additive new tables + a Class (id, teacherId) unique; guarded by
// tests/recorded-lectures/recorded-lectures-migration-guard.test.cjs).
const RECORDED_LECTURES_MIGRATION = "20261114120000_add_recorded_lectures";
// Unified storage Stage 2 (additive nullable Note / AssignmentSubmission columns; guarded by
// tests/storage-migration/migration-guard.test.cjs).
const UNIFIED_STORAGE_MIGRATION = "20261115120000_add_unified_file_storage_keys";
// Teacher storage accounting Stage 3.1 (additive new tables; guarded by
// tests/storage-quota/migration-guard.test.cjs).
const STORAGE_ACCOUNTING_MIGRATION = "20261116120000_add_teacher_storage_accounting";
// Teacher profile photos on unified storage (additive enum value, nullable TeacherProfile columns;
// guarded by tests/storage-quota/profile-image-migration-guard.test.cjs).
const PROFILE_IMAGE_MIGRATIONS = ["20261117120000_add_profile_image_reservation_category", "20261117120100_add_teacher_profile_image_storage"];
// Simplified student registration: one additive Student column (tests/students/first-login-migration-guard.test.cjs).
const STUDENT_PASSWORD_SETUP_MIGRATION = "20261118120000_add_student_password_setup_pending";
// Student email delivery outbox: one additive table (tests/students/email-delivery-migration-guard.test.cjs).
const EMAIL_DELIVERY_MIGRATION = "20261119120000_add_email_delivery_tracking";
// Teacher-issued Free Cards: three additive ClassStudentFee columns (tests/fee-waiver/free-card-migration-guard.test.cjs).
const FREE_CARD_MIGRATION = "20261120120000_add_class_student_fee_free_card";
// Payment-due access control: two additive Class columns (tests/class-access/class-access-migration-guard.test.cjs).
const PAYMENT_ACCESS_MIGRATION = "20261121120000_add_class_payment_access_control";
// Partial payments Stage 1: additive ClassPayment columns + ClassPaymentReversal (tests/fee-waiver/partial-payment-migration-guard.test.cjs).
const PARTIAL_PAYMENT_MIGRATION = "20261122120000_add_class_payment_source_and_reversal";
// Free Card eligibility Stage 1: one additive ClassStudent column (tests/fee-waiver/free-card-eligibility-migration-guard.test.cjs).
const FREE_CARD_ELIGIBILITY_MIGRATION = "20261123120000_add_class_student_free_card_eligible";
// Recorded lecture public profile: two additive RecordedLecture columns (tests/recorded-lectures/publication-migration-guard.test.cjs).
const RECORDED_LECTURE_PUBLICATION_MIGRATION = "20261124120000_add_recorded_lecture_publication";
const TEACHER_PAYMENT_ACCOUNTS_MIGRATION = "20261125120000_add_teacher_payment_accounts";
const TEACHER_TITLE_ENG_MIGRATION = "20261126120000_add_teacher_title_eng";
const GRADE_ZERO_MIGRATION = "20261127120000_add_grade_zero";
// Monthly resource access (tests/class-access/resource-access-migration-guard.test.cjs).
const RESOURCE_ACCESS_MIGRATION = "20261128120000_add_resource_month_access";
// Default lecture (tests/lectures/default-lecture-migration-guard.test.cjs).
const DEFAULT_LECTURE_MIGRATION = "20261129120000_add_lecture_is_default";
// Quiz answer snapshots (tests/quizzes/quiz-answer-snapshots.test.cjs).
const QUIZ_ANSWER_SNAPSHOTS_MIGRATION = "20261130120000_add_quiz_answer_snapshots";

test("migration order: directly after the student confirmation history migration; only approved migrations follow", () => {
  const names = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const previous = names.indexOf("20261110130000_add_student_confirmation_history");
  assert.ok(previous >= 0);
  assert.equal(names[previous + 1], MIGRATION);
  assert.deepEqual(names.slice(names.indexOf(MIGRATION) + 1), [QR_CLOSURE_MIGRATION, STUDENT_SESSION_VERSION_MIGRATION, RECORDED_LECTURES_MIGRATION, UNIFIED_STORAGE_MIGRATION, STORAGE_ACCOUNTING_MIGRATION, ...PROFILE_IMAGE_MIGRATIONS, STUDENT_PASSWORD_SETUP_MIGRATION, EMAIL_DELIVERY_MIGRATION, FREE_CARD_MIGRATION, PAYMENT_ACCESS_MIGRATION, PARTIAL_PAYMENT_MIGRATION, FREE_CARD_ELIGIBILITY_MIGRATION, RECORDED_LECTURE_PUBLICATION_MIGRATION, TEACHER_PAYMENT_ACCOUNTS_MIGRATION, TEACHER_TITLE_ENG_MIGRATION, GRADE_ZERO_MIGRATION, RESOURCE_ACCESS_MIGRATION, DEFAULT_LECTURE_MIGRATION, QUIZ_ANSWER_SNAPSHOTS_MIGRATION]);
});

// ---- Prisma-generated part -----------------------------------------------------------

test("creates exactly the six enums, with their exact values", () => {
  for (const [name, values] of Object.entries(ENUMS)) {
    assert.ok(sql.includes(`CREATE TYPE "${name}" AS ENUM (${values.map((v) => `'${v}'`).join(", ")});`), name);
  }
  assert.equal((sql.match(/CREATE TYPE/g) || []).length, 6);
});

test("creates exactly the five tables, with no timestamp default and no default at all", () => {
  for (const table of NEW_TABLES) {
    assert.ok(sql.includes(`CREATE TABLE "${table}" (`), table);
  }
  assert.equal((sql.match(/CREATE TABLE/g) || []).length, 5);
  // The only DEFAULT in the whole migration is the grace column's constant 10.
  assert.deepEqual(ddl.match(/DEFAULT[^,;]*/g), ["DEFAULT 10"]);
  assert.doesNotMatch(ddl, /now\(\)|CURRENT_TIMESTAMP/i);
});

test("the two approved changes to existing tables, and nothing else", () => {
  assert.ok(sql.includes(`ALTER TABLE "Class" ADD COLUMN "attendanceGraceMinutes" INTEGER NOT NULL DEFAULT 10;`));
  assert.ok(sql.includes(`CREATE UNIQUE INDEX "Lecture_id_classId_key" ON "Lecture"("id", "classId");`));

  const altered = [...new Set([...ddl.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(altered, ["Class", ...NEW_TABLES].sort(), "only Class and the new tables are altered");
  const classAlters = ddl.match(/ALTER TABLE "Class" [^;]*;/g);
  assert.equal(classAlters.length, 2, "the grace column and its CHECK");

  for (const untouched of ["Attendance", "StudentConfirmationHistory", "Student", "Teacher", "ClassSession", "StudentQrToken", "Lecture"]) {
    assert.doesNotMatch(ddl, new RegExp(`ALTER TABLE "${untouched}"`), untouched);
  }
  const indexedTables = [...new Set([...ddl.matchAll(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([^"]+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(indexedTables, ["Lecture", ...NEW_TABLES].sort());
});

test("additive only: nothing dropped, renamed, rewritten, updated, deleted or backfilled", () => {
  assert.doesNotMatch(ddl, /\bDROP\b/i);
  assert.doesNotMatch(ddl, /\bRENAME\b/i);
  assert.doesNotMatch(ddl, /ALTER COLUMN/i);
  assert.doesNotMatch(ddl, /\bUPDATE\s+"/i);
  assert.doesNotMatch(ddl, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(ddl, /\bINSERT\b/i);
  assert.doesNotMatch(ddl, /\bTRUNCATE\s+"/i);
  assert.doesNotMatch(ddl, /CONCURRENTLY/i);
});

test("unique keys: one register per lecture, one record per student per lecture, scan idempotency, audit versions", () => {
  for (const statement of UNIQUE_INDEXES) assert.ok(sql.includes(statement), statement);
  for (const statement of INDEXES) assert.ok(sql.includes(statement), statement);
  assert.equal((sql.match(/CREATE UNIQUE INDEX/g) || []).length, UNIQUE_INDEXES.length);
  assert.equal((sql.match(/CREATE INDEX/g) || []).length, INDEXES.length);
  assert.ok(sql.includes(`CONSTRAINT "LectureAttendanceRegister_pkey" PRIMARY KEY ("lectureId")`), "lectureId is the register's primary key");
});

test("every foreign key exists, is ON DELETE RESTRICT, and there are no others", () => {
  for (const [table, name, body] of FOREIGN_KEYS) {
    assert.ok(
      sql.includes(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ${body} ON DELETE RESTRICT ON UPDATE CASCADE;`),
      name
    );
  }
  assert.equal((sql.match(/FOREIGN KEY/g) || []).length, FOREIGN_KEYS.length);
  assert.doesNotMatch(sql, /ON DELETE (CASCADE|SET NULL|NO ACTION|SET DEFAULT)/);
});

// ---- Hand-written part -----------------------------------------------------------------

test("every CHECK constraint exists exactly once with its exact definition", () => {
  let total = 0;
  for (const [table, checks] of Object.entries(CHECKS)) {
    for (const [name, definition] of Object.entries(checks)) {
      total += 1;
      assert.ok(sql.includes(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ${definition};`), `${name}:\n${definition}`);
      assert.equal(sql.split(`"${name}"`).length - 1, 1, `${name} once`);
    }
  }
  assert.equal(total, 39);
  assert.equal((ddl.match(/\bCHECK\b/g) || []).length, 39, "no other CHECK");
});

test("eligibilityReason values are exactly the approvalAt reasons of lib/student-confirmation-history.ts", () => {
  const lib = fs.readFileSync(path.join(root, "lib", "student-confirmation-history.ts"), "utf8");
  const union = (name) => {
    const match = lib.match(new RegExp(`export type ${name} =([\\s\\S]*?);`));
    assert.ok(match, name);
    return [...match[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  };
  const reasons = [...union("ApprovalDuringReason"), ...union("UnknownPeriodReason")];
  assert.deepEqual([...new Set(reasons)].sort(), [...ELIGIBILITY_REASONS].sort());
});

test("scan reason rules use exactly approvalAt's APPROVED and UNKNOWN reasons; NOT_ELIGIBLE stays unrestricted", () => {
  const lib = fs.readFileSync(path.join(root, "lib", "student-confirmation-history.ts"), "utf8");
  const reasonsFor = (result) =>
    [...lib.matchAll(new RegExp(`result: "${result}", reason: "([A-Z_]+)"`, "g"))].map((m) => m[1]);
  const unknownPeriods = [...lib.match(/export type UnknownPeriodReason =([\s\S]*?);/)[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);

  const approved = reasonsFor("APPROVED").sort();
  const unknown = [...new Set([...reasonsFor("UNKNOWN").filter((r) => r !== "unknownReason"), ...unknownPeriods])].sort();
  assert.deepEqual(approved, ["APPROVED_AT_EVIDENCE", "KNOWN_APPROVED"]);
  assert.deepEqual(unknown, ["APPROVED_AT_CONFLICT", "BEFORE_APPROVAL_FEATURE", "BEFORE_RECORDED_DECISIONS", "BROKEN_HISTORY"]);
  assert.deepEqual(reasonsFor("NOT_APPROVED"), ["KNOWN_NOT_APPROVED"]);

  const inList = (name) => {
    const definition = CHECKS.AttendanceScanEvent[name];
    return [...definition.slice(definition.indexOf("IN (")).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
  };
  assert.deepEqual(inList("AttendanceScanEvent_valid_reason_check"), approved);
  assert.deepEqual(inList("AttendanceScanEvent_unknown_reason_check"), unknown);
  // The three identified results keep the student, the token row and the
  // scanned token's hash; WRONG_TEACHER keeps none of them; the hash format
  // rule is unchanged.
  assert.match(
    CHECKS.AttendanceScanEvent.AttendanceScanEvent_identity_check,
    /"result" NOT IN \('VALID', 'NOT_ELIGIBLE', 'ELIGIBILITY_UNKNOWN'\) OR \("studentId" IS NOT NULL AND "qrTokenId" IS NOT NULL AND "scannedTokenHash" IS NOT NULL\)/
  );
  assert.match(CHECKS.AttendanceScanEvent.AttendanceScanEvent_wrong_teacher_check, /"scannedTokenHash" IS NULL\)\)$/);
  assert.match(CHECKS.AttendanceScanEvent.AttendanceScanEvent_token_hash_check, /\^\[0-9a-f\]\{64\}\$/);
  // Every reason-to-result rule names its result; NOT_ELIGIBLE has none (an
  // approved student who is not enrolled is NOT_ELIGIBLE with an approved reason).
  assert.doesNotMatch(ddl, /'NOT_ELIGIBLE' OR \("eligibilityReason"/);
  // Each rule spells out IS NOT NULL (a CHECK whose expression is NULL passes).
  for (const name of ["AttendanceScanEvent_valid_reason_check", "AttendanceScanEvent_unknown_reason_check"]) {
    assert.match(CHECKS.AttendanceScanEvent[name], /"eligibilityReason" IS NOT NULL AND "eligibilityReason" IN/);
  }
});

test("record status rules: TEACHER exactly with a teacher decision; AUTO rests on evidence; BACKFILL PRESENT; FINALIZATION ABSENT", () => {
  const la = CHECKS.LectureAttendance;
  assert.equal(la.LectureAttendance_source_teacher_check, `CHECK (("statusSource" = 'TEACHER') = ("teacherStatus" IS NOT NULL))`);
  assert.match(la.LectureAttendance_source_auto_check, /"autoStatus" IS NOT NULL AND "status" IN \('PRESENT', 'LATE'\)/);
  // Deliberately NOT status = autoStatus: after finalization, later evidence
  // updates autoStatus while the status is never changed automatically.
  assert.doesNotMatch(ddl, /"status" = "autoStatus"/);
  assert.match(la.LectureAttendance_source_backfill_check, /"status" = 'PRESENT'/);
  assert.match(la.LectureAttendance_source_finalization_check, /"status" = 'ABSENT'/);
});

test("audit consistency: versions, creation actions, FINALIZE_ABSENT / BACKFILL outcomes, register audit actors", () => {
  const audit = CHECKS.AttendanceAuditLog;
  assert.match(audit.AttendanceAuditLog_version_check, /"version" >= 1/);
  assert.match(audit.AttendanceAuditLog_creation_check, /\("version" = 1\) = \("fromStatus" IS NULL\)/);
  assert.match(audit.AttendanceAuditLog_creation_action_check, /'CREATED_AUTO', 'BACKFILL', 'FINALIZE_ABSENT', 'TEACHER_SET'/);
  assert.match(audit.AttendanceAuditLog_finalize_absent_check, /"toStatus" = 'ABSENT'/);
  assert.match(audit.AttendanceAuditLog_backfill_check, /"toStatus" = 'PRESENT'/);
  // A teacher row names its teacher; a system row names nobody.
  assert.equal(audit.AttendanceAuditLog_actor_id_check, `CHECK (("actorRole" = 'TEACHER') = ("actorId" IS NOT NULL))`);
  // Teacher actions stay teacher-only; every other action is SYSTEM.
  assert.match(audit.AttendanceAuditLog_teacher_action_check, /\("actorRole" = 'TEACHER'\) = \("action" IN \('TEACHER_SET', 'EVIDENCE_ACCEPTED', 'EVIDENCE_DISMISSED'\)\)/);

  const reg = CHECKS.LectureAttendanceRegisterAuditLog;
  assert.match(reg.LectureAttendanceRegisterAuditLog_version_check, /"version" >= 1/);
  assert.match(reg.LectureAttendanceRegisterAuditLog_actor_role_check, /"actorRole" IN \('TEACHER', 'SYSTEM'\)/);
  assert.equal(reg.LectureAttendanceRegisterAuditLog_actor_id_check, `CHECK (("actorRole" = 'TEACHER') = ("actorId" IS NOT NULL))`);
});

test("lock timeout: session-level 5 s at the start, reset at the end; no statement timeout", () => {
  const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean);
  assert.equal(statements[0], "SET lock_timeout = '5s'", "the very first statement");
  assert.equal(statements[statements.length - 1], "RESET lock_timeout", "the very last statement");
  assert.equal((sql.match(/lock_timeout/g) || []).length, 2);
  assert.doesNotMatch(sql, /SET LOCAL/i);
  assert.doesNotMatch(sql, /statement_timeout|idle_in_transaction/i);
  assert.equal((ddl.match(/\b(SET|RESET) [a-z_]+/g) || []).length, 2, "no other session setting");
});

test("register freeze trigger: no UPDATE after finalization, never DELETE or TRUNCATE", () => {
  assert.ok(sql.includes(`CREATE FUNCTION "LectureAttendanceRegister_freeze"() RETURNS trigger LANGUAGE plpgsql AS $$`));
  const body = sql.slice(sql.indexOf(`CREATE FUNCTION "LectureAttendanceRegister_freeze"`), sql.indexOf("$$;", sql.indexOf(`CREATE FUNCTION "LectureAttendanceRegister_freeze"`)));
  assert.match(body, /IF TG_OP IN \('DELETE', 'TRUNCATE'\) THEN RAISE EXCEPTION/);
  assert.match(body, /IF OLD\."finalizedAt" IS NOT NULL THEN RAISE EXCEPTION/);
  assert.ok(body.indexOf("TG_OP IN") < body.indexOf("OLD."), "DELETE / TRUNCATE checked before OLD is read");
  assert.match(body, /RETURN NEW; END;/);
});

test("append-only triggers on scan events and both audit logs (UPDATE, DELETE, TRUNCATE)", () => {
  assert.ok(sql.includes(`CREATE FUNCTION "AttendanceAppendOnly_guard"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP; END; $$;`));
  for (const statement of TRIGGERS) assert.ok(sql.includes(statement), statement);
  assert.equal((sql.match(/CREATE TRIGGER/g) || []).length, TRIGGERS.length);
  assert.equal((sql.match(/CREATE FUNCTION/g) || []).length, 2);
  for (const mutable of ["LectureAttendance\"", "Class\"", "Lecture\""]) {
    assert.doesNotMatch(sql, new RegExp(`CREATE TRIGGER "[^"]+" BEFORE [A-Z ]+ ON "${mutable}`), "records stay updatable");
  }
});

test("no other migration touches the new tables, their constraints, triggers or functions", () => {
  const names = [
    ...NEW_TABLES,
    "attendanceGraceMinutes",
    "Lecture_id_classId_key",
    "AttendanceAppendOnly_guard",
    "LectureAttendanceRegister_freeze",
    ...Object.keys(ENUMS),
  ];
  // The QR closure migration may only reference the register (its foreign
  // key) and reuse the append-only guard function (its triggers); nothing
  // else of this migration, and it never alters or replaces them.
  const allowedReferences = {
    [QR_CLOSURE_MIGRATION]: [
      'REFERENCES "LectureAttendanceRegister"("lectureId", "classId") ON DELETE RESTRICT ON UPDATE CASCADE;',
      'EXECUTE FUNCTION "AttendanceAppendOnly_guard"();',
    ],
  };
  const others = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== MIGRATION)
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(migrationsDir, name, "migration.sql")))
    .filter((name) => {
      let text = read(name);
      for (const allowed of allowedReferences[name] ?? []) text = text.split(allowed).join("");
      return names.some((n) => text.includes(`"${n}`));
    });
  assert.deepEqual(others, []);
  const closure = read(QR_CLOSURE_MIGRATION);
  assert.equal(closure.split(allowedReferences[QR_CLOSURE_MIGRATION][1]).length - 1, 2, "two triggers reuse the guard");
  assert.doesNotMatch(closure, /ALTER TABLE "LectureAttendanceRegister"|CREATE (OR REPLACE )?FUNCTION|DROP /);
});

// ---- schema.prisma consistency ---------------------------------------------------------

test("schema.prisma: the six enums with the same values", () => {
  for (const [name, values] of Object.entries(ENUMS)) {
    const block = modelBlock("enum", name);
    assert.deepEqual(fieldLines(block).filter((l) => !l.startsWith("///")), values, name);
  }
});

test("schema.prisma: the five models, RESTRICT relations, keys and indexes; no timestamp defaults, no @updatedAt", () => {
  const expectations = {
    LectureAttendanceRegister: [
      /^\s*lectureId\s+String\s+@id$/m,
      /lecture\s+Lecture\s+@relation\(fields: \[lectureId, classId\], references: \[id, classId\], onDelete: Restrict\)/,
      /@@unique\(\[lectureId, classId\]\)/,
      /@@index\(\[classId, finalizedAt\]\)/,
    ],
    LectureAttendance: [
      /register\s+LectureAttendanceRegister\s+@relation\(fields: \[lectureId, classId\], references: \[lectureId, classId\], onDelete: Restrict\)/,
      /@@unique\(\[lectureId, studentId\]\)/,
      /@@index\(\[lectureId, pendingReviewSince\]\)/,
    ],
    AttendanceScanEvent: [
      /^\s*eligibilityReason\s+String\?$/m,
      /lecture\s+Lecture\s+@relation\(fields: \[lectureId, classId\], references: \[id, classId\], onDelete: Restrict\)/,
      /@@unique\(\[scannedByTeacherId, clientScanId\]\)/,
    ],
    AttendanceAuditLog: [/visit\s+Attendance\?\s+@relation\(fields: \[attendanceVisitId\], references: \[id\], onDelete: Restrict\)/, /@@unique\(\[lectureAttendanceId, version\]\)/],
    LectureAttendanceRegisterAuditLog: [/@@unique\(\[lectureId, version\]\)/],
  };
  for (const [model, patterns] of Object.entries(expectations)) {
    const block = modelBlock("model", model);
    for (const pattern of patterns) assert.match(block, pattern, `${model}: ${pattern}`);
    assert.doesNotMatch(block, /@default\(now\(\)\)|@updatedAt/, `${model}: no timestamp default`);
    for (const relation of block.matchAll(/@relation\(([^)]*)\)/g)) {
      assert.match(relation[1], /onDelete: Restrict/, `${model}: ${relation[0]}`);
    }
  }
});

test("schema.prisma: Class grace column, Lecture (id, classId) unique; Attendance and StudentConfirmationHistory columns unchanged", () => {
  assert.match(modelBlock("model", "Class"), /^\s*attendanceGraceMinutes\s+Int\s+@default\(10\)$/m);
  assert.match(modelBlock("model", "Lecture"), /^\s*@@unique\(\[id, classId\]\)$/m);

  // Attendance: only a relation list was added; its columns are exactly as before.
  const attendanceScalars = fieldLines(modelBlock("model", "Attendance"))
    .filter((l) => !l.startsWith("///"))
    .map((l) => l.split(/\s+/).slice(0, 2).join(" "))
    .filter((l) => /^(\w+) (String|DateTime)\??$/.test(l));
  assert.deepEqual(attendanceScalars, [
    "id String",
    "studentId String",
    "classId String",
    "joinedAt DateTime",
    "classSessionId String",
    "leftAt DateTime?",
  ]);

  const history = fieldLines(modelBlock("model", "StudentConfirmationHistory")).filter((l) => !l.startsWith("///"));
  assert.deepEqual(
    history.map((l) => l.split(/\s+/)[0]),
    ["id", "studentId", "fromStatus", "toStatus", "decidedAt", "previousConfirmedAt", "decidedByTeacherId", "source", "batchId", "student", "teacher"]
  );
});
