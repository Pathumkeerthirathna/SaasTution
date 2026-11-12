-- ---------------------------------------------------------------------------
-- Unified lecture attendance: database foundation (see docs/lecture-attendance.md).
--
-- Six enums, five tables (register, canonical record, scan events, record
-- audit log, register audit log), their indexes and foreign keys, plus:
--   * "Class"."attendanceGraceMinutes" (NOT NULL DEFAULT 10, constant default:
--     no table rewrite) with a 0-240 CHECK;
--   * a unique index on "Lecture" ("id", "classId"), the target of the
--     composite (lectureId, classId) foreign keys.
-- No existing column, row or migration is changed; "Attendance" and
-- "StudentConfirmationHistory" are not touched. Nothing is backfilled.
--
-- Timestamps have no database default: the application writes real UTC
-- instants. Every foreign key is ON DELETE RESTRICT.
--
-- Parts marked MANUAL are hand-written (CHECK constraints, the register
-- freeze trigger and the append-only triggers). Apply with
-- `prisma migrate deploy` over the direct (non-pooled) connection only, never
-- `prisma db push`. Guarded by
-- tests/attendance/lecture-attendance-migration-guard.test.cjs.
-- ---------------------------------------------------------------------------

-- MANUAL: fail instead of waiting indefinitely for a lock (e.g. behind a long
-- transaction on "Class", "Lecture" or "Attendance"), which would also queue
-- every later query on that table behind this migration. Each single lock
-- wait is limited to 5 seconds; there is no overall statement timeout.
-- Session-level SET (not SET LOCAL): it works whether Prisma runs this script
-- as one implicit transaction or statement by statement, and RESET at the
-- end restores the default for the rest of Prisma's session. If the script
-- fails inside a transaction, the SET is rolled back with it.
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "LectureAttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED');

-- CreateEnum
CREATE TYPE "AttendanceStatusSource" AS ENUM ('AUTO', 'TEACHER', 'FINALIZATION', 'BACKFILL');

