-- ---------------------------------------------------------------------------
-- Teacher storage accounting and quotas (Stage 3.1): the database foundation.
--
-- Additive only: one enum and three NEW tables, their indexes, foreign keys
-- to "Teacher", and CHECK constraints. No existing table, column, index,
-- constraint, trigger, row or file is changed, moved or deleted, and nothing
-- is backfilled: a teacher without a "TeacherStorageLimit" row simply uses
-- the subscription plan's storageGB (NULL = unlimited).
--
--   "TeacherStorageLimit"        the admin's individual override (one row per teacher)
--   "TeacherStorageLimitChange"  append-only audit of override changes
--   "StorageReservation"         in-flight Notes / submission upload capacity
--                                (Recorded Lectures reserve through their
--                                ACTIVE / COMPLETING upload sessions, never here)
--
-- Parts marked MANUAL are hand-written; the rest is exactly what
-- `prisma migrate diff` generates for the schema change. Guarded by
-- tests/storage-quota/migration-guard.test.cjs.
-- ---------------------------------------------------------------------------

-- MANUAL: give up after 5 s instead of queueing behind a long transaction
-- (the foreign keys lock "Teacher" briefly); the migration can be re-run.
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "StorageReservationCategory" AS ENUM ('NOTE', 'SUBMISSION');

-- CreateTable
CREATE TABLE "TeacherStorageLimit" (
    "teacherId" TEXT NOT NULL,
    "limitBytes" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByAdminId" VARCHAR(191) NOT NULL,
    "updatedByAdminEmail" VARCHAR(320) NOT NULL,

    CONSTRAINT "TeacherStorageLimit_pkey" PRIMARY KEY ("teacherId")
);

-- CreateTable
CREATE TABLE "TeacherStorageLimitChange" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "previousLimitBytes" BIGINT,
    "newLimitBytes" BIGINT,
    "planLimitBytes" BIGINT,
    "changedByAdminId" VARCHAR(191) NOT NULL,
    "changedByAdminEmail" VARCHAR(320) NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherStorageLimitChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageReservation" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "category" "StorageReservationCategory" NOT NULL,
    "bytes" BIGINT NOT NULL,
    "storageKey" VARCHAR(512) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeacherStorageLimitChange_teacherId_changedAt_idx" ON "TeacherStorageLimitChange"("teacherId", "changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StorageReservation_storageKey_key" ON "StorageReservation"("storageKey");

-- CreateIndex
CREATE INDEX "StorageReservation_teacherId_expiresAt_idx" ON "StorageReservation"("teacherId", "expiresAt");

-- CreateIndex
CREATE INDEX "StorageReservation_expiresAt_idx" ON "StorageReservation"("expiresAt");

-- AddForeignKey
ALTER TABLE "TeacherStorageLimit" ADD CONSTRAINT "TeacherStorageLimit_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TeacherStorageLimitChange" ADD CONSTRAINT "TeacherStorageLimitChange_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StorageReservation" ADD CONSTRAINT "StorageReservation_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- MANUAL: CHECK constraints. (A CHECK whose expression is NULL passes, so the
-- nullable audit columns accept NULL = "no override" / "unlimited".)
--   Limits: 0 .. 10^15 bytes (1 PB). 0 is a real limit (nothing may be
--   stored), never "unlimited"; unlimited is the ABSENCE of a limit.
ALTER TABLE "TeacherStorageLimit"
  ADD CONSTRAINT "TeacherStorageLimit_limitBytes_range"
    CHECK ("limitBytes" >= 0 AND "limitBytes" <= 1000000000000000);

ALTER TABLE "TeacherStorageLimitChange"
  ADD CONSTRAINT "TeacherStorageLimitChange_bytes_range"
    CHECK (
      ("previousLimitBytes" >= 0 AND "previousLimitBytes" <= 1000000000000000)
      AND ("newLimitBytes" >= 0 AND "newLimitBytes" <= 1000000000000000)
      AND ("planLimitBytes" >= 0 AND "planLimitBytes" <= 1000000000000000)
    );

--   Reservations: 1 .. 2,147,483,647 bytes (the Int range of
--   Note / AssignmentSubmission.sizeBytes, the rows they become); expiry
--   after creation; the key is exactly the category's key layout
--   (lib/notes/storage-keys.ts, lib/assignments/submission-keys.ts, the same
--   patterns as Note_storageKey_format / AssignmentSubmission_storageKey_format)
--   AND lies below the reserving teacher's own Teachers/{teacherId}/ folder.
ALTER TABLE "StorageReservation"
  ADD CONSTRAINT "StorageReservation_bytes_range"
    CHECK ("bytes" >= 1 AND "bytes" <= 2147483647),
  ADD CONSTRAINT "StorageReservation_expiry_after_creation"
    CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "StorageReservation_storageKey_format"
    CHECK (
      ("category" = 'NOTE' AND "storageKey" ~ '^Teachers/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Lectures/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Notes/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/[0-9a-f]{32}\.(pdf|png|jpg|webp|docx|doc|pptx|ppt|xlsx|xls|txt|zip)$')
      OR ("category" = 'SUBMISSION' AND "storageKey" ~ '^Teachers/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Lectures/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Assignments/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/Submissions/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/[0-9a-f]{32}\.pdf$')
    ),
  ADD CONSTRAINT "StorageReservation_storageKey_owner"
    CHECK (left("storageKey", length('Teachers/' || "teacherId" || '/')) = 'Teachers/' || "teacherId" || '/');

-- MANUAL: restore the default lock timeout for the rest of the session.
RESET lock_timeout;