-- CreateEnum
CREATE TYPE "AttendanceScanResult" AS ENUM ('VALID', 'INVALID_QR', 'QR_UNVERIFIABLE', 'WRONG_TEACHER', 'NOT_ELIGIBLE', 'ELIGIBILITY_UNKNOWN', 'LECTURE_UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AttendanceScanEffect" AS ENUM ('STATUS_UPDATED', 'EVIDENCE_ONLY', 'REVIEW_REQUIRED', 'DUPLICATE', 'RECORDED_ONLY', 'NONE');

-- CreateEnum
CREATE TYPE "AttendanceAuditAction" AS ENUM ('CREATED_AUTO', 'AUTO_UPDATED', 'AUTO_RECALCULATED', 'EVIDENCE_RECORDED', 'TEACHER_SET', 'EVIDENCE_ACCEPTED', 'EVIDENCE_DISMISSED', 'FINALIZE_ABSENT', 'BACKFILL');

-- CreateEnum
CREATE TYPE "RegisterAuditAction" AS ENUM ('CREATED', 'GRACE_CHANGED', 'SCHEDULE_SYNCED', 'FINALIZED');

-- AlterTable
ALTER TABLE "Class" ADD COLUMN     "attendanceGraceMinutes" INTEGER NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE "LectureAttendanceRegister" (
    "lectureId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "scheduledStartAt" TIMESTAMP(3) NOT NULL,
    "scheduledEndAt" TIMESTAMP(3),
    "graceMinutes" INTEGER NOT NULL,
    "finalizedAt" TIMESTAMP(3),
    "finalizedByTeacherId" TEXT,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LectureAttendanceRegister_pkey" PRIMARY KEY ("lectureId")
);

-- CreateTable
CREATE TABLE "LectureAttendance" (
    "id" TEXT NOT NULL,
    "lectureId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "status" "LectureAttendanceStatus" NOT NULL,
    "statusSource" "AttendanceStatusSource" NOT NULL,
    "firstOnlineAt" TIMESTAMP(3),
    "firstQrAt" TIMESTAMP(3),
    "autoStatus" "LectureAttendanceStatus",
    "teacherStatus" "LectureAttendanceStatus",
    "teacherDecidedAt" TIMESTAMP(3),
    "teacherDecidedById" TEXT,
    "pendingReviewSince" TIMESTAMP(3),
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LectureAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceScanEvent" (
    "id" TEXT NOT NULL,
    "lectureId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "classSessionId" TEXT,
    "scannedByTeacherId" TEXT NOT NULL,
    "clientScanId" TEXT NOT NULL,
    "scannedTokenHash" TEXT,
    "qrTokenId" TEXT,
    "studentId" TEXT,
    "result" "AttendanceScanResult" NOT NULL,
    "effect" "AttendanceScanEffect" NOT NULL,
    "eligibilityReason" TEXT,
    "afterFinalization" BOOLEAN NOT NULL,
    "lectureAttendanceId" TEXT,
    "clientScannedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceScanEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceAuditLog" (
    "id" TEXT NOT NULL,
    "lectureAttendanceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "lectureId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "action" "AttendanceAuditAction" NOT NULL,
    "fromStatus" "LectureAttendanceStatus",
    "toStatus" "LectureAttendanceStatus" NOT NULL,
    "fromTeacherStatus" "LectureAttendanceStatus",
    "toTeacherStatus" "LectureAttendanceStatus",
    "fromAutoStatus" "LectureAttendanceStatus",
    "toAutoStatus" "LectureAttendanceStatus",
    "actorRole" TEXT NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "afterFinalization" BOOLEAN NOT NULL,
    "scanEventId" TEXT,
    "attendanceVisitId" TEXT,
    "registerAuditId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LectureAttendanceRegisterAuditLog" (
    "id" TEXT NOT NULL,
    "lectureId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "action" "RegisterAuditAction" NOT NULL,
    "fromGraceMinutes" INTEGER,
    "toGraceMinutes" INTEGER,
    "fromScheduledStartAt" TIMESTAMP(3),
    "toScheduledStartAt" TIMESTAMP(3),
    "fromScheduledEndAt" TIMESTAMP(3),
    "toScheduledEndAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "eligibleCount" INTEGER,
    "unknownEligibilityCount" INTEGER,
    "absentCreatedCount" INTEGER,
    "recalculatedCount" INTEGER,
    "actorRole" TEXT NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LectureAttendanceRegisterAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LectureAttendanceRegister_classId_finalizedAt_idx" ON "LectureAttendanceRegister"("classId", "finalizedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LectureAttendanceRegister_lectureId_classId_key" ON "LectureAttendanceRegister"("lectureId", "classId");

-- CreateIndex
CREATE INDEX "LectureAttendance_classId_studentId_idx" ON "LectureAttendance"("classId", "studentId");

-- CreateIndex
CREATE INDEX "LectureAttendance_studentId_lectureId_idx" ON "LectureAttendance"("studentId", "lectureId");

-- CreateIndex
CREATE INDEX "LectureAttendance_lectureId_status_idx" ON "LectureAttendance"("lectureId", "status");

-- CreateIndex
CREATE INDEX "LectureAttendance_lectureId_pendingReviewSince_idx" ON "LectureAttendance"("lectureId", "pendingReviewSince");

-- CreateIndex
CREATE UNIQUE INDEX "LectureAttendance_lectureId_studentId_key" ON "LectureAttendance"("lectureId", "studentId");

-- CreateIndex
CREATE INDEX "AttendanceScanEvent_lectureId_receivedAt_idx" ON "AttendanceScanEvent"("lectureId", "receivedAt");

-- CreateIndex
CREATE INDEX "AttendanceScanEvent_studentId_lectureId_receivedAt_idx" ON "AttendanceScanEvent"("studentId", "lectureId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceScanEvent_scannedByTeacherId_clientScanId_key" ON "AttendanceScanEvent"("scannedByTeacherId", "clientScanId");

-- CreateIndex
CREATE INDEX "AttendanceAuditLog_lectureId_createdAt_idx" ON "AttendanceAuditLog"("lectureId", "createdAt");

-- CreateIndex
CREATE INDEX "AttendanceAuditLog_studentId_createdAt_idx" ON "AttendanceAuditLog"("studentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceAuditLog_lectureAttendanceId_version_key" ON "AttendanceAuditLog"("lectureAttendanceId", "version");

-- CreateIndex
CREATE INDEX "LectureAttendanceRegisterAuditLog_lectureId_createdAt_idx" ON "LectureAttendanceRegisterAuditLog"("lectureId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LectureAttendanceRegisterAuditLog_lectureId_version_key" ON "LectureAttendanceRegisterAuditLog"("lectureId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Lecture_id_classId_key" ON "Lecture"("id", "classId");

-- AddForeignKey
ALTER TABLE "LectureAttendanceRegister" ADD CONSTRAINT "LectureAttendanceRegister_lectureId_classId_fkey" FOREIGN KEY ("lectureId", "classId") REFERENCES "Lecture"("id", "classId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LectureAttendanceRegister" ADD CONSTRAINT "LectureAttendanceRegister_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LectureAttendanceRegister" ADD CONSTRAINT "LectureAttendanceRegister_finalizedByTeacherId_fkey" FOREIGN KEY ("finalizedByTeacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_lectureId_classId_fkey" FOREIGN KEY ("lectureId", "classId") REFERENCES "LectureAttendanceRegister"("lectureId", "classId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_teacherDecidedById_fkey" FOREIGN KEY ("teacherDecidedById") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceScanEvent" ADD CONSTRAINT "AttendanceScanEvent_lectureId_classId_fkey" FOREIGN KEY ("lectureId", "classId") REFERENCES "Lecture"("id", "classId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceScanEvent" ADD CONSTRAINT "AttendanceScanEvent_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "ClassSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceScanEvent" ADD CONSTRAINT "AttendanceScanEvent_scannedByTeacherId_fkey" FOREIGN KEY ("scannedByTeacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceScanEvent" ADD CONSTRAINT "AttendanceScanEvent_qrTokenId_fkey" FOREIGN KEY ("qrTokenId") REFERENCES "StudentQrToken"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceScanEvent" ADD CONSTRAINT "AttendanceScanEvent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceScanEvent" ADD CONSTRAINT "AttendanceScanEvent_lectureAttendanceId_fkey" FOREIGN KEY ("lectureAttendanceId") REFERENCES "LectureAttendance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceAuditLog" ADD CONSTRAINT "AttendanceAuditLog_lectureAttendanceId_fkey" FOREIGN KEY ("lectureAttendanceId") REFERENCES "LectureAttendance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceAuditLog" ADD CONSTRAINT "AttendanceAuditLog_scanEventId_fkey" FOREIGN KEY ("scanEventId") REFERENCES "AttendanceScanEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceAuditLog" ADD CONSTRAINT "AttendanceAuditLog_attendanceVisitId_fkey" FOREIGN KEY ("attendanceVisitId") REFERENCES "Attendance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceAuditLog" ADD CONSTRAINT "AttendanceAuditLog_registerAuditId_fkey" FOREIGN KEY ("registerAuditId") REFERENCES "LectureAttendanceRegisterAuditLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LectureAttendanceRegisterAuditLog" ADD CONSTRAINT "LectureAttendanceRegisterAuditLog_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "LectureAttendanceRegister"("lectureId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- MANUAL: everything below is hand-written (Prisma 5.22 cannot express CHECK
-- constraints or triggers and ignores them, so they are never reported as
-- drift, and `prisma db push` would NOT create them).
-- ===========================================================================

-- MANUAL: Class grace period, 0 to 240 minutes.
ALTER TABLE "Class" ADD CONSTRAINT "Class_attendanceGraceMinutes_check"
  CHECK ("attendanceGraceMinutes" BETWEEN 0 AND 240);

-- MANUAL: LectureAttendanceRegister.
ALTER TABLE "LectureAttendanceRegister" ADD CONSTRAINT "LectureAttendanceRegister_graceMinutes_check"
  CHECK ("graceMinutes" BETWEEN 0 AND 240);
ALTER TABLE "LectureAttendanceRegister" ADD CONSTRAINT "LectureAttendanceRegister_schedule_check"
  CHECK ("scheduledEndAt" IS NULL OR "scheduledEndAt" > "scheduledStartAt");
ALTER TABLE "LectureAttendanceRegister" ADD CONSTRAINT "LectureAttendanceRegister_finalized_check"
  CHECK (("finalizedAt" IS NULL) = ("finalizedByTeacherId" IS NULL));
ALTER TABLE "LectureAttendanceRegister" ADD CONSTRAINT "LectureAttendanceRegister_version_check"
  CHECK ("version" >= 1);

-- MANUAL: LectureAttendance.
-- A teacher decision is the effective status.
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_teacher_status_check"
  CHECK ("teacherStatus" IS NULL OR "status" = "teacherStatus");
-- Evidence only ever yields PRESENT or LATE.
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_auto_status_check"
  CHECK ("autoStatus" IS NULL OR "autoStatus" IN ('PRESENT', 'LATE'));
-- autoStatus exists exactly when there is online or QR evidence.
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_evidence_check"
  CHECK (("autoStatus" IS NULL) = ("firstOnlineAt" IS NULL AND "firstQrAt" IS NULL));
-- A teacher decision always records when and by whom.
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_teacher_decision_check"
  CHECK (
    ("teacherStatus" IS NULL) = ("teacherDecidedAt" IS NULL)
    AND ("teacherStatus" IS NULL) = ("teacherDecidedById" IS NULL)
  );
-- The source matches the status.
-- Source TEACHER exactly when there is a teacher decision (a teacher decision
-- always wins, so a decided record is never shown as AUTO / FINALIZATION /
-- BACKFILL).
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_source_teacher_check"
  CHECK (("statusSource" = 'TEACHER') = ("teacherStatus" IS NOT NULL));
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_source_finalization_check"
  CHECK ("statusSource" <> 'FINALIZATION' OR "status" = 'ABSENT');
-- An AUTO status always rests on evidence and is PRESENT or LATE. It is not
-- required to EQUAL autoStatus: after finalization, later evidence (e.g. an
-- earlier online visit added by reconciliation) updates autoStatus and raises
-- a review, but the status itself is never changed automatically. Written
-- with IS NOT NULL: a CHECK whose expression is NULL passes.
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_source_auto_check"
  CHECK ("statusSource" <> 'AUTO' OR ("autoStatus" IS NOT NULL AND "status" IN ('PRESENT', 'LATE')));
-- Backfilled rows are PRESENT only (never retroactive LATE).
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_source_backfill_check"
  CHECK ("statusSource" <> 'BACKFILL' OR "status" = 'PRESENT');
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_version_check"
  CHECK ("version" >= 1);

-- MANUAL: AttendanceScanEvent.
-- A scan is linked to a record exactly when it affected (or was counted against) one.
ALTER TABLE "AttendanceScanEvent" ADD CONSTRAINT "AttendanceScanEvent_record_link_check"
  CHECK (("effect" IN ('STATUS_UPDATED', 'EVIDENCE_ONLY', 'REVIEW_REQUIRED', 'DUPLICATE')) = ("lectureAttendanceId" IS NOT NULL));
-- Only a valid scan has an effect.
ALTER TABLE "AttendanceScanEvent" ADD CONSTRAINT "AttendanceScanEvent_effect_check"
  CHECK (("result" = 'VALID') = ("effect" <> 'NONE'));
-- Scans of the teacher's own students keep the identity, including rejected
-- ones: student, token row and the scanned token's hash.
ALTER TABLE "AttendanceScanEvent" ADD CONSTRAINT "AttendanceScanEvent_identity_check"
  CHECK (
    "result" NOT IN ('VALID', 'NOT_ELIGIBLE', 'ELIGIBILITY_UNKNOWN')
    OR ("studentId" IS NOT NULL AND "qrTokenId" IS NOT NULL AND "scannedTokenHash" IS NOT NULL)
  );
-- Another teacher's student is never identified: no student, token or hash.
ALTER TABLE "AttendanceScanEvent" ADD CONSTRAINT "AttendanceScanEvent_wrong_teacher_check"
  CHECK ("result" <> 'WRONG_TEACHER' OR ("studentId" IS NULL AND "qrTokenId" IS NULL AND "scannedTokenHash" IS NULL));
-- SHA-256 hex digest only (never a raw token).
ALTER TABLE "AttendanceScanEvent" ADD CONSTRAINT "AttendanceScanEvent_token_hash_check"
  CHECK ("scannedTokenHash" IS NULL OR "scannedTokenHash" ~ '^[0-9a-f]{64}$');
-- The approvalAt reasons (lib/student-confirmation-history.ts).
-- Eligibility reasons match the result. approvalAt gives APPROVED only with
-- KNOWN_APPROVED / APPROVED_AT_EVIDENCE, and UNKNOWN only with
-- BEFORE_APPROVAL_FEATURE / BEFORE_RECORDED_DECISIONS / APPROVED_AT_CONFLICT /
-- BROKEN_HISTORY. NOT_ELIGIBLE is not restricted: an approved student who is
-- not enrolled at the scan time is NOT_ELIGIBLE with an approved reason.
-- (IS NOT NULL is explicit: a CHECK whose expression is NULL passes.)
ALTER TABLE "AttendanceScanEvent" ADD CONSTRAINT "AttendanceScanEvent_valid_reason_check"
  CHECK (
    "result" <> 'VALID'
    OR ("eligibilityReason" IS NOT NULL AND "eligibilityReason" IN ('KNOWN_APPROVED', 'APPROVED_AT_EVIDENCE'))
  );
ALTER TABLE "AttendanceScanEvent" ADD CONSTRAINT "AttendanceScanEvent_unknown_reason_check"
  CHECK (
    "result" <> 'ELIGIBILITY_UNKNOWN'
    OR (
      "eligibilityReason" IS NOT NULL
      AND "eligibilityReason" IN ('BEFORE_APPROVAL_FEATURE', 'BEFORE_RECORDED_DECISIONS', 'APPROVED_AT_CONFLICT', 'BROKEN_HISTORY')
    )
  );
-- No eligibility was evaluated without an identified student.
ALTER TABLE "AttendanceScanEvent" ADD CONSTRAINT "AttendanceScanEvent_reason_identity_check"
  CHECK ("studentId" IS NOT NULL OR "eligibilityReason" IS NULL);
ALTER TABLE "AttendanceScanEvent" ADD CONSTRAINT "AttendanceScanEvent_eligibility_reason_check"
  CHECK (
    "eligibilityReason" IS NULL
    OR "eligibilityReason" IN (
      'KNOWN_APPROVED',
      'APPROVED_AT_EVIDENCE',
      'KNOWN_NOT_APPROVED',
      'BEFORE_APPROVAL_FEATURE',
      'BEFORE_RECORDED_DECISIONS',
      'APPROVED_AT_CONFLICT',
      'BROKEN_HISTORY'
    )
  );

-- MANUAL: AttendanceAuditLog.
ALTER TABLE "AttendanceAuditLog" ADD CONSTRAINT "AttendanceAuditLog_actor_role_check"
  CHECK ("actorRole" IN ('TEACHER', 'SYSTEM'));
-- Teacher actions are exactly the ones a teacher performs.
ALTER TABLE "AttendanceAuditLog" ADD CONSTRAINT "AttendanceAuditLog_teacher_action_check"
  CHECK (("actorRole" = 'TEACHER') = ("action" IN ('TEACHER_SET', 'EVIDENCE_ACCEPTED', 'EVIDENCE_DISMISSED')));
-- A teacher row names its teacher; a system row names nobody.
ALTER TABLE "AttendanceAuditLog" ADD CONSTRAINT "AttendanceAuditLog_actor_id_check"
  CHECK (("actorRole" = 'TEACHER') = ("actorId" IS NOT NULL));
ALTER TABLE "AttendanceAuditLog" ADD CONSTRAINT "AttendanceAuditLog_version_check"
  CHECK ("version" >= 1);
-- Version 1 is the record's creation: exactly then there is no previous
-- status (a record's status is never NULL), and no previous teacher or
-- evidence status either. Every later version has a previous status.
ALTER TABLE "AttendanceAuditLog" ADD CONSTRAINT "AttendanceAuditLog_creation_check"
  CHECK (
    ("version" = 1) = ("fromStatus" IS NULL)
    AND ("version" <> 1 OR ("fromTeacherStatus" IS NULL AND "fromAutoStatus" IS NULL))
  );
-- CREATED_AUTO, BACKFILL and FINALIZE_ABSENT only ever create a record;
-- a creation is one of those or a teacher's first manual mark (TEACHER_SET).
-- Every other action changes an existing record.
ALTER TABLE "AttendanceAuditLog" ADD CONSTRAINT "AttendanceAuditLog_creation_action_check"
  CHECK (
    ("action" NOT IN ('CREATED_AUTO', 'BACKFILL', 'FINALIZE_ABSENT') OR "version" = 1)
    AND ("version" <> 1 OR "action" IN ('CREATED_AUTO', 'BACKFILL', 'FINALIZE_ABSENT', 'TEACHER_SET'))
  );
ALTER TABLE "AttendanceAuditLog" ADD CONSTRAINT "AttendanceAuditLog_finalize_absent_check"
  CHECK ("action" <> 'FINALIZE_ABSENT' OR "toStatus" = 'ABSENT');
-- Backfill creates PRESENT only (never retroactive LATE).
ALTER TABLE "AttendanceAuditLog" ADD CONSTRAINT "AttendanceAuditLog_backfill_check"
  CHECK ("action" <> 'BACKFILL' OR "toStatus" = 'PRESENT');
-- A reason is required when a teacher overrides an existing status, or after
-- finalization; the first manual mark needs none.
ALTER TABLE "AttendanceAuditLog" ADD CONSTRAINT "AttendanceAuditLog_reason_check"
  CHECK (
    NOT ("action" IN ('TEACHER_SET', 'EVIDENCE_ACCEPTED') AND ("fromStatus" IS NOT NULL OR "afterFinalization"))
    OR "reason" IS NOT NULL
  );

-- MANUAL: LectureAttendanceRegisterAuditLog.
ALTER TABLE "LectureAttendanceRegisterAuditLog" ADD CONSTRAINT "LectureAttendanceRegisterAuditLog_version_check"
  CHECK ("version" >= 1);
ALTER TABLE "LectureAttendanceRegisterAuditLog" ADD CONSTRAINT "LectureAttendanceRegisterAuditLog_actor_role_check"
  CHECK ("actorRole" IN ('TEACHER', 'SYSTEM'));
-- A teacher row names its teacher; a system row names nobody.
ALTER TABLE "LectureAttendanceRegisterAuditLog" ADD CONSTRAINT "LectureAttendanceRegisterAuditLog_actor_id_check"
  CHECK (("actorRole" = 'TEACHER') = ("actorId" IS NOT NULL));
ALTER TABLE "LectureAttendanceRegisterAuditLog" ADD CONSTRAINT "LectureAttendanceRegisterAuditLog_created_check"
  CHECK (
    "action" <> 'CREATED'
    OR ("version" = 1 AND "fromGraceMinutes" IS NULL AND "fromScheduledStartAt" IS NULL AND "fromScheduledEndAt" IS NULL)
  );
ALTER TABLE "LectureAttendanceRegisterAuditLog" ADD CONSTRAINT "LectureAttendanceRegisterAuditLog_grace_changed_check"
  CHECK (
    "action" <> 'GRACE_CHANGED'
    OR ("fromGraceMinutes" IS NOT NULL AND "toGraceMinutes" IS NOT NULL AND "fromGraceMinutes" <> "toGraceMinutes")
  );
ALTER TABLE "LectureAttendanceRegisterAuditLog" ADD CONSTRAINT "LectureAttendanceRegisterAuditLog_schedule_synced_check"
  CHECK (
    "action" <> 'SCHEDULE_SYNCED'
    OR "fromScheduledStartAt" IS DISTINCT FROM "toScheduledStartAt"
    OR "fromScheduledEndAt" IS DISTINCT FROM "toScheduledEndAt"
  );
ALTER TABLE "LectureAttendanceRegisterAuditLog" ADD CONSTRAINT "LectureAttendanceRegisterAuditLog_finalized_check"
  CHECK (
    "action" <> 'FINALIZED'
    OR (
      "finalizedAt" IS NOT NULL
      AND "eligibleCount" IS NOT NULL
      AND "unknownEligibilityCount" IS NOT NULL
      AND "absentCreatedCount" IS NOT NULL
      AND "actorId" IS NOT NULL
    )
  );

-- MANUAL: register freeze. A finalized register never changes (it cannot be
-- reopened in v1, and keeps the schedule attendance was judged against); a
-- register is never deleted.
CREATE FUNCTION "LectureAttendanceRegister_freeze"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Checked first: a statement-level TRUNCATE trigger has no OLD row.
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'LectureAttendanceRegister rows cannot be deleted (% refused)', TG_OP;
  END IF;
  IF OLD."finalizedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'LectureAttendanceRegister is finalized and cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "LectureAttendanceRegister_freeze"
  BEFORE UPDATE OR DELETE ON "LectureAttendanceRegister"
  FOR EACH ROW EXECUTE FUNCTION "LectureAttendanceRegister_freeze"();

CREATE TRIGGER "LectureAttendanceRegister_no_truncate"
  BEFORE TRUNCATE ON "LectureAttendanceRegister"
  FOR EACH STATEMENT EXECUTE FUNCTION "LectureAttendanceRegister_freeze"();

-- MANUAL: append-only. Scan events and both audit logs can be inserted, never
-- changed or removed.
CREATE FUNCTION "AttendanceAppendOnly_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE TRIGGER "AttendanceScanEvent_no_update_delete"
  BEFORE UPDATE OR DELETE ON "AttendanceScanEvent"
  FOR EACH ROW EXECUTE FUNCTION "AttendanceAppendOnly_guard"();
CREATE TRIGGER "AttendanceScanEvent_no_truncate"
  BEFORE TRUNCATE ON "AttendanceScanEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "AttendanceAppendOnly_guard"();

CREATE TRIGGER "AttendanceAuditLog_no_update_delete"
  BEFORE UPDATE OR DELETE ON "AttendanceAuditLog"
  FOR EACH ROW EXECUTE FUNCTION "AttendanceAppendOnly_guard"();
CREATE TRIGGER "AttendanceAuditLog_no_truncate"
  BEFORE TRUNCATE ON "AttendanceAuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION "AttendanceAppendOnly_guard"();

CREATE TRIGGER "LectureAttendanceRegisterAuditLog_no_update_delete"
  BEFORE UPDATE OR DELETE ON "LectureAttendanceRegisterAuditLog"
  FOR EACH ROW EXECUTE FUNCTION "AttendanceAppendOnly_guard"();
CREATE TRIGGER "LectureAttendanceRegisterAuditLog_no_truncate"
  BEFORE TRUNCATE ON "LectureAttendanceRegisterAuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION "AttendanceAppendOnly_guard"();

-- MANUAL: restore the default lock timeout for the rest of the session.
RESET lock_timeout;
